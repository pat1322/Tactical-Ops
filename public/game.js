// ═══════════════════════════════════════════════════════════════════════════
//  TACTICAL OPS  –  game.js  v3
//  Three.js r128  ·  Socket.io client
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CFG = {
  moveSpeed:      6.5,
  runSpeed:       11.5,
  camDist:        5.0,
  camHeightOff:   1.4,
  camLookY:       1.0,
  camVMin:        0.05,
  camVMax:        1.12,
  sensitivity:    0.0022,
  sendMs:         50,
  bulletSpeed:    95,
  bulletMaxDist:  80,
  fireCooldown:   0.095,
  maxAmmo:        30,
  reloadSec:      1.8,
  mapHalf:        24,
  playerR:        0.52,
  interp:         0.15,
  staminaMax:     100,
  staminaDrain:   32,
  staminaRegen:   20,
  staminaRunMin:  15,
};

// ─── SOLO MODE STATIC DATA ────────────────────────────────────────────────────
const SOLO_OBSTACLES = [
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
  { x: -8,   z: -18,  w: 3,   h: 1.5, d: 1.5 },
  { x:  8,   z:  18,  w: 3,   h: 1.5, d: 1.5 },
  { x: -18,  z:  8,   w: 1.5, h: 1.5, d: 3   },
  { x:  18,  z: -8,   w: 1.5, h: 1.5, d: 3   },
];

const SOLO_SPAWNS = [
  { x: -20, z: -20 }, { x: 20, z: -20 },
  { x: -20, z:  20 }, { x: 20, z:  20 },
  { x:   0, z: -22 }, { x:  0, z:  22 },
  { x: -22, z:   0 }, { x: 22, z:   0 },
];

// ─── GLOBALS ──────────────────────────────────────────────────────────────────
let socket, myId;
let scene, renderer, threeCamera, clock;
let muzzleLight, muzzleTimer = 0;
let lastSendTime   = 0;
let sbUpdateTimer  = 0;
let minimapCtx     = null;
let soloMode       = false;

const keys      = {};
const obstacles = [];
const remotes   = new Map();
const bullets   = [];
const bots      = [];
let mdX = 0, mdY = 0;
let isLocked  = false;
let mouseDown = false;
let isMoving  = false;
let isRunning = false;

// ── Player state ──────────────────────────────────────────────────────────────
const P = {
  mesh:      null,
  x: 0, y: 0, z: 0,
  rotY:      0,
  health:    100,
  kills:     0,
  deaths:    0,
  alive:     true,
  ammo:      CFG.maxAmmo,
  reloading: false,
  reloadT:   0,
  fireT:     0,
  color:     '#44ff88',
  stamina:   CFG.staminaMax,
  canSprint: true,
};

// ── Camera systems ────────────────────────────────────────────────────────────
const CAM    = { h: 0, v: 0.38 };
const BOB    = { x: 0, y: 0, t: 0 };
const RECOIL = { pitch: 0, recovery: 0 };
const SHAKE  = { intensity: 0, ox: 0, oy: 0 };

let spread       = 0;
let hitDirAngle  = 0;
let hitDirAlpha  = 0;
let killNotifyT  = 0;
let headshotT    = 0;

// ─── SOCKET ───────────────────────────────────────────────────────────────────
function initSocket(name) {
  socket = io({ reconnectionAttempts: 10 });

  socket.on('connect', () => socket.emit('join', { name }));

  socket.on('init', (d) => {
    myId = d.id;
    obstacles.length = 0;
    obstacles.push(...d.obstacles);
    buildObstacles();
    d.players.forEach(p => {
      if (p.id === myId) {
        P.mesh.position.set(p.x, p.y, p.z);
        P.x = p.x; P.y = p.y; P.z = p.z;
        P.health = p.health;
        P.color  = p.color;
        applyColor(P.mesh, p.color);
      } else {
        addRemote(p);
      }
    });
    refreshHUD();
  });

  socket.on('playerJoined', addRemote);
  socket.on('playerLeft',   removeRemote);

  socket.on('worldState', (list) => {
    list.forEach(p => {
      if (p.id === myId) return;
      const r = remotes.get(p.id);
      if (!r) return;
      r.target = { x: p.x, y: p.y, z: p.z, rotY: p.rotY };
      r.data   = p;
      r.mesh.visible = p.alive;
    });
  });

  socket.on('bullet', ({ ox, oy, oz, dx, dy, dz, sid }) => {
    if (sid !== myId) spawnTracer(
      new THREE.Vector3(ox, oy, oz),
      new THREE.Vector3(dx, dy, dz),
      0xffaa44
    );
  });

  socket.on('hit', ({ health, atkId, atkX, atkZ }) => {
    P.health = health;
    refreshHUD();
    flashDamage();
    addShake(0.25);
    if (atkX !== undefined) {
      showHitDir(atkX, atkZ);
    } else if (atkId) {
      const r = remotes.get(atkId);
      if (r) showHitDir(r.mesh.position.x, r.mesh.position.z);
    }
  });

  socket.on('shotHit', ({ headshot }) => {
    if (headshot) { headshotT = 0.8; showHeadshotNotify(); }
    else hitMarkerFlash();
  });

  socket.on('playerDied', ({ id, killerId }) => {
    if (id === myId) {
      P.alive = false; P.health = 0;
      const killer = remotes.get(killerId);
      showDeath(killer ? killer.data.name : '???');
      refreshHUD();
    }
    const r = remotes.get(id);
    if (r) r.mesh.visible = false;
  });

  socket.on('respawn', ({ x, y, z, health }) => {
    P.alive    = true; P.health = health;
    P.x = x;   P.y = y; P.z = z;
    P.ammo     = CFG.maxAmmo;
    P.reloading = false;
    P.stamina  = CFG.staminaMax;
    P.canSprint = true;
    P.mesh.position.set(x, y, z);
    hideDeath();
    refreshHUD();
  });

  socket.on('playerRespawned', ({ id, x, y, z }) => {
    const r = remotes.get(id);
    if (!r) return;
    r.mesh.visible = true;
    r.target = { x, y, z, rotY: 0 };
    r.mesh.position.set(x, y, z);
  });

  socket.on('scoreUpdate', ({ kId, kills, vId, deaths }) => {
    if (kId === myId) { P.kills  = kills;  showKillNotify(); refreshHUD(); }
    if (vId === myId) { P.deaths = deaths; refreshHUD(); }
    const rk = remotes.get(kId); if (rk) rk.data.kills  = kills;
    const rv = remotes.get(vId); if (rv) rv.data.deaths  = deaths;
    updateScoreboard();
  });

  socket.on('killFeed', ({ msg, killerColor, color }) => {
    addFeedEntry(msg, killerColor || color || '#aaa');
  });
}

// ─── THREE.JS INIT ────────────────────────────────────────────────────────────
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141820);
  scene.fog = new THREE.FogExp2(0x141820, 0.016);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  document.getElementById('gameCanvas').appendChild(renderer.domElement);

  threeCamera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 200);
  clock = new THREE.Clock();

  scene.add(new THREE.AmbientLight(0x304050, 0.9));

  const sun = new THREE.DirectionalLight(0xfff0d0, 1.3);
  sun.position.set(15, 30, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far  = 100;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -35;
  sun.shadow.camera.right = sun.shadow.camera.top   =  35;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x3060ff, 0.25);
  fill.position.set(-10, 6, -15);
  scene.add(fill);

  // Atmospheric corner lights
  [[0x4060ff,-18,-18],[0xff4020,18,-18],[0x20ff60,-18,18],[0xff6020,18,18]].forEach(([col,x,z]) => {
    const pt = new THREE.PointLight(col, 0.5, 14);
    pt.position.set(x, 3.5, z);
    scene.add(pt);
  });

  muzzleLight = new THREE.PointLight(0xff8800, 0, 8, 2);
  scene.add(muzzleLight);

  P.mesh = buildCharacter('#44ff88');
  scene.add(P.mesh);

  buildStaticMap();

  const mc = document.getElementById('minimap');
  if (mc) minimapCtx = mc.getContext('2d');

  window.addEventListener('resize', () => {
    threeCamera.aspect = innerWidth / innerHeight;
    threeCamera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

// ─── MAP BUILDING ─────────────────────────────────────────────────────────────
function buildStaticMap() {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(50, 50),
    new THREE.MeshLambertMaterial({ map: makeFloorTex() })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Outer walls
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x1c2030, map: makeWallTex() });
  const ms = 25, wh = 6;
  [
    [[0, wh/2, -ms], [50, wh, 1.2]],
    [[0, wh/2,  ms], [50, wh, 1.2]],
    [[-ms, wh/2, 0], [1.2, wh, 50]],
    [[ ms, wh/2, 0], [1.2, wh, 50]],
  ].forEach(([pos, size]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), wallMat);
    m.position.set(...pos);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  });

  // Corner warning pillars with yellow stripes
  const pillarMat = new THREE.MeshLambertMaterial({ color: 0x252010 });
  const stripeMat = new THREE.MeshLambertMaterial({ color: 0xddaa00 });
  [[-24,-24],[24,-24],[-24,24],[24,24]].forEach(([x,z]) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(1.5, 6, 1.5), pillarMat);
    p.position.set(x, 3, z);
    p.castShadow = true;
    scene.add(p);
    const s = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.45, 1.52), stripeMat);
    s.position.set(x, 2.5, z);
    scene.add(s);
    const s2 = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.45, 1.52), stripeMat);
    s2.position.set(x, 4.8, z);
    scene.add(s2);
  });

  // Zone markers
  const zoneMat  = new THREE.MeshLambertMaterial({ color: 0x1a3a1a });
  const centerMat = new THREE.MeshLambertMaterial({ color: 0x1a2a3a });
  [[-20,-20],[20,-20],[-20,20],[20,20]].forEach(([x,z]) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 0.04, 24), zoneMat);
    c.position.set(x, 0.02, z);
    scene.add(c);
  });
  const cc = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 0.04, 32), centerMat);
  cc.position.set(0, 0.02, 0);
  scene.add(cc);
}

function buildObstacles() {
  const concreteMat = new THREE.MeshLambertMaterial({ color: 0x363636, map: makeConcreteTex() });
  const metalMat    = new THREE.MeshLambertMaterial({ color: 0x2a3020, map: makeMetalTex() });
  const crateMat    = new THREE.MeshLambertMaterial({ color: 0x4a3a28, map: makeCrateTex() });
  const warningMat  = new THREE.MeshLambertMaterial({ color: 0xddaa00 });

  obstacles.forEach(o => {
    const h = o.h || 2;
    let mat;
    if (h >= 2.5)     mat = concreteMat;
    else if (h >= 2)  mat = metalMat;
    else              mat = crateMat;

    const m = new THREE.Mesh(new THREE.BoxGeometry(o.w, h, o.d), mat);
    m.position.set(o.x, h / 2, o.z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);

    // Warning stripe on tall/wide obstacles
    if (h >= 2 && (o.w >= 2 || o.d >= 2)) {
      const wm = new THREE.Mesh(new THREE.BoxGeometry(o.w + 0.01, 0.10, 0.04), warningMat);
      wm.position.set(o.x, 0.25, o.z + o.d / 2);
      scene.add(wm);
    }
  });
}

// ─── PROCEDURAL TEXTURES ─────────────────────────────────────────────────────
function makeFloorTex() {
  const c = mkCanvas(512), ctx = c.getContext('2d');
  ctx.fillStyle = '#2d2d2d';
  ctx.fillRect(0, 0, 512, 512);
  // Concrete noise
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * 512, y = Math.random() * 512;
    const v = 35 + (Math.random() * 18 | 0);
    ctx.fillStyle = `rgba(${v},${v},${v},0.28)`;
    ctx.fillRect(x, y, 2, 2);
  }
  // Subtle tile seams
  ctx.strokeStyle = 'rgba(20,20,20,0.6)'; ctx.lineWidth = 1.5;
  for (let i = 0; i <= 512; i += 64) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }
  // Tactical painted lines (green)
  ctx.strokeStyle = 'rgba(60,160,60,0.22)'; ctx.lineWidth = 3;
  for (let i = 0; i <= 512; i += 128) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(7, 7);
  return t;
}

function makeWallTex() {
  const c = mkCanvas(256), ctx = c.getContext('2d');
  ctx.fillStyle = '#1c2030'; ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#171c28';
  for (let y = 0; y < 256; y += 32)
    for (let x = (y / 32 | 0) % 2 * 16; x < 256; x += 32)
      ctx.fillRect(x + 1, y + 1, 30, 15);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  return t;
}

function makeCrateTex() {
  const c = mkCanvas(256), ctx = c.getContext('2d');
  ctx.fillStyle = '#4a3a28'; ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#2e221a'; ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, 246, 246);
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(128, 5); ctx.lineTo(128, 251); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(5, 128); ctx.lineTo(251, 128); ctx.stroke();
  ctx.strokeStyle = '#5a4a36'; ctx.lineWidth = 2;
  for (let y = 20; y < 256; y += 18) {
    ctx.beginPath(); ctx.moveTo(0, y + Math.sin(y) * 3); ctx.lineTo(256, y); ctx.stroke();
  }
  return new THREE.CanvasTexture(c);
}

function makeConcreteTex() {
  const c = mkCanvas(256), ctx = c.getContext('2d');
  ctx.fillStyle = '#383838'; ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 3;
  for (let y = 0; y < 256; y += 52)
    for (let x = (y / 52 | 0) % 2 * 26; x < 256; x += 52)
      ctx.strokeRect(x + 2, y + 2, 48, 48);
  for (let i = 0; i < 600; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const v = 50 + (Math.random() * 20 | 0);
    ctx.fillStyle = `rgba(${v},${v},${v},0.12)`;
    ctx.fillRect(x, y, 3, 3);
  }
  return new THREE.CanvasTexture(c);
}

function makeMetalTex() {
  const c = mkCanvas(256), ctx = c.getContext('2d');
  ctx.fillStyle = '#2a3020'; ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#3a4030'; ctx.lineWidth = 1;
  for (let y = 0; y < 256; y += 8) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
  }
  ctx.strokeStyle = '#1e2418'; ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, 248, 248);
  ctx.strokeRect(18, 18, 220, 220);
  return new THREE.CanvasTexture(c);
}

function mkCanvas(s) {
  const c = document.createElement('canvas');
  c.width = c.height = s;
  return c;
}

// ─── CHARACTER MESH ───────────────────────────────────────────────────────────
function buildCharacter(color, name) {
  const g = new THREE.Group();

  const suit  = new THREE.MeshLambertMaterial({ color: 0x2d3a22 });  // olive combat suit
  const armor = new THREE.MeshLambertMaterial({ color: 0x1e2428 });  // dark gunmetal armor
  const helm  = new THREE.MeshLambertMaterial({ color: 0x131618 });  // matte black helmet
  const visor = new THREE.MeshLambertMaterial({ color: 0x0d1a2e, emissive: new THREE.Color(0x000c20) });
  const boot  = new THREE.MeshLambertMaterial({ color: 0x0c0c0c });
  const glove = new THREE.MeshLambertMaterial({ color: 0x151515 });
  const gunM  = new THREE.MeshLambertMaterial({ color: 0x0e0e0e });
  const scopeM= new THREE.MeshLambertMaterial({ color: 0x1a2030 });
  const strip = new THREE.MeshLambertMaterial({ color });            // team color accent
  g.userData.accentMat = strip;

  function B(w, h, d, mat, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  }

  // ── Boots ─────────────────────────────────────────────────────────────────
  B(0.22, 0.18, 0.34, boot,  -0.18, 0.09,  0.02);
  B(0.22, 0.18, 0.34, boot,   0.18, 0.09,  0.02);

  // ── Lower legs ────────────────────────────────────────────────────────────
  B(0.20, 0.50, 0.20, suit,  -0.18, 0.43,  0);
  B(0.20, 0.50, 0.20, suit,   0.18, 0.43,  0);
  // Shin guards (front-facing armor plate)
  B(0.22, 0.24, 0.10, armor, -0.18, 0.36,  0.08);
  B(0.22, 0.24, 0.10, armor,  0.18, 0.36,  0.08);

  // ── Knee pads ─────────────────────────────────────────────────────────────
  B(0.24, 0.12, 0.18, armor, -0.18, 0.68,  0.06);
  B(0.24, 0.12, 0.18, armor,  0.18, 0.68,  0.06);

  // ── Upper legs ────────────────────────────────────────────────────────────
  B(0.22, 0.44, 0.22, suit,  -0.18, 0.92,  0);
  B(0.22, 0.44, 0.22, suit,   0.18, 0.92,  0);
  // Thigh armor
  B(0.26, 0.22, 0.16, armor, -0.18, 1.00,  0.04);
  B(0.26, 0.22, 0.16, armor,  0.18, 1.00,  0.04);

  // ── Hips / belt ───────────────────────────────────────────────────────────
  B(0.50, 0.16, 0.26, suit,   0,    1.20,  0);
  B(0.54, 0.09, 0.32, armor,  0,    1.16,  0); // belt

  // ── Torso ─────────────────────────────────────────────────────────────────
  B(0.54, 0.60, 0.28, suit,   0,    1.60,  0);
  // Tactical chest plate (front)
  B(0.50, 0.54, 0.10, armor,  0,    1.60,  0.17);
  // Back plate
  B(0.46, 0.48, 0.08, armor,  0,    1.60, -0.16);

  // ── Shoulder armor ────────────────────────────────────────────────────────
  B(0.17, 0.19, 0.28, armor, -0.38, 1.82,  0);
  B(0.17, 0.19, 0.28, armor,  0.38, 1.82,  0);

  // ── Upper arms ────────────────────────────────────────────────────────────
  B(0.18, 0.38, 0.18, suit,  -0.40, 1.58,  0);
  B(0.18, 0.38, 0.18, suit,   0.40, 1.58,  0);
  // Elbow guard
  B(0.20, 0.12, 0.18, armor, -0.40, 1.42,  0.02);
  B(0.20, 0.12, 0.18, armor,  0.40, 1.42,  0.02);

  // ── Forearms ──────────────────────────────────────────────────────────────
  B(0.16, 0.32, 0.16, suit,  -0.40, 1.22,  0);
  B(0.16, 0.32, 0.16, suit,   0.40, 1.22,  0);

  // ── Gloves ────────────────────────────────────────────────────────────────
  B(0.16, 0.14, 0.18, glove, -0.40, 1.03,  0);
  B(0.16, 0.14, 0.18, glove,  0.40, 1.03,  0);

  // ── Neck ──────────────────────────────────────────────────────────────────
  B(0.16, 0.13, 0.16, suit,   0,    1.96,  0);

  // ── Head (balaclava lower face) ───────────────────────────────────────────
  B(0.30, 0.22, 0.28, suit,   0,    2.13,  0);

  // ── Helmet ────────────────────────────────────────────────────────────────
  B(0.36, 0.28, 0.34, helm,   0,    2.27,  0);   // main shell
  B(0.32, 0.12, 0.30, helm,   0,    2.42,  0);   // top cap
  B(0.38, 0.07, 0.16, helm,   0,    2.10,  0.19); // front brim
  // Side ear guards
  B(0.06, 0.20, 0.28, helm,  -0.22, 2.22,  0);
  B(0.06, 0.20, 0.28, helm,   0.22, 2.22,  0);

  // ── Visor ─────────────────────────────────────────────────────────────────
  B(0.28, 0.12, 0.06, visor,  0,    2.20,  0.20);

  // ── Color accent strips ───────────────────────────────────────────────────
  B(0.06, 0.40, 0.12, strip,  0.28, 1.62,  0.21); // right chest stripe
  B(0.06, 0.16, 0.06, strip, -0.38, 1.83,  0.15); // left shoulder patch

  // ── Assault rifle ─────────────────────────────────────────────────────────
  B(0.09, 0.14, 0.68, gunM,   0.44, 1.18, -0.18); // body
  // Barrel (cylinder)
  const brl = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.46, 6), gunM);
  brl.rotation.x = Math.PI / 2;
  brl.position.set(0.44, 1.22, -0.64);
  g.add(brl);
  // Muzzle brake
  const mb = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.028, 0.06, 6), gunM);
  mb.rotation.x = Math.PI / 2;
  mb.position.set(0.44, 1.22, -0.90);
  g.add(mb);
  B(0.07, 0.26, 0.07, gunM,   0.44, 0.97, -0.14); // magazine
  B(0.09, 0.12, 0.24, gunM,   0.44, 1.11,  0.22); // stock
  B(0.07, 0.07, 0.32, scopeM, 0.44, 1.29, -0.20); // scope/optic
  // Foregrip
  B(0.05, 0.14, 0.05, gunM,   0.44, 1.04, -0.38);

  if (name) g.add(makeNameSprite(name));
  return g;
}

function applyColor(mesh, color) {
  if (mesh.userData.accentMat) mesh.userData.accentMat.color.set(color);
}

function makeNameSprite(name) {
  const w = 256, h = 44;
  const c = mkCanvas(w); c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(name.slice(0, 16), w / 2, 30);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), depthTest: false, transparent: true,
  }));
  spr.scale.set(2.2, 0.42, 1);
  spr.position.y = 2.85;
  return spr;
}

// ─── REMOTE PLAYERS ───────────────────────────────────────────────────────────
function addRemote(data) {
  if (remotes.has(data.id)) return;
  const mesh = buildCharacter(data.color || '#ff4444', data.name);
  mesh.position.set(data.x, data.y, data.z);
  mesh.visible = data.alive !== false;
  scene.add(mesh);
  remotes.set(data.id, {
    data, mesh,
    target: { x: data.x, y: data.y, z: data.z, rotY: data.rotY || 0 },
  });
}

function removeRemote(id) {
  const r = remotes.get(id);
  if (!r) return;
  scene.remove(r.mesh);
  remotes.delete(id);
}

function tickRemotes() {
  const s = CFG.interp;
  remotes.forEach(r => {
    const { mesh, target } = r;
    mesh.position.x += (target.x - mesh.position.x) * s;
    mesh.position.y += (target.y - mesh.position.y) * s;
    mesh.position.z += (target.z - mesh.position.z) * s;
    let diff = target.rotY - mesh.rotation.y;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    mesh.rotation.y += diff * 0.18;
  });
}

// ─── BOT AI (SOLO MODE) ───────────────────────────────────────────────────────
const BOT_NAMES   = ['SIGMA','DELTA','ALPHA','OMEGA','BRAVO'];
const BOT_COLORS  = ['#ff4444','#ff8844','#ff44ff','#ffdd44','#ff4488'];
const BOT_SPEED   = 5.0;
const BOT_SHOOT_INTERVAL = 0.85;
const BOT_SIGHT   = 22;
const BOT_INACCURACY = 0.12; // radians of spread

function initBots(count) {
  // Place player far from bots
  const pSpawn = SOLO_SPAWNS[0];
  P.mesh.position.set(pSpawn.x, 0, pSpawn.z);
  P.x = pSpawn.x; P.z = pSpawn.z;

  for (let i = 0; i < count; i++) {
    const sp = SOLO_SPAWNS[(i + 2) % SOLO_SPAWNS.length];
    const mesh = buildCharacter(BOT_COLORS[i], BOT_NAMES[i]);
    mesh.position.set(sp.x, 0, sp.z);
    scene.add(mesh);
    bots.push({
      id:     'bot_' + i,
      name:   BOT_NAMES[i],
      color:  BOT_COLORS[i],
      mesh,
      x: sp.x, z: sp.z,
      health: 100,
      alive:  true,
      kills:  0,
      deaths: 0,
      state:  'PATROL',
      patrolTarget: randomWaypoint(),
      shootTimer:   Math.random() * BOT_SHOOT_INTERVAL,
      respawnTimer: 0,
    });
  }
}

function randomWaypoint() {
  const pts = [
    { x: 0, z: 0 }, { x: -10, z: -10 }, { x: 10, z: -10 },
    { x: -10, z: 10 }, { x: 10, z: 10 }, { x: -18, z: 0 },
    { x: 18, z: 0 }, { x: 0, z: -18 }, { x: 0, z: 18 },
    { x: -8, z: -8 }, { x: 8, z: 8 },
  ];
  return pts[Math.floor(Math.random() * pts.length)];
}

function tickBots(dt) {
  for (const bot of bots) {
    if (!bot.alive) {
      bot.respawnTimer -= dt;
      if (bot.respawnTimer <= 0) respawnBot(bot);
      continue;
    }

    const dx = P.x - bot.x;
    const dz = P.z - bot.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const sees = P.alive && dist < BOT_SIGHT;

    if (sees) {
      bot.state = dist < 16 ? 'SHOOT' : 'CHASE';
    } else {
      bot.state = 'PATROL';
    }

    if (bot.state === 'PATROL') {
      const pdx = bot.patrolTarget.x - bot.x;
      const pdz = bot.patrolTarget.z - bot.z;
      const pd  = Math.sqrt(pdx * pdx + pdz * pdz);
      if (pd < 1.2) {
        bot.patrolTarget = randomWaypoint();
      } else {
        const spd = (BOT_SPEED * 0.6) * dt;
        const nx  = bot.x + (pdx / pd) * spd;
        const nz  = bot.z + (pdz / pd) * spd;
        if (!collidesAt(nx, nz)) { bot.x = nx; bot.z = nz; }
        bot.mesh.position.set(bot.x, 0, bot.z);
        bot.mesh.rotation.y = Math.atan2(pdx, pdz);
      }
    } else if (bot.state === 'CHASE') {
      const spd = BOT_SPEED * dt;
      const nx  = bot.x + (dx / dist) * spd;
      const nz  = bot.z + (dz / dist) * spd;
      if (!collidesAt(nx, nz)) { bot.x = nx; bot.z = nz; }
      bot.mesh.position.set(bot.x, 0, bot.z);
      bot.mesh.rotation.y = Math.atan2(dx, dz);
    } else if (bot.state === 'SHOOT') {
      // Face player
      bot.mesh.rotation.y = Math.atan2(dx, dz);
      bot.shootTimer -= dt;
      if (bot.shootTimer <= 0) {
        botShoot(bot);
        bot.shootTimer = BOT_SHOOT_INTERVAL + Math.random() * 0.3;
      }
    }
  }
}

function botShoot(bot) {
  const inaccuracy = BOT_INACCURACY;
  const adx = P.x - bot.x + (Math.random() - 0.5) * inaccuracy * 14;
  const ady = 1.0;
  const adz = P.z - bot.z + (Math.random() - 0.5) * inaccuracy * 14;
  const len = Math.sqrt(adx * adx + ady * ady + adz * adz);
  const ndx = adx / len, ndy = ady / len, ndz = adz / len;

  const ox = bot.x, oy = 1.2, oz = bot.z;
  spawnTracer(new THREE.Vector3(ox, oy, oz), new THREE.Vector3(ndx, ndy, ndz), 0xff4422);

  if (!P.alive) return;
  const result = clientRayVsPlayer(ox, oy, oz, ndx, ndy, ndz);
  if (!result.hit) return;

  const dmg = result.headshot ? 55 : 22;
  P.health = Math.max(0, P.health - dmg);
  refreshHUD();
  flashDamage();
  addShake(0.25);
  showHitDir(bot.x, bot.z);

  if (P.health <= 0 && P.alive) {
    P.alive = false;
    P.deaths++;
    bot.kills++;
    showDeath(bot.name);
    addFeedEntry(`${bot.name}  ✕  YOU`, bot.color);
    refreshHUD();
    updateScoreboard();
    setTimeout(() => {
      const sp = SOLO_SPAWNS[Math.floor(Math.random() * SOLO_SPAWNS.length)];
      P.alive = true; P.health = 100;
      P.x = sp.x; P.z = sp.z;
      P.ammo = CFG.maxAmmo; P.reloading = false;
      P.stamina = CFG.staminaMax; P.canSprint = true;
      P.mesh.position.set(sp.x, 0, sp.z);
      hideDeath(); refreshHUD();
    }, 3000);
  }
}

function respawnBot(bot) {
  const sp = SOLO_SPAWNS[Math.floor(Math.random() * SOLO_SPAWNS.length)];
  bot.x = sp.x; bot.z = sp.z;
  bot.health = 100;
  bot.alive  = true;
  bot.state  = 'PATROL';
  bot.patrolTarget = randomWaypoint();
  bot.mesh.position.set(sp.x, 0, sp.z);
  bot.mesh.visible = true;
  addFeedEntry(`${bot.name} respawned`, bot.color);
}

// Client-side ray vs player for bot shooting at local player
function clientRayVsPlayer(ox, oy, oz, dx, dy, dz) {
  const px = P.x, py = P.y, pz = P.z;
  const tests = [
    { cy: py + 0.9,  r: 0.82, hs: false },
    { cy: py + 1.75, r: 0.28, hs: true  },
  ];
  let bestT = Infinity, headshot = false;
  for (const { cy, r, hs } of tests) {
    const tx = px - ox, ty = cy - oy, tz = pz - oz;
    const t  = tx * dx + ty * dy + tz * dz;
    if (t <= 0 || t > 85) continue;
    const ex = ox + dx * t - px;
    const ey = oy + dy * t - cy;
    const ez = oz + dz * t - pz;
    if (ex*ex + ey*ey + ez*ez < r*r && t < bestT) {
      bestT = t; headshot = hs;
    }
  }
  return { hit: bestT < Infinity, headshot };
}

// Client-side ray vs bot for player shooting at bots
function clientRayVsBot(ox, oy, oz, dx, dy, dz, bot) {
  const px = bot.x, py = 0, pz = bot.z;
  const tests = [
    { cy: py + 0.9,  r: 0.82, hs: false },
    { cy: py + 1.75, r: 0.28, hs: true  },
  ];
  let bestT = Infinity, headshot = false;
  for (const { cy, r, hs } of tests) {
    const tx = px - ox, ty = cy - oy, tz = pz - oz;
    const t  = tx * dx + ty * dy + tz * dz;
    if (t <= 0 || t > 85) continue;
    const ex = ox + dx * t - px;
    const ey = oy + dy * t - cy;
    const ez = oz + dz * t - pz;
    if (ex*ex + ey*ey + ez*ez < r*r && t < bestT) {
      bestT = t; headshot = hs;
    }
  }
  return { hit: bestT < Infinity, headshot, t: bestT };
}

function checkBotHits(ori, dir) {
  let closestBot = null, minT = Infinity, isHeadshot = false;
  for (const bot of bots) {
    if (!bot.alive) continue;
    const result = clientRayVsBot(ori.x, ori.y, ori.z, dir.x, dir.y, dir.z, bot);
    if (result.hit && result.t < minT) {
      closestBot = bot; minT = result.t; isHeadshot = result.headshot;
    }
  }
  if (!closestBot) return;

  const dmg = isHeadshot ? 55 : 22;
  closestBot.health -= dmg;

  if (isHeadshot) { headshotT = 0.8; showHeadshotNotify(); }
  else hitMarkerFlash();

  if (closestBot.health <= 0) {
    closestBot.alive  = false;
    closestBot.deaths++;
    closestBot.mesh.visible = false;
    closestBot.respawnTimer = 3.0;
    closestBot.state = 'DEAD';
    P.kills++;
    showKillNotify();
    refreshHUD();
    addFeedEntry(`YOU  ✕  ${closestBot.name}${isHeadshot ? '  ★' : ''}`, '#44ff88');
    updateScoreboard();
  }
}

// ─── INPUT ────────────────────────────────────────────────────────────────────
function initInput() {
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'r' && P.alive && !P.reloading && P.ammo < CFG.maxAmmo) startReload();
    if (e.key === 'Tab') {
      e.preventDefault();
      document.getElementById('scoreboard').style.display = 'block';
      updateScoreboard();
    }
    if (e.key === 'Escape') document.exitPointerLock();
  });

  window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
    if (e.key === 'Tab') document.getElementById('scoreboard').style.display = 'none';
  });

  window.addEventListener('mousemove', e => {
    if (!isLocked) return;
    mdX += e.movementX;
    mdY += e.movementY;
  });

  window.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (!isLocked) { renderer.domElement.requestPointerLock(); return; }
    mouseDown = true;
  });
  window.addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; });

  document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === renderer.domElement;
    document.getElementById('lockPrompt').style.display = isLocked ? 'none' : 'flex';
    document.body.classList.toggle('game-locked', isLocked);
  });
}

// ─── COLLISION ────────────────────────────────────────────────────────────────
function collidesAt(x, z) {
  const r = CFG.playerR;
  if (Math.abs(x) > CFG.mapHalf - r || Math.abs(z) > CFG.mapHalf - r) return true;
  for (const o of obstacles) {
    if (Math.abs(x - o.x) < o.w / 2 + r && Math.abs(z - o.z) < o.d / 2 + r) return true;
  }
  return false;
}

// ─── MOVEMENT + STAMINA ───────────────────────────────────────────────────────
function tickMovement(dt) {
  if (!P.alive) return;

  CAM.h -= mdX * CFG.sensitivity;
  CAM.v -= mdY * CFG.sensitivity;
  CAM.v  = Math.max(CFG.camVMin, Math.min(CFG.camVMax, CAM.v));
  mdX = 0; mdY = 0;

  if (RECOIL.pitch > 0) {
    const recovery = dt * 5.5;
    RECOIL.pitch = Math.max(0, RECOIL.pitch - recovery);
    CAM.v = Math.min(CFG.camVMax, CAM.v + recovery * 0.6);
  }

  const sh = Math.sin(CAM.h), ch = Math.cos(CAM.h);
  const fwdX = -sh, fwdZ = -ch;
  const rgtX =  ch, rgtZ = -sh;

  let mx = 0, mz = 0;
  if (keys['w'] || keys['arrowup'])    { mx += fwdX; mz += fwdZ; }
  if (keys['s'] || keys['arrowdown'])  { mx -= fwdX; mz -= fwdZ; }
  if (keys['a'] || keys['arrowleft'])  { mx -= rgtX; mz -= rgtZ; }
  if (keys['d'] || keys['arrowright']) { mx += rgtX; mz += rgtZ; }

  isMoving  = mx !== 0 || mz !== 0;
  isRunning = keys['shift'] && isMoving && P.canSprint && P.stamina > 0;

  if (isRunning) {
    P.stamina = Math.max(0, P.stamina - CFG.staminaDrain * dt);
    if (P.stamina === 0) P.canSprint = false;
  } else {
    P.stamina = Math.min(CFG.staminaMax, P.stamina + CFG.staminaRegen * dt);
    if (!P.canSprint && P.stamina >= CFG.staminaRunMin) P.canSprint = true;
  }
  updateStaminaUI();

  if (isMoving) {
    const len = Math.sqrt(mx*mx + mz*mz);
    const spd = (isRunning ? CFG.runSpeed : CFG.moveSpeed) * dt / len;
    const nx  = P.mesh.position.x + mx * spd;
    const nz  = P.mesh.position.z + mz * spd;

    if (!collidesAt(nx, nz)) {
      P.mesh.position.x = nx;
      P.mesh.position.z = nz;
    } else if (!collidesAt(nx, P.mesh.position.z)) {
      P.mesh.position.x = nx;
    } else if (!collidesAt(P.mesh.position.x, nz)) {
      P.mesh.position.z = nz;
    }
  }

  if (isMoving) {
    const freq = isRunning ? 9.5 : 6.0;
    const amp  = isRunning ? 0.085 : 0.042;
    BOB.t += dt * freq;
    BOB.y  = Math.sin(BOB.t) * amp;
    BOB.x  = Math.cos(BOB.t * 0.5) * amp * 0.5;
  } else {
    BOB.y += (0 - BOB.y) * (1 - Math.pow(0.02, dt));
    BOB.x += (0 - BOB.x) * (1 - Math.pow(0.02, dt));
  }

  const targetSpread = isRunning ? 1.0 : isMoving ? 0.45 : 0;
  spread += (targetSpread - spread) * (1 - Math.pow(0.01, dt));
  updateCrosshair();

  P.mesh.rotation.y = CAM.h;
  P.x = P.mesh.position.x;
  P.z = P.mesh.position.z;
  P.rotY = CAM.h;

  if (socket) {
    const now = Date.now();
    if (now - lastSendTime > CFG.sendMs) {
      socket.emit('move', { x: P.x, z: P.z, rotY: P.rotY });
      lastSendTime = now;
    }
  }
}

// ─── CAMERA ───────────────────────────────────────────────────────────────────
function tickCamera() {
  SHAKE.intensity = Math.max(0, SHAKE.intensity - 8 * (1/60));
  SHAKE.ox = (Math.random() - 0.5) * SHAKE.intensity * 0.45;
  SHAKE.oy = (Math.random() - 0.5) * SHAKE.intensity * 0.45;

  const px = P.mesh.position.x;
  const py = P.mesh.position.y;
  const pz = P.mesh.position.z;

  const pitchV = CAM.v + RECOIL.pitch;
  const dist   = CFG.camDist;
  const hDist  = Math.cos(pitchV) * dist;

  // Camera behind player with slight right-shoulder offset (OTS style)
  const rightX =  Math.cos(CAM.h) * 0.55;
  const rightZ = -Math.sin(CAM.h) * 0.55;

  const camX = px + Math.sin(CAM.h) * hDist + rightX + BOB.x + SHAKE.ox;
  const camY = py + CFG.camLookY + Math.sin(pitchV) * dist + CFG.camHeightOff + BOB.y + SHAKE.oy;
  const camZ = pz + Math.cos(CAM.h) * hDist + rightZ;

  // Look at a point AHEAD of the player — fixes crosshair targeting
  const aimDist = 16;
  const aimX = px - Math.sin(CAM.h) * aimDist;
  const aimY = py + 1.35; // head/torso height ahead
  const aimZ = pz - Math.cos(CAM.h) * aimDist;

  threeCamera.position.set(camX, camY, camZ);
  threeCamera.lookAt(aimX, aimY, aimZ);
}

// ─── SHOOTING ─────────────────────────────────────────────────────────────────
function tickShooting(dt) {
  if (P.fireT > 0) P.fireT -= dt;

  if (P.reloading) {
    P.reloadT -= dt;
    updateAmmoUI();
    if (P.reloadT <= 0) {
      P.reloading = false;
      P.ammo = CFG.maxAmmo;
      document.getElementById('reloadIndicator').style.display = 'none';
      updateAmmoUI();
    }
    return;
  }

  if (mouseDown && P.alive && P.fireT <= 0 && P.ammo > 0) doShoot();
}

function doShoot() {
  P.fireT = CFG.fireCooldown;
  P.ammo--;

  const dir = new THREE.Vector3();
  threeCamera.getWorldDirection(dir);
  const ori = threeCamera.position.clone();

  spawnTracer(ori.clone(), dir.clone(), 0xffee44);

  muzzleLight.position.set(
    P.mesh.position.x - Math.sin(CAM.h) * 1.2,
    1.1,
    P.mesh.position.z - Math.cos(CAM.h) * 1.2
  );
  muzzleLight.intensity = 7;
  muzzleTimer = 0.055;

  const mf = document.getElementById('muzzleFlash');
  mf.style.opacity = '1';
  setTimeout(() => { mf.style.opacity = '0'; }, 55);

  RECOIL.pitch += 0.032;
  CAM.v = Math.max(CFG.camVMin, CAM.v - 0.009);
  spread = Math.min(1, spread + 0.18);
  updateCrosshair();

  if (soloMode) {
    checkBotHits(ori, dir);
  } else if (socket) {
    socket.emit('shoot', {
      ox: ori.x, oy: ori.y, oz: ori.z,
      dx: dir.x, dy: dir.y, dz: dir.z,
    });
  }

  updateAmmoUI();
  if (P.ammo === 0) startReload();
}

function startReload() {
  if (P.reloading || P.ammo === CFG.maxAmmo || !P.alive) return;
  P.reloading = true;
  P.reloadT   = CFG.reloadSec;
  document.getElementById('reloadIndicator').style.display = 'flex';
  updateAmmoUI();
}

function spawnTracer(origin, dir, color) {
  const len = 2.0;
  const geo = new THREE.CylinderGeometry(0.016, 0.008, len, 4);
  geo.rotateX(Math.PI / 2);
  const mat  = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(origin).addScaledVector(dir, len / 2);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  scene.add(mesh);
  bullets.push({ mesh, dir: dir.clone().normalize(), dist: 0, mat });
}

function tickBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const step = CFG.bulletSpeed * dt;
    b.mesh.position.addScaledVector(b.dir, step);
    b.dist += step;
    b.mat.opacity = Math.max(0, 0.9 * (1 - b.dist / CFG.bulletMaxDist));
    if (b.dist > CFG.bulletMaxDist) {
      scene.remove(b.mesh);
      bullets.splice(i, 1);
    }
  }
  if (muzzleTimer > 0) {
    muzzleTimer -= 1/60;
    if (muzzleTimer <= 0) muzzleLight.intensity = 0;
  }
}

// ─── EFFECTS / HUD ────────────────────────────────────────────────────────────
function addShake(intensity) {
  SHAKE.intensity = Math.min(1, SHAKE.intensity + intensity);
}

function showHitDir(atkX, atkZ) {
  const dx = atkX - P.x;
  const dz = atkZ - P.z;
  hitDirAngle = Math.atan2(dx, dz) - CAM.h;
  hitDirAlpha = 1;
}

function showKillNotify() {
  const el = document.getElementById('killNotify');
  if (!el) return;
  killNotifyT = 1.4;
  el.classList.remove('notify-animate');
  void el.offsetWidth;
  el.classList.add('notify-animate');
}

function showHeadshotNotify() {
  const el = document.getElementById('headshotNotify');
  if (!el) return;
  el.classList.remove('notify-animate');
  void el.offsetWidth;
  el.classList.add('notify-animate');
}

function refreshHUD() {
  const fill = document.getElementById('healthFill');
  const txt  = document.getElementById('healthText');
  if (!fill) return;
  const hp = Math.max(0, P.health);
  fill.style.width      = hp + '%';
  fill.style.background = hp > 50 ? '#50c878' : hp > 25 ? '#ffcc44' : '#ff3344';
  txt.textContent = hp;
  document.getElementById('kills').textContent  = P.kills;
  document.getElementById('deaths').textContent = P.deaths;
  updateAmmoUI();
  updateStaminaUI();
}

function updateAmmoUI() {
  const el = document.getElementById('ammo');
  if (!el) return;
  if (P.reloading) {
    const pct = Math.max(0, 1 - P.reloadT / CFG.reloadSec);
    el.textContent = 'RELOADING…';
    el.style.color = '#ffcc44';
    const bar = document.getElementById('reloadBar');
    if (bar) bar.style.width = (pct * 100) + '%';
  } else {
    el.textContent = `${P.ammo} / ${CFG.maxAmmo}`;
    el.style.color = P.ammo <= 5 ? '#ff3344' : '#fff';
    const bar = document.getElementById('reloadBar');
    if (bar) bar.style.width = '0%';
  }
}

function updateStaminaUI() {
  const fill = document.getElementById('staminaFill');
  if (!fill) return;
  const pct = (P.stamina / CFG.staminaMax) * 100;
  fill.style.width = pct + '%';
  fill.style.background = !P.canSprint ? '#ff3344' : pct < 40 ? '#ffaa44' : '#4488ff';
}

function updateCrosshair() {
  const el = document.getElementById('crosshair');
  if (!el) return;
  const gap = 8 + spread * 16;
  el.style.setProperty('--gap', gap + 'px');
}

function flashDamage() {
  const el = document.getElementById('damageFlash');
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 350);
}

function hitMarkerFlash() {
  const el = document.getElementById('hitMarker');
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 180);
}

function showDeath(killerName) {
  document.getElementById('killerName').textContent = killerName || '???';
  document.getElementById('deathScreen').style.display = 'flex';
  let cd = 3;
  const timerEl = document.getElementById('respawnTimer');
  timerEl.textContent = cd;
  const iv = setInterval(() => {
    cd--;
    timerEl.textContent = Math.max(0, cd);
    if (cd <= 0) clearInterval(iv);
  }, 1000);
}

function hideDeath() {
  document.getElementById('deathScreen').style.display = 'none';
}

function addFeedEntry(msg, color) {
  const feed  = document.getElementById('killFeed');
  const entry = document.createElement('div');
  entry.className = 'kill-entry';
  entry.style.borderColor = color || '#50c878';
  entry.textContent = msg;
  feed.appendChild(entry);
  setTimeout(() => entry.classList.add('visible'), 10);
  setTimeout(() => {
    entry.classList.remove('visible');
    setTimeout(() => entry.parentNode && entry.parentNode.removeChild(entry), 400);
  }, 4500);
  while (feed.children.length > 6) feed.removeChild(feed.firstChild);
}

function updateScoreboard() {
  const tbody = document.getElementById('scoreboardBody');
  if (!tbody) return;
  const list = [{ name: 'YOU', kills: P.kills, deaths: P.deaths, color: P.color, isMe: true }];

  if (soloMode) {
    bots.forEach(b => list.push({
      name: b.name, kills: b.kills, deaths: b.deaths, color: b.color, isMe: false,
    }));
  } else {
    remotes.forEach(r => list.push({
      name: r.data.name, kills: r.data.kills || 0,
      deaths: r.data.deaths || 0, color: r.data.color, isMe: false,
    }));
  }

  list.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  tbody.innerHTML = list.map((p, i) => `
    <tr class="${p.isMe ? 'me' : ''}">
      <td class="rank">#${i+1}</td>
      <td style="color:${p.color}">${p.isMe ? '▶ YOU' : p.name}</td>
      <td>${p.kills}</td>
      <td>${p.deaths}</td>
      <td>${p.deaths ? (p.kills/p.deaths).toFixed(2) : p.kills > 0 ? '∞' : '—'}</td>
    </tr>
  `).join('');
}

// ─── MINIMAP ──────────────────────────────────────────────────────────────────
function tickMinimap() {
  if (!minimapCtx) return;
  const SIZE = 140;
  const HALF = CFG.mapHalf;
  const scale = SIZE / (HALF * 2);
  const ctx   = minimapCtx;

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = 'rgba(4, 8, 6, 0.88)';
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.strokeStyle = 'rgba(80,200,120,0.07)';
  ctx.lineWidth   = 0.5;
  for (let i = 0; i < SIZE; i += SIZE / 8) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, SIZE); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(SIZE, i); ctx.stroke();
  }

  ctx.fillStyle = 'rgba(55, 70, 60, 0.85)';
  obstacles.forEach(o => {
    const sx = (o.x + HALF) * scale - (o.w * scale) / 2;
    const sz = (o.z + HALF) * scale - (o.d * scale) / 2;
    ctx.fillRect(sx, sz, o.w * scale, o.d * scale);
  });

  if (soloMode) {
    bots.forEach(bot => {
      if (!bot.alive) return;
      const sx = (bot.x + HALF) * scale;
      const sz = (bot.z + HALF) * scale;
      ctx.fillStyle = bot.color;
      ctx.beginPath(); ctx.arc(sx, sz, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = bot.color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx, sz);
      ctx.lineTo(sx - Math.sin(bot.mesh.rotation.y) * 7, sz - Math.cos(bot.mesh.rotation.y) * 7);
      ctx.stroke();
    });
  } else {
    remotes.forEach(r => {
      if (!r.data.alive) return;
      const sx = (r.mesh.position.x + HALF) * scale;
      const sz = (r.mesh.position.z + HALF) * scale;
      ctx.fillStyle = r.data.color || '#ff4444';
      ctx.beginPath(); ctx.arc(sx, sz, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = r.data.color || '#ff4444'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx, sz);
      ctx.lineTo(sx - Math.sin(r.mesh.rotation.y) * 7, sz - Math.cos(r.mesh.rotation.y) * 7);
      ctx.stroke();
    });
  }

  const myX = (P.x + HALF) * scale;
  const myZ = (P.z + HALF) * scale;
  ctx.shadowColor = '#44ff88'; ctx.shadowBlur = 6;
  ctx.fillStyle   = '#44ff88';
  ctx.beginPath(); ctx.arc(myX, myZ, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur  = 0;

  ctx.strokeStyle = 'rgba(68,255,136,0.25)'; ctx.lineWidth = 1;
  const fovAngle  = Math.PI / 4;
  const coneLen   = 22;
  ctx.beginPath();
  ctx.moveTo(myX, myZ);
  ctx.lineTo(myX - Math.sin(CAM.h + fovAngle) * coneLen, myZ - Math.cos(CAM.h + fovAngle) * coneLen);
  ctx.moveTo(myX, myZ);
  ctx.lineTo(myX - Math.sin(CAM.h - fovAngle) * coneLen, myZ - Math.cos(CAM.h - fovAngle) * coneLen);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(80,200,120,0.35)'; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);
}

// ─── HIT DIRECTION INDICATOR ─────────────────────────────────────────────────
function tickHitDir(dt) {
  if (hitDirAlpha <= 0) return;
  hitDirAlpha = Math.max(0, hitDirAlpha - dt * 1.8);
  const el = document.getElementById('hitDir');
  if (!el) return;
  el.style.opacity   = hitDirAlpha;
  el.style.transform = `translate(-50%,-50%) rotate(${hitDirAngle}rad)`;
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (myId) {
    tickMovement(dt);
    tickShooting(dt);
    if (soloMode) {
      tickBots(dt);
    } else {
      tickRemotes();
    }
    tickBullets(dt);
    tickCamera();
    tickMinimap();
    tickHitDir(dt);

    sbUpdateTimer += dt;
    if (sbUpdateTimer > 0.5) {
      sbUpdateTimer = 0;
      updateScoreboard();
    }
  }

  renderer.render(scene, threeCamera);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
function startGame(name, solo) {
  soloMode = !!solo;

  document.getElementById('menu').style.display       = 'none';
  document.getElementById('gameCanvas').style.display = 'block';
  document.getElementById('hud').style.display        = 'block';

  initThree();
  initInput();

  if (soloMode) {
    myId = 'local_player';
    obstacles.length = 0;
    obstacles.push(...SOLO_OBSTACLES);
    buildObstacles();
    applyColor(P.mesh, '#44ff88');
    initBots(5);
    refreshHUD();
    addFeedEntry('SOLO MODE — 5 enemies deployed', '#44ff88');
  } else {
    initSocket(name);
  }

  loop();
}

window.addEventListener('DOMContentLoaded', () => {
  const btn     = document.getElementById('playBtn');
  const soloBtn = document.getElementById('soloBtn');
  const input   = document.getElementById('playerName');

  const go = (solo) => {
    const n = input.value.trim().slice(0, 16) || 'Ghost';
    startGame(n, solo);
  };

  btn.addEventListener('click',   () => go(false));
  soloBtn.addEventListener('click', () => go(true));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(false); });
});
