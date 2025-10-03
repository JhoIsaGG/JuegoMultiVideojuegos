// server.js
const WebSocket = require("ws");

// --------- OPCIONES ---------
// Si true: la PRIMERA IP que entra queda "baneada" para siempre (memoria) y no podrá reconectar.
// Si false: solo se permite UNA conexión simultánea por IP (si se desconecta, la IP podrá volver a entrar).
const PERMANENT_BLOCK_PER_IP = false;

// Límite básico de mensajes entrantes por segundo por socket (anti-spam).
const MAX_MSGS_PER_SEC = 40;

// Intervalo de heartbeat (ping/pong) para limpiar clientes caídos.
const HEARTBEAT_MS = 15000;

// ----------------------------

const server = new WebSocket.Server({
  port: 8080,
  // perMessageDeflate consume CPU; lo dejamos desactivado para juego local
  perMessageDeflate: false,
});

// ---- Utilidades / Estado ----
/**
 * players = {
 *   [id]: { x, y, character, hp, lives, lastAttackAt }
 * }
 */
let players = {};
const ARENA = { width: 1935, height: 1300, padding: 200 };
const MOVE_CLAMP = (v, min, max) => Math.max(min, Math.min(max, v));
const ATTACK_RANGE = 50;
const ATTACK_COOLDOWN_MS = 500;
const DMG = 15;

// IPs que ya se conectaron (bloqueo permanente si PERMANENT_BLOCK_PER_IP = true)
const seenIPs = new Set();

// IP -> socket activo (modo “una sesión por IP” si PERMANENT_BLOCK_PER_IP = false)
const activeIPMap = new Map();

// Heartbeat helpers
function heartbeat() { this.isAlive = true; }

function getClientIP(req, socket) {
  // Intenta honrar proxy si existiera (X-Forwarded-For), toma el primer valor
  const xfwd = req.headers["x-forwarded-for"];
  let ip =
    (xfwd && xfwd.split(",")[0].trim()) ||
    req.socket?.remoteAddress ||
    socket?._socket?.remoteAddress ||
    "unknown";

  // Normaliza IPv6-compat ::ffff:127.0.0.1
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

function denyAndClose(socket, reason = "IP already connected", code = 4001) {
  try {
    socket.send(JSON.stringify({ type: "error", code, reason }));
  } catch {}
  try {
    socket.close(code, reason);
  } catch {}
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  server.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}

// ---- Servidor ----
server.on("connection", (socket, req) => {
  // Rate limit sencillo por socket
  socket._msgCount = 0;
  socket._lastTick = Date.now();

  // Heartbeat
  socket.isAlive = true;
  socket.on("pong", heartbeat);

  const ip = getClientIP(req, socket);

  // Regla de negocio solicitada: 1) guardar IP 2) bloquear reingreso
  if (PERMANENT_BLOCK_PER_IP) {
    if (seenIPs.has(ip)) {
      console.log(`Rechazado: IP repetida (permanente) ${ip}`);
      return denyAndClose(socket, "IP bloqueada permanentemente (ya ingresó antes)", 4001);
    }
    // Primer ingreso: guardar IP
    seenIPs.add(ip);
  } else {
    // Solo una sesión simultánea por IP
    if (activeIPMap.has(ip)) {
      console.log(`Rechazado: ya hay una sesión activa desde IP ${ip}`);
      return denyAndClose(socket, "Ya existe una sesión activa desde tu IP", 4002);
    }
    activeIPMap.set(ip, socket);
  }

  console.log(`Nuevo jugador conectado desde ${ip}`);

  // ID único por conexión
  const playerId = Date.now().toString();
  socket.playerId = playerId;
  socket.playerIP = ip;

  // Posición inicial aleatoria dentro del área
  const startX = Math.floor(
    Math.random() * (ARENA.width - ARENA.padding * 2) + ARENA.padding
  );
  const startY = Math.floor(
    Math.random() * (ARENA.height - ARENA.padding * 2) + ARENA.padding
  );

  players[playerId] = {
    x: startX,
    y: startY,
    character: null,
    hp: 100,
    lives: 2,       // dos vidas por jugador
    lastAttackAt: 0,
  };

  // Enviar estado inicial SOLO al nuevo jugador
  socket.send(
    JSON.stringify({ type: "init", id: playerId, players, arena: ARENA })
  );

  socket.on("message", (msg) => {
    // ---- Rate limiting por socket ----
    const now = Date.now();
    if (now - socket._lastTick >= 1000) {
      socket._msgCount = 0;
      socket._lastTick = now;
    }
    socket._msgCount++;
    if (socket._msgCount > MAX_MSGS_PER_SEC) {
      console.warn(`Socket ${playerId} excedió rate limit. Cerrando.`);
      return denyAndClose(socket, "Rate limit excedido", 4003);
    }
    // ----------------------------------

    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    // Selección de personaje
    if (data.type === "select") {
      const chosen = (data.character || "").toString();
      players[playerId].character = chosen || "knight";

      // Notificar a todos que apareció un nuevo jugador con su personaje
      broadcast({
        type: "spawn",
        id: playerId,
        state: players[playerId],
      });
      return;
    }

    // Movimiento (con clamp en servidor para evitar "salirse")
    if (data.type === "move" && data.position && players[playerId]) {
      const p = players[playerId];
      // Sanitiza números
      const rx = Number(data.position.x);
      const ry = Number(data.position.y);
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) return;

      p.x = MOVE_CLAMP(rx, ARENA.padding, ARENA.width - ARENA.padding);
      p.y = MOVE_CLAMP(ry, ARENA.padding, ARENA.height - ARENA.padding);

      broadcast({
        type: "update",
        id: playerId,
        position: { x: p.x, y: p.y },
      });
      return;
    }

    // Ataque: aplicar daño a jugadores dentro del rango con cooldown simple
    if (data.type === "attack" && players[playerId]) {
      const now = Date.now();
      const attacker = players[playerId];
      if (now - (attacker.lastAttackAt || 0) < ATTACK_COOLDOWN_MS) return;
      attacker.lastAttackAt = now;

      Object.keys(players).forEach((otherId) => {
        if (otherId === playerId) return;
        const target = players[otherId];
        if (!target) return;

        const dx = attacker.x - target.x;
        const dy = attacker.y - target.y;
        const dist = Math.hypot(dx, dy);

        if (dist <= ATTACK_RANGE) {
          target.hp = Math.max(0, (target.hp || 100) - DMG);
          broadcast({ type: "damage", id: otherId, hp: target.hp });

          if (target.hp <= 0) {
            target.lives = Math.max(0, (target.lives ?? 2) - 1);

            if (target.lives > 0) {
              // Respawn
              target.x = Math.floor(
                Math.random() * (ARENA.width - ARENA.padding * 2) + ARENA.padding
              );
              target.y = Math.floor(
                Math.random() * (ARENA.height - ARENA.padding * 2) + ARENA.padding
              );
              target.hp = 100;
              broadcast({
                type: "dead",
                id: otherId,
                respawn: { x: target.x, y: target.y, hp: target.hp, lives: target.lives },
              });
            } else {
              // Sin vidas: eliminado y fuera del mapa
              broadcast({ type: "eliminated", id: otherId });
              delete players[otherId];
              broadcast({ type: "remove", id: otherId });
            }
          }
        }
      });
      return;
    }
  });

  socket.on("close", () => {
    // Quitar jugador
    if (players[socket.playerId]) {
      delete players[socket.playerId];
      broadcast({ type: "remove", id: socket.playerId });
    }

    // Limpiar mapa de IPs activas si NO es bloqueo permanente
    if (!PERMANENT_BLOCK_PER_IP && socket.playerIP) {
      const cur = activeIPMap.get(socket.playerIP);
      if (cur === socket) activeIPMap.delete(socket.playerIP);
    }
  });
});

console.log("Servidor WebSocket en puerto 8080");

// Heartbeat: cierra conexiones muertas
const interval = setInterval(() => {
  server.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_MS);

server.on("close", function close() {
  clearInterval(interval);
});
