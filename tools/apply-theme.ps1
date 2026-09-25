# Re-applies the CapCut timeline restyle after a Shotcut update overwrites the QML.
# Keeps a copy of the themed files in theme/qml-capcut so an app update can be re-patched.
# Usage:  powershell -ExecutionPolicy Bypass -File tools\apply-theme.ps1
$ErrorActionPreference = "Stop"
$proj   = Split-Path $PSScriptRoot -Parent
$themed = Join-Path $proj "theme\qml-capcut"
$target = Join-Path $env:LOCALAPPDATA "Programs\Shotcut\share\shotcut\qml"

if (-not (Test-Path $themed)) { throw "themed copy not found: $themed  (run save-theme.ps1 first)" }

Get-Process shotcut -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Copy-Item "$themed\*" -Destination $target -Recurse -Force
Write-Output "CapCut timeline theme applied to $target"
