// server.js
const WebSocket = require("ws");
const server = new WebSocket.Server({ port: 8080 });

/**
 * Estado simple en memoria:
 * players = {
 *   [id]: { x, y, character, hp, lastAttackAt }
 * }
 */
let players = {};
const ARENA = { width: 1000, height: 800, padding: 20 };
const MOVE_CLAMP = (v, min, max) => Math.max(min, Math.min(max, v));
const ATTACK_RANGE = 50;
const ATTACK_COOLDOWN_MS = 500;
const DMG = 15;


function broadcast(payload) {
  const data = JSON.stringify(payload);
  server.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}

server.on("connection", (socket) => {
  console.log("Nuevo jugador conectado");

  // ID único por conexión
  const playerId = Date.now().toString();
  socket.playerId = playerId;

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
  lives: 2,          // 👈 dos vidas por jugador
  lastAttackAt: 0,
};

  // Enviar estado inicial SOLO al nuevo jugador
  socket.send(JSON.stringify({ type: "init", id: playerId, players, arena: ARENA }));

  socket.on("message", (msg) => {
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
      p.x = MOVE_CLAMP(
        data.position.x,
        ARENA.padding,
        ARENA.width - ARENA.padding
      );
      p.y = MOVE_CLAMP(
        data.position.y,
        ARENA.padding,
        ARENA.height - ARENA.padding
      );

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
    target.x = Math.floor(Math.random() * (ARENA.width - ARENA.padding * 2) + ARENA.padding);
    target.y = Math.floor(Math.random() * (ARENA.height - ARENA.padding * 2) + ARENA.padding);
    target.hp = 100;
    broadcast({
      type: "dead",
      id: otherId,
      respawn: { x: target.x, y: target.y, hp: target.hp, lives: target.lives },
    });
  } else {
    // 👇 Sin vidas: eliminado y fuera del mapa
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
    delete players[playerId];
    broadcast({ type: "remove", id: playerId });
  });
});

console.log("Servidor WebSocket en puerto 8080");
