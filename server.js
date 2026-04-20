const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  10000,
  pingInterval:  5000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TICK_RATE   = 20;
const MAP_HALF    = 24;
const PLAYER_HP   = 100;
const BULLET_DMG  = 22;   // body shot (~5 hits)
const HEADSHOT_DMG= 55;   // headshot (~2 hits)
const RESPAWN_MS  = 3000;
const HIT_RADIUS  = 0.82;

const OBSTACLES = [
  { x:  0,   z:  0,   w: 4,   h: 2.5, d: 4   },
  { x: -12,  z: -12,  w: 2,   h: 2,   d: 6   },
  { x:  12,  z: -12,  w: 2,   h: 2,   d: 6   },
  { x: -12,  z:  12,  w: 2,   h: 2,   d: 6   },
  { x:  12,  z:  12,  w: 2,   h: 2,   d: 6   },
  { x:  0,   z: -16,  w: 8,   h: 2,   d: 2   },
  { x:  0,   z:  16,  w: 8,   h: 2,   d: 2   },
  { x: -20,  z:  0,   w: 2,   h: 2,   d: 8   },
  { x:  20,  z:  0,   w: 2,   h: 2,   d: 8   },
  { x: -6,   z:  0,   w: 1.5, h: 1.5, d: 1.5 },
  { x:  6,   z:  0,   w: 1.5, h: 1.5, d: 1.5 },
  { x:  0,   z: -6,   w: 1.5, h: 1.5, d: 1.5 },
  { x:  0,   z:  6,   w: 1.5, h: 1.5, d: 1.5 },
  { x: -16,  z: -7,   w: 1.5, h: 1.5, d: 1.5 },
  { x:  16,  z:  7,   w: 1.5, h: 1.5, d: 1.5 },
  // Extra cover
  { x: -8,   z: -18,  w: 3,   h: 1.5, d: 1.5 },
  { x:  8,   z:  18,  w: 3,   h: 1.5, d: 1.5 },
  { x: -18,  z:  8,   w: 1.5, h: 1.5, d: 3   },
  { x:  18,  z: -8,   w: 1.5, h: 1.5, d: 3   },
];

const SPAWN_POINTS = [
  { x: -20, z: -20 }, { x: 20, z: -20 },
  { x: -20, z:  20 }, { x: 20, z:  20 },
  { x:   0, z: -22 }, { x:  0, z:  22 },
  { x: -22, z:   0 }, { x: 22, z:   0 },
];

const PLAYER_COLORS = [
  '#ff4444','#44ff88','#4488ff','#ffdd44',
  '#ff44ff','#44ffff','#ff8844','#88ff44',
];

// ─── STATE ────────────────────────────────────────────────────────────────────
const players = new Map();
let colorIdx  = 0;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function randomSpawn() {
  const sp = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
  return { x: sp.x, y: 0, z: sp.z };
}

function obsCollides(x, z) {
  for (const o of OBSTACLES) {
    if (Math.abs(x - o.x) < o.w / 2 && Math.abs(z - o.z) < o.d / 2) return true;
  }
  return false;
}

/**
 * Returns { hit: bool, headshot: bool, t: number }
 * Tests a ray against a player cylinder.
 */
function rayVsPlayer(ox, oy, oz, dx, dy, dz, px, py, pz) {
  // Test two spheres: chest (y+0.9) and head (y+1.75)
  const tests = [
    { cy: py + 0.9,  hs: false }, // body
    { cy: py + 1.75, hs: true  }, // head — smaller radius
  ];
  let bestT = Infinity, headshot = false;

  for (const { cy, hs } of tests) {
    const rad = hs ? 0.28 : HIT_RADIUS;
    const tx = px - ox, ty = cy - oy, tz = pz - oz;
    const t  = tx * dx + ty * dy + tz * dz;
    if (t <= 0 || t > 85) continue;
    const ex = ox + dx * t - px;
    const ey = oy + dy * t - cy;
    const ez = oz + dz * t - pz;
    if (ex*ex + ey*ey + ez*ez < rad * rad && t < bestT) {
      bestT = t;
      headshot = hs;
    }
  }
  return { hit: bestT < Infinity, headshot, t: bestT };
}

// ─── SOCKET ───────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[+] connected:', socket.id);

  socket.on('join', ({ name }) => {
    const sp = randomSpawn();
    const p = {
      id:     socket.id,
      name:   (name || 'Ghost').slice(0, 16),
      color:  PLAYER_COLORS[colorIdx++ % PLAYER_COLORS.length],
      x: sp.x, y: sp.y, z: sp.z,
      rotY:   0,
      health: PLAYER_HP,
      kills:  0,
      deaths: 0,
      alive:  true,
    };
    players.set(socket.id, p);

    socket.emit('init', {
      id:        socket.id,
      players:   [...players.values()],
      obstacles: OBSTACLES,
    });
    socket.broadcast.emit('playerJoined', p);
    io.emit('killFeed', { msg: `${p.name} joined`, color: p.color });
  });

  // ── Movement ─────────────────────────────────────────────────────────────────
  socket.on('move', ({ x, z, rotY }) => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    const nx = Math.max(-MAP_HALF, Math.min(MAP_HALF, x));
    const nz = Math.max(-MAP_HALF, Math.min(MAP_HALF, z));
    if (!obsCollides(nx, nz)) { p.x = nx; p.z = nz; }
    p.rotY = rotY;
  });

  // ── Shoot ─────────────────────────────────────────────────────────────────────
  socket.on('shoot', ({ ox, oy, oz, dx, dy, dz }) => {
    const shooter = players.get(socket.id);
    if (!shooter || !shooter.alive) return;

    socket.broadcast.emit('bullet', { ox, oy, oz, dx, dy, dz, sid: socket.id });

    // Hit-scan — find closest target
    let hit = null, minT = Infinity, isHeadshot = false;
    players.forEach((p) => {
      if (p.id === socket.id || !p.alive) return;
      const result = rayVsPlayer(ox, oy, oz, dx, dy, dz, p.x, p.y, p.z);
      if (result.hit && result.t < minT) {
        hit = p;
        minT = result.t;
        isHeadshot = result.headshot;
      }
    });

    if (!hit) return;

    const dmg = isHeadshot ? HEADSHOT_DMG : BULLET_DMG;
    hit.health -= dmg;

    io.to(hit.id).emit('hit', {
      dmg,
      health:    hit.health,
      atkId:     shooter.id,
      atkX:      shooter.x,
      atkZ:      shooter.z,
      headshot:  isHeadshot,
    });

    // Confirm to shooter
    io.to(shooter.id).emit('shotHit', { headshot: isHeadshot });

    if (hit.health <= 0) {
      hit.alive  = false;
      hit.deaths += 1;
      shooter.kills += 1;

      io.emit('playerDied', { id: hit.id, killerId: shooter.id });
      io.emit('killFeed', {
        msg:         `${shooter.name}  ✕  ${hit.name}${isHeadshot ? '  ★' : ''}`,
        killerColor: shooter.color,
        victimColor: hit.color,
      });
      io.emit('scoreUpdate', {
        kId:    shooter.id, kills:  shooter.kills,
        vId:    hit.id,     deaths: hit.deaths,
      });

      setTimeout(() => {
        if (!players.has(hit.id)) return;
        const sp = randomSpawn();
        hit.x = sp.x; hit.y = sp.y; hit.z = sp.z;
        hit.health = PLAYER_HP;
        hit.alive  = true;
        io.to(hit.id).emit('respawn', { x: sp.x, y: sp.y, z: sp.z, health: PLAYER_HP });
        io.emit('playerRespawned', { id: hit.id, x: sp.x, y: sp.y, z: sp.z });
      }, RESPAWN_MS);
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (p) {
      io.emit('playerLeft', socket.id);
      io.emit('killFeed', { msg: `${p.name} left`, color: '#888' });
      players.delete(socket.id);
    }
    console.log('[-] disconnected:', socket.id);
  });
});

// ─── WORLD-STATE BROADCAST ────────────────────────────────────────────────────
setInterval(() => {
  if (!players.size) return;
  io.emit('worldState', [...players.values()].map(p => ({
    id:     p.id,
    x:      p.x,   y:  p.y,  z:  p.z,
    rotY:   p.rotY,
    health: p.health,
    alive:  p.alive,
    name:   p.name,
    color:  p.color,
    kills:  p.kills,
    deaths: p.deaths,
  })));
}, 1000 / TICK_RATE);

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮  Tactical Ops running on :${PORT}`));
