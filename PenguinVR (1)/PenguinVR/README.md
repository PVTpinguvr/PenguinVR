# 🐧 Penguin Tag VR

Free, open, Gorilla-Tag-style **penguin** multiplayer VR experience built with **WebXR + Three.js + Cannon-es** and a zero-dependency Node server.

## What works now

- **WebXR first-person** on Meta Quest 3 / 3S (via Meta Browser)
- **Hand-powered locomotion** (grip + push / climb, no joysticks)
- **Penguin avatars** (black/white body, wings, beak, eyes)
- **5 maps**: Iceberg Island, Penguin Village, Arctic Forest, Volcano Island, Underwater World
- **Real multiplayer** over WebSockets (public rooms + room codes)
- **Permanent first-player owner** system + exclusive Penguin Staff + crown
- **Owner admin actions** (kick/ban, change mode/map, start rounds) – server-verified
- **Report system** + moderation actions for owner
- **Penguin Bucks (PB)** + free cosmetic shop catalog (hats, scarves, trails, companions…)
- **Game modes** framework: Tag, Infection, Freeze, Casual, etc.
- **WebRTC signaling** ready for proximity voice (client can complete peer connections)
- Desktop preview (limited WASD) for testing without headset

## What is intentionally limited / honest status

| Feature | Status |
|---------|--------|
| Core VR movement | Working prototype – tune for feel |
| Full Gorilla Tag physics polish | Needs more contact sampling & surface normals |
| Proximity voice (actual audio) | Signaling is live; full WebRTC mesh + gain by distance is scaffolded |
| Spatial VR menus (shop/owner/report) | DOM/prompt based; true floating 3D panels are next |
| Native Quest APK | **WebXR PWA / browser is the supported free path.** A true native APK with full OpenXR requires Android SDK + Meta packages not available in this free toolchain without extra setup. Scripts document how to wrap. |
| Anti-cheat | Basic server authority on positions/tags; advanced detection not included |
| Seasonal events / full daily rewards | Data structures present; timers & UI partial |

## Quick start

```bash
cd PenguinVR
node server/index.js
```

Open `http://localhost:8080` on a Quest browser (or desktop for preview).

First real player to connect **permanently becomes the owner** and receives the Penguin Staff + crown.

## Project layout

```
PenguinVR/
  client/          WebXR front-end (Three.js)
  server/          Zero-dep Node multiplayer + persistence
  server/data/     JSON stores (owner, players, bans, reports)
  scripts/         Build / helper scripts
  output/          Place for packaged artifacts
  docs/
```

## Controls (VR)

- **Grip / Trigger** while pushing hands against floor or walls → move
- Move hands down while gripping high → climb / pull up
- Momentum, sliding and bouncing emerge from physics

## Currency & cosmetics

Everything is earned with **Penguin Bucks**. No real-money, no Robux, no premium currency.

## Hosting notes

- Free tiers (Railway, Render, Fly.io free, local, etc.) work for the Node server.
- For production HTTPS + WSS is required for WebXR on Quest.
- Be honest about free-tier connection limits.

## License

MIT – free for everyone.
