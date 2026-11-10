<#
.SYNOPSIS
  Creates an Android APK wrapper that opens Penguin Tag VR and requests permissions.

.DESCRIPTION
  This builds a Capacitor Android app whose WebView loads your hosted game URL.
  On Quest it will prompt for internet + microphone permissions.

  IMPORTANT LIMITS (honest):
  - Immersive WebXR works BEST in the Meta Quest Browser.
  - A WebView APK can load the game and request permissions, but full immersive
    VR sessions inside third-party WebViews are often restricted by Meta.
  - This script still produces a real installable APK launcher.

.PARAMETER GameUrl
  HTTPS URL where the game is hosted (required for production).
  Example: https://your-app.railway.app

.PARAMETER OutputDir
  Where to put the generated Capacitor project (default: .\apk-wrapper)
#>

param(
  [Parameter(Mandatory=$false)]
  [string]$GameUrl = "https://YOUR-GAME-HOST.example",

  [string]$OutputDir = ".\apk-wrapper"
)

$ErrorActionPreference = "Stop"
Write-Host "=== Penguin Tag VR – APK Wrapper Generator ===" -ForegroundColor Cyan
Write-Host ""

# --- Checks ---
function Need-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "MISSING: $name" -ForegroundColor Red
    return $false
  }
  return $true
}

$ok = $true
if (-not (Need-Command "node")) { $ok = $false; Write-Host "  Install Node.js 18+ from https://nodejs.org" }
if (-not (Need-Command "npm"))  { $ok = $false }

if (-not $ok) {
  Write-Host "`nInstall the missing tools, then re-run this script." -ForegroundColor Yellow
  exit 1
}

Write-Host "Node: $(node -v)"
Write-Host "npm:  $(npm -v)"
Write-Host "Game URL: $GameUrl"
Write-Host ""

if ($GameUrl -match "YOUR-GAME-HOST") {
  Write-Host "WARNING: You are still using the placeholder URL." -ForegroundColor Yellow
  Write-Host "Edit the script parameter or pass -GameUrl https://your-real-host.com" -ForegroundColor Yellow
  Write-Host ""
}

# --- Create project ---
if (Test-Path $OutputDir) {
  Write-Host "Removing old $OutputDir ..."
  Remove-Item -Recurse -Force $OutputDir
}
New-Item -ItemType Directory -Path $OutputDir | Out-Null
Set-Location $OutputDir

Write-Host "Scaffolding Capacitor project..."
npm init -y | Out-Null
npm pkg set name="penguin-tag-vr"
npm pkg set version="1.0.0"

# Minimal local web assets that immediately redirect / load the game
New-Item -ItemType Directory -Path "www" | Out-Null

@"
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
  <title>Penguin Tag VR</title>
  <style>
    html,body{margin:0;height:100%;background:#0a1628;color:#e8f4ff;font-family:system-ui,sans-serif;
      display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}
    h1{font-size:1.6rem;margin:0}
    p{opacity:.8;max-width:320px;text-align:center;line-height:1.4}
    button{padding:14px 22px;border:none;border-radius:12px;font-size:1.1rem;font-weight:700;
      background:linear-gradient(135deg,#4fc3f7,#0288d1);color:#001018;cursor:pointer}
  </style>
</head>
<body>
  <h1>🐧 Penguin Tag</h1>
  <p>Loading game… If nothing happens, tap the button.</p>
  <button id="go">ENTER GAME</button>
  <script>
    const GAME_URL = "$GameUrl";
    function launch() {
      // Prefer navigating the WebView fully to the game (best for WebXR attempt)
      window.location.href = GAME_URL;
    }
    document.getElementById('go').onclick = launch;
    // Auto-try after short delay so permission prompts can appear first
    setTimeout(launch, 800);
  </script>
</body>
</html>
"@ | Out-File -Encoding utf8 "www\index.html"

# Install Capacitor
Write-Host "Installing Capacitor..."
npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/app @capacitor/splash-screen 2>&1 | Select-Object -Last 5

npx cap init "Penguin Tag VR" "com.penguintag.vr" --web-dir www 2>&1 | Out-Host

# capacitor.config.json with useful defaults
@"
{
  "appId": "com.penguintag.vr",
  "appName": "Penguin Tag VR",
  "webDir": "www",
  "server": {
    "url": "$GameUrl",
    "cleartext": true,
    "allowNavigation": ["*"]
  },
  "android": {
    "allowMixedContent": true
  },
  "plugins": {
    "SplashScreen": {
      "launchShowDuration": 1000,
      "backgroundColor": "#0a1628"
    }
  }
}
"@ | Out-File -Encoding utf8 "capacitor.config.json"

Write-Host "Adding Android platform..."
npx cap add android 2>&1 | Out-Host
npx cap sync android 2>&1 | Out-Host

# --- Patch AndroidManifest for permissions Meta/Quest care about ---
$manifestPath = Get-ChildItem -Recurse -Filter "AndroidManifest.xml" |
  Where-Object { $_.FullName -match "android\\app\\src\\main\\AndroidManifest.xml" } |
  Select-Object -First 1 -ExpandProperty FullName

if ($manifestPath) {
  Write-Host "Patching AndroidManifest permissions: $manifestPath"
  $manifest = Get-Content $manifestPath -Raw

  $perms = @"
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-feature android:name="android.hardware.microphone" android:required="false" />
    <uses-feature android:glEsVersion="0x00030000" android:required="true" />
"@

  if ($manifest -notmatch "RECORD_AUDIO") {
    $manifest = $manifest -replace "(<manifest[^>]*>)", "`$1`r`n$perms"
    Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8
    Write-Host "Permissions added."
  } else {
    Write-Host "Permissions already present."
  }
} else {
  Write-Host "Could not find AndroidManifest.xml – open the project in Android Studio and add permissions manually." -ForegroundColor Yellow
}

# Helper README inside the wrapper
@"
# Penguin Tag VR – APK Wrapper

## What this is
An Android app that opens your hosted Penguin Tag game and requests microphone / network permissions.

## Build the APK (on your PC)

1. Install **Android Studio** (includes SDK + build tools)
   https://developer.android.com/studio

2. Open the folder:
   ``$OutputDir\android``

3. Let Gradle sync.

4. Build → Build Bundle(s) / APK(s) → Build APK(s)

5. APK will appear under:
   ``android\app\build\outputs\apk\debug\app-debug.apk``

   Rename it to ``Penguin-VR.apk`` if you want.

## Sideload on Quest
- Enable Developer Mode on the headset
- Use SideQuest or ``adb install Penguin-VR.apk``

## Important
Immersive WebXR is most reliable in the **Meta Quest Browser**.
This APK is a convenient launcher that loads the same web game and triggers
permission prompts (mic, network). On some Quest OS versions the WebView may
not enter full immersive VR; if that happens, open the same URL in the Quest Browser.

## Change game URL later
Edit ``capacitor.config.json`` → server.url, then:
  npx cap sync android
and rebuild.
"@ | Out-File -Encoding utf8 "README-APK.md"

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "Project created at: $(Resolve-Path .)"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Host the game (web-deploy + server) on HTTPS"
Write-Host "  2. Re-run this script with -GameUrl https://your-real-url"
Write-Host "  3. Open the 'android' folder in Android Studio and Build APK"
Write-Host "  4. Sideload the APK to Quest with SideQuest / adb"
Write-Host ""
Write-Host "See README-APK.md inside the project for details."
