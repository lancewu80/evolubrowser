const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openExtensionFolder: () => ipcRenderer.invoke('open-extension-folder'),
  installExtension:    () => ipcRenderer.invoke('install-extension'),
  listExtensions:      () => ipcRenderer.invoke('list-extensions'),
  removeExtension: (id)     => ipcRenderer.invoke('remove-extension', id),
  installFromId:        (extId)          => ipcRenderer.invoke('install-from-id', extId),
  getExtensionDetails:  ()               => ipcRenderer.invoke('get-extension-details'),
  openExtensionPopup:   (popupUrl, name) => ipcRenderer.invoke('open-extension-popup', { popupUrl, name }),
  isElectron: true,
});
