# EvoluBrowser 🌐✨

AI-powered browser — iOS · Android · Desktop (Electron)

## 功能
- Chromium WebView 瀏覽器（iOS WKWebView / Android WebView）
- AI 側欄：摘要、提取重點、翻譯、問答
- Light / Dark Theme 切換（自動儲存偏好）
- 瀏覽記錄
- OpenAI API（gpt-4o-mini / gpt-4o）

---

## 快速開始

### 安裝依賴
```bash
cd evolubrowser
npm install
```

### 開發模式
```bash
# iOS Simulator
npm run ios

# Android Emulator
npm run android

# Web (瀏覽器預覽)
npm run web
```

### 設定 API Key
1. 啟動 app 後點右上角 ⚙
2. 貼上 OpenAI API Key（sk-…）
3. 選擇模型，點儲存

---

## Desktop (Electron)

### 方法一：開發模式（需先啟動 Expo web）
```bash
# Terminal 1：啟動 Expo web dev server
npm run web

# Terminal 2：啟動 Electron
cd electron
npm install
npm start
```

### 方法二：打包後執行
```bash
# 1. Build Expo web
npm run build:web

# 2. Run Electron (載入 web-build/)
cd electron
npm start
```

### 打包成 .exe / .dmg / .AppImage
```bash
cd electron
npm run build
# 輸出在 electron/dist/
```

---

## 背景播放說明

| 平台 | 一般網站音樂/影片 | YouTube/Netflix |
|------|----------------|----------------|
| Android | ✅ 支援（需設定） | ⚠ 部分受限 |
| iOS | ⚠ 部分支援 | ❌ Apple 限制 |
| Desktop | ✅ 完整支援 | ✅ 完整支援 |

詳見 [背景播放設定](#background-audio) 章節。

---

## 專案結構
```
evolubrowser/
├── App.tsx                    # 入口（ThemeProvider）
├── app.json                   # Expo 設定
├── src/
│   ├── theme.ts               # Light/Dark 主題 + ThemeContext
│   ├── screens/
│   │   └── BrowserScreen.tsx  # 主畫面（WebView + AI panel）
│   └── services/
│       ├── aiService.ts       # OpenAI API
│       └── storageService.ts  # 瀏覽記錄、對話記錄
└── electron/
    ├── main.js                # Electron 主程序
    └── package.json           # Desktop 依賴
```
