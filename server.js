// server.js
const WebSocket = require("ws");

const PERMANENT_BLOCK_PER_IP = false;
const HEARTBEAT_MS = 15000;

const server = new WebSocket.Server({ port: 8080, perMessageDeflate: false });

let players = {};
const ARENA = { width: 1935, height: 1300, padding: 200 };
const MOVE_CLAMP = (v, min, max) => Math.max(min, Math.min(max, v));
const ATTACK_RANGE = 50;
const ATTACK_COOLDOWN_MS = 500;
const DMG = 15;

const seenIPs = new Set();
const activeIPMap = new Map();

function heartbeat() { this.isAlive = true; }

function getClientIP(req, socket) {
  const xfwd = req.headers["x-forwarded-for"];
  let ip = (xfwd && xfwd.split(",")[0].trim()) || req.socket?.remoteAddress || socket?._socket?.remoteAddress || "unknown";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

function denyAndClose(socket, reason = "IP already connected", code = 4001) {
  try { socket.send(JSON.stringify({ type: "error", code, reason })); } catch {}
  try { socket.close(code, reason); } catch {}
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  server.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}

server.on("connection", (socket, req) => {
  socket._msgCount = 0;
  socket._lastTick = Date.now();
  socket.isAlive = true;
  socket.on("pong", heartbeat);

  const ip = getClientIP(req, socket);
  if (PERMANENT_BLOCK_PER_IP) {
    if (seenIPs.has(ip)) return denyAndClose(socket, "IP bloqueada permanentemente", 4001);
    seenIPs.add(ip);
  } else {
    if (activeIPMap.has(ip)) return denyAndClose(socket, "Ya existe una sesión activa", 4002);
    activeIPMap.set(ip, socket);
  }

  const playerId = Date.now().toString();
  socket.playerId = playerId;
  socket.playerIP = ip;

  const startX = Math.floor(Math.random() * (ARENA.width - ARENA.padding * 2) + ARENA.padding);
  const startY = Math.floor(Math.random() * (ARENA.height - ARENA.padding * 2) + ARENA.padding);

  players[playerId] = { x: startX, y: startY, character: null, hp: 100, lives: 2, lastAttackAt: 0 };

  socket.send(JSON.stringify({ type: "init", id: playerId, players, arena: ARENA }));

  socket.on("message", (msg) => {
    const now = Date.now();
    if (now - socket._lastTick >= 1000) { socket._msgCount = 0; socket._lastTick = now; }
    socket._msgCount++;
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.type === "select") {
      const chosen = (data.character || "").toString();
      players[playerId].character = chosen || "knight";
      broadcast({ type: "spawn", id: playerId, state: players[playerId] });
      return;
    }

    if (data.type === "move" && data.position && players[playerId]) {
      const p = players[playerId];
      const rx = Number(data.position.x), ry = Number(data.position.y);
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) return;
      p.x = MOVE_CLAMP(rx, ARENA.padding, ARENA.width - ARENA.padding);
      p.y = MOVE_CLAMP(ry, ARENA.padding, ARENA.height - ARENA.padding);
      broadcast({ type: "update", id: playerId, position: { x: p.x, y: p.y } });
      return;
    }

    if (data.type === "attack" && players[playerId]) {
      const attacker = players[playerId];
      if (now - (attacker.lastAttackAt || 0) < ATTACK_COOLDOWN_MS) return;
      attacker.lastAttackAt = now;

      Object.keys(players).forEach((otherId) => {
        if (otherId === playerId) return;
        const target = players[otherId];
        if (!target) return;
        const dx = attacker.x - target.x, dy = attacker.y - target.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= ATTACK_RANGE) {
          target.hp = Math.max(0, (target.hp || 100) - DMG);
          broadcast({ type: "damage", id: otherId, hp: target.hp });
          if (target.hp <= 0) {
            target.lives = Math.max(0, (target.lives ?? 2) - 1);
            if (target.lives > 0) {
              target.x = Math.floor(Math.random() * (ARENA.width - ARENA.padding * 2) + ARENA.padding);
              target.y = Math.floor(Math.random() * (ARENA.height - ARENA.padding * 2) + ARENA.padding);
              target.hp = 100;
              broadcast({ type: "dead", id: otherId, respawn: { x: target.x, y: target.y, hp: target.hp, lives: target.lives } });
            } else {
              broadcast({ type: "eliminated", id: otherId });
              delete players[otherId];
              broadcast({ type: "remove", id: otherId });
            }
          }
        }
      });
      return;
    }

    // Curación
    if (data.type === "heal" && players[playerId]) {
      const p = players[playerId];
      if (p.lives === 1 && p.hp < 100) {
        p.hp = 100;
        broadcast({ type: "healed", id: playerId, hp: p.hp });
      }
      return;
    }
  });

  socket.on("close", () => {
    if (players[socket.playerId]) {
      delete players[socket.playerId];
      broadcast({ type: "remove", id: socket.playerId });
    }
    if (!PERMANENT_BLOCK_PER_IP && socket.playerIP) {
      const cur = activeIPMap.get(socket.playerIP);
      if (cur === socket) activeIPMap.delete(socket.playerIP);
    }
  });
});

console.log("Servidor WebSocket en puerto 8080");

setInterval(() => {
  server.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_MS);
