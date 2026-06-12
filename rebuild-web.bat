@echo off
cd /d D:\project\ai\ai-project\evolubrowser
echo === Building web version ===
npx expo export --platform web --clear
if errorlevel 1 (
  echo ❌ Build failed!
  pause
  exit /b 1
)
echo === ✅ Build complete ===

cd /d D:\project\ai\ai-project\evolubrowser\electron
echo === 🚀 Launching Electron... ===
start "" "%CD%\node_modules\.bin\electron.cmd" .
echo === ✅ Electron launched ===
