const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openExtensionFolder: () => ipcRenderer.invoke('open-extension-folder'),
  installExtension:    () => ipcRenderer.invoke('install-extension'),
  listExtensions:      () => ipcRenderer.invoke('list-extensions'),
  removeExtension: (id)     => ipcRenderer.invoke('remove-extension', id),
  installFromId:        (extId)          => ipcRenderer.invoke('install-from-id', extId),
  getExtensionDetails:  ()               => ipcRenderer.invoke('get-extension-details'),
  openExtensionPopup:   (popupUrl, name) => ipcRenderer.invoke('open-extension-popup', { popupUrl, name }),

  // ── Persistent store (replaces AsyncStorage) ──────────────
  store: {
    loadBookmarks:    () => ipcRenderer.invoke('store:loadBookmarks'),
    saveBookmarks:    (list) => ipcRenderer.invoke('store:saveBookmarks', list),
    loadHistory:      () => ipcRenderer.invoke('store:loadHistory'),
    saveHistory:      (list) => ipcRenderer.invoke('store:saveHistory', list),
    clearHistory:     () => ipcRenderer.invoke('store:clearHistory'),
    deleteHistoryByAge: (cutoffMs) => ipcRenderer.invoke('store:deleteHistoryByAge', cutoffMs),
    loadChatSessions: () => ipcRenderer.invoke('store:loadChatSessions'),
    saveChatSessions: (list) => ipcRenderer.invoke('store:saveChatSessions', list),
    loadSettings:     () => ipcRenderer.invoke('store:loadSettings'),
    saveSettings:     (s) => ipcRenderer.invoke('store:saveSettings', s),
  },

  // ── Context menu ─────────────────────────────────────────
  showLinkContextMenu: (url) => ipcRenderer.invoke('context-menu:show-link', url),
  showTextContextMenu: (text) => ipcRenderer.invoke('context-menu:show-text', text),
  showPageContextMenu:  ()   => ipcRenderer.invoke('context-menu:show-page'),

  // ── Context actions (from main process → renderer) ───────
  onContextAction: (callback) => {
    const handler = (_, action) => callback(action);
    ipcRenderer.on('context-action', handler);
    return () => ipcRenderer.removeListener('context-action', handler);
  },

  // ── DevTools ─────────────────────────────────────────────
  openWebviewDevTools: (webContentsId, mode) =>
    ipcRenderer.invoke('devtools:open-webview', { webContentsId, mode }),
  toggleWebviewDevTools: (webContentsId) =>
    ipcRenderer.invoke('devtools:toggle-webview', webContentsId),
  getDevToolsMode: () => ipcRenderer.invoke('devtools:getMode'),
  setDevToolsMode: (mode) => ipcRenderer.invoke('devtools:setMode', mode),
  onToggleDevTools: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('toggle-webview-devtools', handler);
    return () => ipcRenderer.removeListener('toggle-webview-devtools', handler);
  },

  // Fallback: open DevTools on the main window
  openMainDevTools: () => ipcRenderer.invoke('devtools:open-main'),

  isElectron: true,
});
