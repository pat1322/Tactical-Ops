// ═══════════════════════════════════════════════════════════════════════════
//  TACTICAL OPS  –  game.js  v2
//  Three.js r128  ·  Socket.io client
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CFG = {
  moveSpeed:      6.5,
  runSpeed:       11.5,
  camDist:        5.5,
  camHeightOff:   1.6,
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

// ─── GLOBALS ──────────────────────────────────────────────────────────────────
let socket, myId;
let scene, renderer, threeCamera, clock;
let muzzleLight, muzzleTimer = 0;
let lastSendTime   = 0;
let sbUpdateTimer  = 0;
let minimapCtx     = null;

const keys      = {};
const obstacles = [];
const remotes   = new Map();
const bullets   = [];
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
const BOB    = { x: 0, y: 0, t: 0 };           // head bob
const RECOIL = { pitch: 0, recovery: 0 };       // gun recoil
const SHAKE  = { intensity: 0, ox: 0, oy: 0 }; // damage shake

// ── Effects ───────────────────────────────────────────────────────────────────
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
    // Directional hit indicator
    if (atkX !== undefined) {
      showHitDir(atkX, atkZ);
    } else if (atkId) {
      const r = remotes.get(atkId);
      if (r) showHitDir(r.mesh.position.x, r.mesh.position.z);
    }
  });

  // Shooter-side hit confirmation with headshot flash
  socket.on('shotHit', ({ headshot }) => {
    if (headshot) {
      headshotT = 0.8;
      showHeadshotNotify();
    } else {
      hitMarkerFlash();
    }
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
  scene.fog = new THREE.FogExp2(0x141820, 0.018);

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

  scene.add(new THREE.AmbientLight(0x304050, 0.8));

  const sun = new THREE.DirectionalLight(0xfff0d0, 1.4);
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

  muzzleLight = new THREE.PointLight(0xff8800, 0, 8, 2);
  scene.add(muzzleLight);

  P.mesh = buildCharacter('#44ff88');
  scene.add(P.mesh);

  buildStaticMap();

  // Minimap
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
  const floorMat = new THREE.MeshLambertMaterial({ map: makeFloorTex() });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const wallMat = new THREE.MeshLambertMaterial({ color: 0x1c2030, map: makeWallTex() });
  const ms = 25, wh = 5;
  [
    [[0, wh/2, -ms], [50, wh, 1]],
    [[0, wh/2,  ms], [50, wh, 1]],
    [[-ms, wh/2, 0], [1, wh, 50]],
    [[ ms, wh/2, 0], [1, wh, 50]],
  ].forEach(([pos, size]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), wallMat);
    m.position.set(...pos);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  });

  const markMat = new THREE.MeshLambertMaterial({ color: 0x1a3a1a });
  [[-20,-20],[20,-20],[-20,20],[20,20]].forEach(([x,z]) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 0.04, 20), markMat);
    c.position.set(x, 0.02, z);
    scene.add(c);
  });
}

function buildObstacles() {
  const boxMat = new THREE.MeshLambertMaterial({ map: makeCrateTex() });
  obstacles.forEach(o => {
    const h = o.h || 2;
    const m = new THREE.Mesh(new THREE.BoxGeometry(o.w, h, o.d), boxMat);
    m.position.set(o.x, h / 2, o.z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  });
}

// ─── PROCEDURAL TEXTURES ─────────────────────────────────────────────────────
function makeFloorTex() {
  const c = mkCanvas(512), ctx = c.getContext('2d');
  ctx.fillStyle = '#2c2c2c';
  ctx.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 64)
    for (let x = 0; x < 512; x += 64) {
      const v = 38 + ((x+y)/128|0)%2*6;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x+1, y+1, 62, 62);
    }
  ctx.strokeStyle = '#1e1e1e'; ctx.lineWidth = 2;
  for (let i = 0; i <= 512; i += 64) {
    ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i,512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,i); ctx.lineTo(512,i); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(8, 8);
  return t;
}

function makeWallTex() {
  const c = mkCanvas(256), ctx = c.getContext('2d');
  ctx.fillStyle = '#1c2030'; ctx.fillRect(0,0,256,256);
  ctx.fillStyle = '#171c28';
  for (let y = 0; y < 256; y += 32)
    for (let x = (y/32|0)%2*16; x < 256; x += 32)
      ctx.fillRect(x+1, y+1, 30, 15);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  return t;
}

function makeCrateTex() {
  const c = mkCanvas(256), ctx = c.getContext('2d');
  ctx.fillStyle = '#4a3a28'; ctx.fillRect(0,0,256,256);
  ctx.strokeStyle = '#2e221a'; ctx.lineWidth = 10;
  ctx.strokeRect(5,5,246,246);
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(128,5); ctx.lineTo(128,251); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(5,128); ctx.lineTo(251,128); ctx.stroke();
  ctx.strokeStyle = '#5a4a36'; ctx.lineWidth = 2;
  for (let y = 20; y < 256; y += 18) {
    ctx.beginPath(); ctx.moveTo(0, y + Math.sin(y)*3); ctx.lineTo(256, y); ctx.stroke();
  }
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
  const bodyMat = new THREE.MeshLambertMaterial({ color });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xffccaa });
  const helmMat = new THREE.MeshLambertMaterial({ color: 0x222222 });

  // Legs
  const legGeo = new THREE.CylinderGeometry(0.18, 0.16, 0.9, 8);
  [-0.18, 0.18].forEach(ox => {
    const leg = new THREE.Mesh(legGeo, bodyMat);
    leg.position.set(ox, 0.45, 0);
    leg.castShadow = true;
    g.add(leg);
  });
  // Torso
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.32, 0.9, 8), bodyMat);
  torso.position.y = 1.25; torso.castShadow = true;
  g.add(torso);
  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 10, 8), skinMat);
  head.position.y = 1.84; head.castShadow = true;
  g.add(head);
  // Helmet
  const helm = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 10, 8, 0, Math.PI*2, 0, Math.PI*0.52), helmMat
  );
  helm.position.y = 1.84;
  g.add(helm);
  // Gun body
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.68), darkMat);
  gun.position.set(0.44, 1.12, -0.22); gun.castShadow = true;
  g.add(gun);
  // Barrel
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.28, 6), darkMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0.44, 1.12, -0.68);
  g.add(barrel);

  if (name) g.add(makeNameSprite(name));
  return g;
}

function applyColor(mesh, color) {
  mesh.traverse(c => {
    if (!c.isMesh) return;
    const hex = c.material.color.getHexString();
    if (hex !== '1a1a1a' && hex !== 'ffccaa' && hex !== '222222') {
      c.material = c.material.clone();
      c.material.color.set(color);
    }
  });
}

function makeNameSprite(name) {
  const w = 256, h = 44;
  const c = mkCanvas(w); c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(name.slice(0, 16), w/2, 30);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), depthTest: false, transparent: true,
  }));
  spr.scale.set(2.2, 0.42, 1);
  spr.position.y = 2.4;
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
    // Smooth rotation with wraparound
    let diff = target.rotY - mesh.rotation.y;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    mesh.rotation.y += diff * 0.18;
  });
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
    // Toggle class so CSS can manage the canvas cursor
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

  // Apply accumulated mouse delta
  CAM.h -= mdX * CFG.sensitivity;
  CAM.v -= mdY * CFG.sensitivity;
  CAM.v  = Math.max(CFG.camVMin, Math.min(CFG.camVMax, CAM.v));
  mdX = 0; mdY = 0;

  // Recoil recovery
  if (RECOIL.pitch > 0) {
    const recovery = dt * 5.5;
    RECOIL.pitch = Math.max(0, RECOIL.pitch - recovery);
    CAM.v = Math.min(CFG.camVMax, CAM.v + recovery * 0.6); // gradually restore aim
  }

  // Direction vectors from camera yaw
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

  // ── Stamina ────────────────────────────────────────────────────────────────
  if (isRunning) {
    P.stamina = Math.max(0, P.stamina - CFG.staminaDrain * dt);
    if (P.stamina === 0) P.canSprint = false;
  } else {
    P.stamina = Math.min(CFG.staminaMax, P.stamina + CFG.staminaRegen * dt);
    if (!P.canSprint && P.stamina >= CFG.staminaRunMin) P.canSprint = true;
  }
  updateStaminaUI();

  // ── Apply movement ─────────────────────────────────────────────────────────
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

  // ── Camera bob ─────────────────────────────────────────────────────────────
  if (isMoving) {
    const freq = isRunning ? 9.5 : 6.0;
    const amp  = isRunning ? 0.085 : 0.042;
    BOB.t += dt * freq;
    BOB.y  = Math.sin(BOB.t) * amp;
    BOB.x  = Math.cos(BOB.t * 0.5) * amp * 0.5;
  } else {
    // Settle to zero
    BOB.y += (0 - BOB.y) * (1 - Math.pow(0.02, dt));
    BOB.x += (0 - BOB.x) * (1 - Math.pow(0.02, dt));
  }

  // ── Crosshair spread from movement ────────────────────────────────────────
  const targetSpread = isRunning ? 1.0 : isMoving ? 0.45 : 0;
  spread += (targetSpread - spread) * (1 - Math.pow(0.01, dt));
  updateCrosshair();

  P.mesh.rotation.y = CAM.h;
  P.x = P.mesh.position.x;
  P.z = P.mesh.position.z;
  P.rotY = CAM.h;

  const now = Date.now();
  if (now - lastSendTime > CFG.sendMs) {
    socket.emit('move', { x: P.x, z: P.z, rotY: P.rotY });
    lastSendTime = now;
  }
}

// ─── CAMERA ───────────────────────────────────────────────────────────────────
function tickCamera() {
  // Shake decay
  SHAKE.intensity = Math.max(0, SHAKE.intensity - 8 * (1/60));
  SHAKE.ox = (Math.random() - 0.5) * SHAKE.intensity * 0.45;
  SHAKE.oy = (Math.random() - 0.5) * SHAKE.intensity * 0.45;

  const lx = P.mesh.position.x;
  const ly = P.mesh.position.y + CFG.camLookY;
  const lz = P.mesh.position.z;

  const pitchV = CAM.v + RECOIL.pitch;
  const dist   = CFG.camDist;
  const hDist  = Math.cos(pitchV) * dist;

  const cx = lx + Math.sin(CAM.h) * hDist + BOB.x + SHAKE.ox;
  const cy = ly + Math.sin(pitchV) * dist  + CFG.camHeightOff + BOB.y + SHAKE.oy;
  const cz = lz + Math.cos(CAM.h) * hDist;

  threeCamera.position.set(cx, cy, cz);
  threeCamera.lookAt(lx, ly, lz);
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

  // Muzzle flash light
  muzzleLight.position.set(
    P.mesh.position.x + Math.sin(CAM.h + Math.PI) * 1.2,
    1.1,
    P.mesh.position.z + Math.cos(CAM.h + Math.PI) * 1.2
  );
  muzzleLight.intensity = 7;
  muzzleTimer = 0.055;

  const mf = document.getElementById('muzzleFlash');
  mf.style.opacity = '1';
  setTimeout(() => { mf.style.opacity = '0'; }, 55);

  // Recoil: kick camera up, recover in tickMovement
  RECOIL.pitch += 0.032;
  CAM.v = Math.max(CFG.camVMin, CAM.v - 0.009);

  // Spread spike
  spread = Math.min(1, spread + 0.18);
  updateCrosshair();

  socket.emit('shoot', {
    ox: ori.x, oy: ori.y, oz: ori.z,
    dx: dir.x, dy: dir.y, dz: dir.z,
  });

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
  void el.offsetWidth; // reflow
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
  if (!P.canSprint) {
    fill.style.background = '#ff3344';
  } else if (pct < 40) {
    fill.style.background = '#ffaa44';
  } else {
    fill.style.background = '#4488ff';
  }
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
  remotes.forEach(r => list.push({
    name: r.data.name, kills: r.data.kills || 0,
    deaths: r.data.deaths || 0, color: r.data.color, isMe: false,
  }));
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

  // Subtle grid
  ctx.strokeStyle = 'rgba(80,200,120,0.07)';
  ctx.lineWidth   = 0.5;
  for (let i = 0; i < SIZE; i += SIZE / 8) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, SIZE); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(SIZE, i); ctx.stroke();
  }

  // Obstacles
  ctx.fillStyle = 'rgba(55, 70, 60, 0.85)';
  obstacles.forEach(o => {
    const sx = (o.x + HALF) * scale - (o.w * scale) / 2;
    const sz = (o.z + HALF) * scale - (o.d * scale) / 2;
    ctx.fillRect(sx, sz, o.w * scale, o.d * scale);
  });

  // Remote players
  remotes.forEach(r => {
    if (!r.data.alive) return;
    const sx = (r.mesh.position.x + HALF) * scale;
    const sz = (r.mesh.position.z + HALF) * scale;
    ctx.fillStyle = r.data.color || '#ff4444';
    ctx.beginPath(); ctx.arc(sx, sz, 3.5, 0, Math.PI * 2); ctx.fill();
    // Direction tick
    ctx.strokeStyle = r.data.color || '#ff4444';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, sz);
    ctx.lineTo(sx - Math.sin(r.mesh.rotation.y) * 7, sz - Math.cos(r.mesh.rotation.y) * 7);
    ctx.stroke();
  });

  // Local player — always draw last (on top)
  const myX = (P.x + HALF) * scale;
  const myZ = (P.z + HALF) * scale;

  ctx.shadowColor = '#44ff88';
  ctx.shadowBlur  = 6;
  ctx.fillStyle   = '#44ff88';
  ctx.beginPath(); ctx.arc(myX, myZ, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur  = 0;

  // Camera FOV cone (subtle)
  ctx.strokeStyle = 'rgba(68,255,136,0.25)';
  ctx.lineWidth   = 1;
  const fovAngle  = Math.PI / 4;
  const coneLen   = 22;
  ctx.beginPath();
  ctx.moveTo(myX, myZ);
  ctx.lineTo(
    myX - Math.sin(CAM.h + fovAngle) * coneLen,
    myZ - Math.cos(CAM.h + fovAngle) * coneLen
  );
  ctx.moveTo(myX, myZ);
  ctx.lineTo(
    myX - Math.sin(CAM.h - fovAngle) * coneLen,
    myZ - Math.cos(CAM.h - fovAngle) * coneLen
  );
  ctx.stroke();

  // Border
  ctx.strokeStyle = 'rgba(80,200,120,0.35)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);
}

// ─── HIT DIRECTION INDICATOR ─────────────────────────────────────────────────
function tickHitDir(dt) {
  if (hitDirAlpha <= 0) return;
  hitDirAlpha = Math.max(0, hitDirAlpha - dt * 1.8);

  const el = document.getElementById('hitDir');
  if (!el) return;
  el.style.opacity   = hitDirAlpha;
  // Update angle continuously as player turns
  const worldAngle   = hitDirAngle + CAM.h; // store world-space on hit
  el.style.transform = `translate(-50%,-50%) rotate(${hitDirAngle}rad)`;
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (myId) {
    tickMovement(dt);
    tickShooting(dt);
    tickRemotes();
    tickBullets(dt);
    tickCamera();
    tickMinimap();
    tickHitDir(dt);

    // Throttle non-critical scoreboard rebuild
    sbUpdateTimer += dt;
    if (sbUpdateTimer > 0.5) {
      sbUpdateTimer = 0;
      updateScoreboard();
    }
  }

  renderer.render(scene, threeCamera);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
function startGame(name) {
  document.getElementById('menu').style.display       = 'none';
  document.getElementById('gameCanvas').style.display = 'block';
  document.getElementById('hud').style.display        = 'block';

  initThree();
  initInput();
  initSocket(name);
  refreshHUD();
  loop();
}

window.addEventListener('DOMContentLoaded', () => {
  const btn   = document.getElementById('playBtn');
  const input = document.getElementById('playerName');
  const go = () => {
    const n = input.value.trim().slice(0, 16) || 'Ghost';
    startGame(n);
  };
  btn.addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
});
