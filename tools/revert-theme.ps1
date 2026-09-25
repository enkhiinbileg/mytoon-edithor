# Restores Shotcut's original timeline QML, undoing the CapCut restyle.
# Usage:  powershell -ExecutionPolicy Bypass -File tools\revert-theme.ps1
$ErrorActionPreference = "Stop"
$proj   = Split-Path $PSScriptRoot -Parent
$backup = Join-Path $proj "backup\qml-original"
$target = Join-Path $env:LOCALAPPDATA "Programs\Shotcut\share\shotcut\qml"

if (-not (Test-Path $backup)) { throw "backup not found: $backup" }

Get-Process shotcut -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Remove-Item $target -Recurse -Force
Copy-Item $backup -Destination $target -Recurse -Force

$n = (Get-ChildItem $target -Recurse -File).Count
Write-Output "Reverted. $n original QML files restored to $target"
