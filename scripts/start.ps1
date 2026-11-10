# Penguin VR launcher (Windows PowerShell)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
Write-Host "Starting Penguin VR server on port 8080..."
node server/index.js
