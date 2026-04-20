// ═══════════════════════════════════════════════════════════════════════════
//  TACTICAL OPS  –  game.js
//  Three.js r128  ·  Socket.io client
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const CFG = {
  moveSpeed:      7,
  runSpeed:       12,
  camDist:        5.8,      // distance of camera behind player
  camHeightOff:   1.5,      // extra height added to orbit height
  camLookY:       1.1,      // look-at Y offset above player feet
  camVMin:        0.08,
  camVMax:        1.05,
  sensitivity:    0.0022,
  sendMs:         50,       // network send rate (ms)
  bulletSpeed:    90,
  bulletMaxDist:  75,
  fireCooldown:   0.11,     // seconds between shots
  maxAmmo:        30,
  reloadSec:      2.0,
  mapHalf:        24,
  playerR:        0.52,     // collision radius
  interp:         0.22,     // remote player lerp factor
};

// ─── GLOBALS ─────────────────────────────────────────────────────────────────
let socket, myId;
let scene, renderer, threeCamera, clock;
let muzzleLight, muzzleTimer = 0;
let lastSendTime = 0;

const keys       = {};
const obstacles  = [];        // received from server
const remotes    = new Map(); // id → { data, mesh, target }
const bullets    = [];        // active bullet tracers
let   mdX = 0, mdY = 0;      // accumulated mouse delta
let   isLocked  = false;
let   mouseDown = false;

// Player state
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
};

// Camera angles
const CAM = { h: 0, v: 0.38 };

// ─── SOCKET ───────────────────────────────────────────────────────────────────
function initSocket(name) {
  socket = io({ reconnectionAttempts: 10 });

  socket.on('connect', () => {
    socket.emit('join', { name });
  });

  socket.on('init', (d) => {
    myId = d.id;

    // Store obstacles, rebuild map
    obstacles.length = 0;
    obstacles.push(...d.obstacles);
    buildObstacles();

    // Init existing players
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

    // Hide lock prompt briefly (user needs to click)
    refreshHUD();
  });

  socket.on('playerJoined',    addRemote);
  socket.on('playerLeft',      removeRemote);

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

  socket.on('hit', ({ health }) => {
    P.health = health;
    refreshHUD();
    flashDamage();
    hitMarkerFlash();
  });

  socket.on('playerDied', ({ id }) => {
    if (id === myId) {
      P.alive = false; P.health = 0;
      showDeath('…');
      refreshHUD();
    }
    const r = remotes.get(id);
    if (r) r.mesh.visible = false;
  });

  socket.on('respawn', ({ x, y, z, health }) => {
    P.alive = true; P.health = health;
    P.x = x; P.y = y; P.z = z;
    P.ammo      = CFG.maxAmmo;
    P.reloading = false;
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
    if (kId === myId) { P.kills = kills; refreshHUD(); }
    if (vId === myId) { P.deaths = deaths; refreshHUD(); }
    const rk = remotes.get(kId); if (rk) rk.data.kills  = kills;
    const rv = remotes.get(vId); if (rv) rv.data.deaths  = deaths;
    updateScoreboard();
  });

  socket.on('killFeed', ({ msg, color, killerColor }) => {
    addFeedEntry(msg, killerColor || color || '#aaa');
  });
}

// ─── THREE.JS INIT ────────────────────────────────────────────────────────────
function initThree() {
  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141820);
  scene.fog = new THREE.FogExp2(0x141820, 0.018);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  document.getElementById('gameCanvas').appendChild(renderer.domElement);

  // Camera
  threeCamera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 200);

  clock = new THREE.Clock();

  // Lighting
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

  // Local player
  P.mesh = buildCharacter('#44ff88');
  scene.add(P.mesh);

  // Static map geometry (floor, walls) — obstacles added after server sends list
  buildStaticMap();

  window.addEventListener('resize', () => {
    threeCamera.aspect = innerWidth / innerHeight;
    threeCamera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

// ─── MAP BUILDING ─────────────────────────────────────────────────────────────
function buildStaticMap() {
  // Floor
  const floorMat = new THREE.MeshLambertMaterial({ map: makeFloorTex() });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50, 1, 1), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Outer walls
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

  // Ground spawn circles
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
  const c = mkCanvas(512);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2c2c2c';
  ctx.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 64)
    for (let x = 0; x < 512; x += 64) {
      const v = 38 + ((x+y)/128|0)%2*6;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x+1, y+1, 62, 62);
    }
  ctx.strokeStyle = '#1e1e1e'; ctx.lineWidth = 2;
  for (let i = 0; i <= 512; i+=64) {
    ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i,512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,i); ctx.lineTo(512,i); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(8, 8);
  return t;
}

function makeWallTex() {
  const c = mkCanvas(256);
  const ctx = c.getContext('2d');
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
  const c = mkCanvas(256);
  const ctx = c.getContext('2d');
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

  const bodyMat  = new THREE.MeshLambertMaterial({ color });
  const darkMat  = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
  const skinMat  = new THREE.MeshLambertMaterial({ color: 0xffccaa });
  const helmMat  = new THREE.MeshLambertMaterial({ color: 0x222222 });

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
  torso.position.y = 1.25;
  torso.castShadow = true;
  g.add(torso);

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 10, 8), skinMat);
  head.position.y = 1.84;
  head.castShadow = true;
  g.add(head);

  // Helmet (upper half sphere)
  const helm = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 10, 8, 0, Math.PI*2, 0, Math.PI*0.52),
    helmMat
  );
  helm.position.y = 1.84;
  g.add(helm);

  // Gun body
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.68), darkMat);
  gun.position.set(0.44, 1.12, -0.22);
  gun.castShadow = true;
  g.add(gun);

  // Barrel
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.28, 6), darkMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0.44, 1.12, -0.68);
  g.add(barrel);

  // Name tag
  if (name) {
    g.add(makeNameSprite(name));
  }

  return g;
}

function applyColor(mesh, color) {
  mesh.traverse(c => {
    if (c.isMesh && c.geometry.type !== 'SphereGeometry') {
      if (c.material.color.getHexString() !== '1a1a1a' &&
          c.material.color.getHexString() !== 'ffccaa' &&
          c.material.color.getHexString() !== '222222') {
        c.material = c.material.clone();
        c.material.color.set(color);
      }
    }
  });
}

function makeNameSprite(name) {
  const w = 256, h = 44;
  const c = mkCanvas(w); c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(name.slice(0, 16), w/2, 30);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c),
    depthTest: false,
    transparent: true,
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
    data,
    mesh,
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
    // Smooth rotation
    const diff = target.rotY - mesh.rotation.y;
    mesh.rotation.y += diff * 0.2;
  });
}

// ─── INPUT ────────────────────────────────────────────────────────────────────
function initInput() {
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'r' && P.alive && !P.reloading && P.ammo < CFG.maxAmmo) startReload();
    if (e.key === 'Tab') { e.preventDefault(); document.getElementById('scoreboard').style.display = 'block'; }
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

// ─── MOVEMENT ─────────────────────────────────────────────────────────────────
function tickMovement(dt) {
  if (!P.alive) return;

  // Camera look from mouse
  CAM.h -= mdX * CFG.sensitivity;
  CAM.v -= mdY * CFG.sensitivity;
  CAM.v  = Math.max(CFG.camVMin, Math.min(CFG.camVMax, CAM.v));
  mdX = 0; mdY = 0;

  // Directional vectors (relative to camera yaw)
  const sh = Math.sin(CAM.h), ch = Math.cos(CAM.h);
  const fwdX = -sh, fwdZ = -ch;
  const rgtX =  ch, rgtZ = -sh;

  let mx = 0, mz = 0;
  if (keys['w'] || keys['arrowup'])    { mx += fwdX; mz += fwdZ; }
  if (keys['s'] || keys['arrowdown'])  { mx -= fwdX; mz -= fwdZ; }
  if (keys['a'] || keys['arrowleft'])  { mx -= rgtX; mz -= rgtZ; }
  if (keys['d'] || keys['arrowright']) { mx += rgtX; mz += rgtZ; }

  if (mx !== 0 || mz !== 0) {
    const len = Math.sqrt(mx*mx + mz*mz);
    const spd = (keys['shift'] ? CFG.runSpeed : CFG.moveSpeed) * dt / len;
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

  // Character faces camera direction
  P.mesh.rotation.y = CAM.h;

  // Sync state
  P.x = P.mesh.position.x;
  P.z = P.mesh.position.z;
  P.rotY = CAM.h;

  // Network send
  const now = Date.now();
  if (now - lastSendTime > CFG.sendMs) {
    socket.emit('move', { x: P.x, z: P.z, rotY: P.rotY });
    lastSendTime = now;
  }
}

// ─── CAMERA ───────────────────────────────────────────────────────────────────
function tickCamera() {
  const lx = P.mesh.position.x;
  const ly = P.mesh.position.y + CFG.camLookY;
  const lz = P.mesh.position.z;

  const dist = CFG.camDist;
  const cv   = CAM.v, ch = CAM.h;
  const hDist = Math.cos(cv) * dist;

  const cx = lx + Math.sin(ch) * hDist;
  const cy = ly + Math.sin(cv) * dist + CFG.camHeightOff;
  const cz = lz + Math.cos(ch) * hDist;

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

  // Ray from camera center
  const dir = new THREE.Vector3();
  threeCamera.getWorldDirection(dir);
  const ori = threeCamera.position.clone();

  // Visual tracer
  spawnTracer(ori.clone(), dir.clone(), 0xffee44);

  // Muzzle flash light
  muzzleLight.position.set(
    P.mesh.position.x + Math.sin(CAM.h + Math.PI) * 1.2,
    1.1,
    P.mesh.position.z + Math.cos(CAM.h + Math.PI) * 1.2
  );
  muzzleLight.intensity = 5;
  muzzleTimer = 0.06;

  // Screen flash
  const mf = document.getElementById('muzzleFlash');
  mf.style.opacity = '1';
  setTimeout(() => { mf.style.opacity = '0'; }, 60);

  // Send to server
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
  document.getElementById('reloadIndicator').style.display = 'block';
  updateAmmoUI();
}

function spawnTracer(origin, dir, color) {
  const len = 1.8;
  const geo = new THREE.CylinderGeometry(0.018, 0.018, len, 4);
  geo.rotateX(Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
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
    b.mat.opacity = Math.max(0, 0.85 * (1 - b.dist / CFG.bulletMaxDist));
    if (b.dist > CFG.bulletMaxDist) {
      scene.remove(b.mesh);
      bullets.splice(i, 1);
    }
  }

  // Muzzle light fade
  if (muzzleTimer > 0) {
    muzzleTimer -= dt;
    if (muzzleTimer <= 0) muzzleLight.intensity = 0;
  }
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function refreshHUD() {
  const fill = document.getElementById('healthFill');
  const txt  = document.getElementById('healthText');
  if (!fill) return;
  const hp = Math.max(0, P.health);
  fill.style.width      = hp + '%';
  fill.style.background = hp > 50 ? '#50c878' : hp > 25 ? '#ffcc44' : '#ff3344';
  txt.textContent       = hp;
  document.getElementById('kills').textContent  = P.kills;
  document.getElementById('deaths').textContent = P.deaths;
  updateAmmoUI();
}

function updateAmmoUI() {
  const el = document.getElementById('ammo');
  if (!el) return;
  if (P.reloading) {
    el.textContent  = 'RELOADING…';
    el.style.color  = '#ffcc44';
  } else {
    el.textContent  = `${P.ammo} / ${CFG.maxAmmo}`;
    el.style.color  = P.ammo <= 5 ? '#ff3344' : '#fff';
  }
}

function flashDamage() {
  const el = document.getElementById('damageFlash');
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 350);
}

function hitMarkerFlash() {
  const el = document.getElementById('hitMarker');
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 200);
}

function showDeath(killer) {
  document.getElementById('killerName').textContent = killer || '???';
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

  const list = [{
    name: 'YOU', kills: P.kills, deaths: P.deaths, color: P.color, isMe: true
  }];
  remotes.forEach(r => list.push({
    name:   r.data.name,
    kills:  r.data.kills  || 0,
    deaths: r.data.deaths || 0,
    color:  r.data.color,
    isMe:   false,
  }));
  list.sort((a, b) => b.kills - a.kills);

  tbody.innerHTML = list.map(p => `
    <tr class="${p.isMe ? 'me' : ''}">
      <td style="color:${p.color}">${p.name}</td>
      <td>${p.kills}</td>
      <td>${p.deaths}</td>
      <td>${p.deaths ? (p.kills/p.deaths).toFixed(2) : p.kills.toFixed(2)}</td>
    </tr>
  `).join('');
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
    updateScoreboard();
  }

  renderer.render(scene, threeCamera);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
function startGame(name) {
  document.getElementById('menu').style.display        = 'none';
  document.getElementById('gameCanvas').style.display  = 'block';
  document.getElementById('hud').style.display         = 'block';

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
