# Hosting Penguin Tag VR (website + APK)

## 1. Website files (put these on a host)

Upload the contents of the `web-deploy/` folder to any static host **or**
run the included Node server which serves the client + WebSocket multiplayer.

### Option A – Full game (recommended)
```bash
node server/index.js
```
Serve that process behind HTTPS (Railway / Render / Fly / nginx + certbot).

### Option B – Static client only
Upload `web-deploy/` to Netlify, Cloudflare Pages, GitHub Pages, etc.
Then point the client at your multiplayer server with:
```
https://your-static-site.com/?server=wss://your-game-server.com
```

## 2. Make an APK that opens the game

On your Windows PC (in the project folder):

```powershell
cd D:\downloads\PenguinVR\PenguinVR
.\scripts\create-quest-apk.ps1 -GameUrl "https://YOUR-REAL-HTTPS-URL"
```

Then:
1. Install Android Studio
2. Open the generated `apk-wrapper\android` folder
3. Build → Build APK
4. Sideload to Quest with SideQuest or adb

The APK will request network + microphone permissions (Meta permission prompts).

## Reality check
- Best VR experience: open the HTTPS URL in **Meta Quest Browser** → Enter VR
- APK = convenient launcher + permission prompts; immersive WebXR inside WebView can be limited by Quest OS
