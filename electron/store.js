/**
 * store.js — Persistent JSON file storage for Electron main process.
 *
 * Replaces AsyncStorage/localStorage which doesn't survive restarts
 * when the SPA is served over http://127.0.0.1:PORT.
 *
 * Each data collection is stored as its own JSON file under
 *   {userData}/data/{collection}.json
 *
 * Atomic writes via temp file + rename (avoid corruption on crash).
 */

const path = require('path');
const fs   = require('fs');

/* ── Helpers ────────────────────────────────────────────────── */

function dataDir(userData) {
  const dir = path.join(userData, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath(userData, collection) {
  return path.join(dataDir(userData), `${collection}.json`);
}

function read(userData, collection, fallback) {
  const fp = filePath(userData, collection);
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return fallback;
  }
}

function write(userData, collection, data) {
  const fp  = filePath(userData, collection);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, fp); // atomic on same filesystem
}

/* ── Modules ────────────────────────────────────────────────── */

function createStore(userData) {
  const api = {
    /* ═══ Bookmarks ═══════════════════════════════════════════ */
    loadBookmarks: () => read(userData, 'bookmarks', []),
    saveBookmarks: (list) => write(userData, 'bookmarks', list),

    /* ═══ History ═════════════════════════════════════════════ */
    loadHistory:       () => read(userData, 'history', []),
    saveHistory:       (list) => write(userData, 'history', list),
    clearHistory:      () => write(userData, 'history', []),
    deleteHistoryByAge: (cutoffMs) => {
      const all = api.loadHistory();
      api.saveHistory(all.filter(h => h.visitedAt < cutoffMs));
    },

    /* ═══ Chat sessions ═══════════════════════════════════════ */
    loadChatSessions: () => read(userData, 'chats', []),
    saveChatSessions: (list) => write(userData, 'chats', list),

    /* ═══ Settings ════════════════════════════════════════════ */
    loadSettings: () => read(userData, 'settings', { deepseekApiKey: '' }),
    saveSettings: (s) => write(userData, 'settings', s),
  };

  return api;
}

module.exports = { createStore };
