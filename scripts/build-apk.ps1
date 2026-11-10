# Honest APK packaging notes for Quest
# A pure WebView APK is NOT full VR. True Quest VR apps need OpenXR / Meta SDKs.
# Recommended free path: host as HTTPS PWA and open in Meta Quest Browser (WebXR works).
# Optional: use Capacitor + @capacitor-community or similar after installing Android SDK.
Write-Host "Penguin VR – APK path"
Write-Host "1. Preferred: Deploy client+server to HTTPS host. Open URL in Quest Browser → Enter VR."
Write-Host "2. For experimental APK: install Android SDK, use Capacitor to wrap the web client."
Write-Host "   This environment does not ship a full Android SDK, so no binary is produced here."
Write-Host "Output folder remains empty for native APK; source is fully available."
New-Item -ItemType Directory -Force -Path ..\output | Out-Null
"See README – WebXR browser is the supported free distribution." | Out-File ..\output\README-APK.txt
