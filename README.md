# 🎮 TACTICAL OPS

A **real-time 3D third-person multiplayer shooter** built with Three.js + Socket.io.  
Inspired by Counter-Strike — tactical, hitscan combat with a clean military HUD.

---

## ✨ Features

- **Third-person 3D perspective** with spring-arm camera
- **Real-time multiplayer** via Socket.io (supports many concurrent players)
- **Hitscan shooting** — server-authoritative hit detection
- **Health + respawn system** (3-second countdown)
- **Kill feed, scoreboard (Tab), K/D tracking**
- **Tactical arena map** with crates, walls & cover
- **Procedural textures** — no external assets required
- **Muzzle flash & bullet tracers**
- **Sprint (Shift), Reload (R)**

---

## 🕹️ Controls

| Key | Action |
|---|---|
| `WASD` / Arrow Keys | Move |
| Mouse | Aim / Look around |
| Left Click | Shoot |
| `Shift` + WASD | Sprint |
| `R` | Reload |
| `Tab` | Scoreboard |
| `Esc` | Release mouse |

---

## 🚀 Running Locally

```bash
# 1. Clone / download the repo
git clone https://github.com/YOUR_USER/tactical-ops.git
cd tactical-ops

# 2. Install dependencies
npm install

# 3. Start the server
npm start
# or for hot-reload during development:
npm run dev

# 4. Open http://localhost:3000 in your browser
# Open multiple tabs to test multiplayer!
```

---

## ☁️ Deploying to Railway

### Option A — Railway Dashboard (recommended)

1. Push your code to a GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin https://github.com/YOUR_USER/tactical-ops.git
   git push -u origin main
   ```

2. Go to **[railway.app](https://railway.app)** → **New Project** → **Deploy from GitHub repo**

3. Select your repository.

4. Railway auto-detects Node.js and runs `npm start`. No config needed!

5. Click **Generate Domain** in the Settings tab to get a public URL.

### Option B — Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway domain
```

### Environment Variables (optional)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port (Railway sets this automatically) |

---

## 🗂️ Project Structure

```
tactical-ops/
├── server.js          # Express + Socket.io game server
├── package.json
├── public/
│   ├── index.html     # Menu screen + HUD layout
│   ├── game.js        # Three.js game engine + networking
│   └── style.css      # Military HUD + menu design
└── README.md
```

---

## 🔧 Customisation

- **`server.js`** — Change `BULLET_DMG`, `PLAYER_HP`, `RESPAWN_MS`, add new obstacles to `OBSTACLES[]`
- **`public/game.js`** — Tune `CFG` object at the top (speed, camera distance, fire rate, etc.)
- **`OBSTACLES` array** — Same array used on server AND client — edit once in `server.js`, it's sent to clients on join

---

## 📦 Tech Stack

| Layer | Library |
|---|---|
| 3D Rendering | [Three.js r128](https://threejs.org) |
| Networking | [Socket.io 4](https://socket.io) |
| Server | Node.js + Express |
| Deployment | [Railway](https://railway.app) |

---

## ⚡ Performance Tips

- For production, enable **Railway's HTTP/2** via their dashboard
- The server runs at **20 tick/s** — increase `TICK_RATE` in `server.js` for smoother play (uses more CPU)
- Three.js uses **PCF soft shadows** — disable `renderer.shadowMap.enabled` for max performance

---

MIT License — free to use and modify.
