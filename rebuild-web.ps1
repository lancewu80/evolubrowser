Set-Location D:\project\ai\ai-project\evolubrowser
Write-Host "=== Building web version ==="
npx expo export --platform web --clear
if ($LASTEXITCODE -ne 0) {
  Write-Host "❌ Build failed!"
  exit 1
}
Write-Host "=== ✅ Build complete ==="

Set-Location D:\project\ai\ai-project\evolubrowser\electron
Write-Host "=== 🚀 Launching Electron... ==="
Start-Process -NoNewWindow "node_modules\.bin\electron.cmd" "."
Write-Host "=== ✅ Electron launched ==="
