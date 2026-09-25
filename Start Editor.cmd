@echo off
if exist "%~dp0capcut-editor\release\Cutline\Cutline.exe" (
  cd /d "%~dp0capcut-editor\release\Cutline"
  start "" "Cutline.exe"
  exit /b 0
)
cd /d "%~dp0capcut-editor"
if not exist "dist\index.html" (
  echo Build the editor first with npm run build inside capcut-editor.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" "."
