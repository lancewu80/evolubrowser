/**
 * storageService.ts
 *
 * Tiered storage:
 *   1. Electron IPC → JSON files in userData/data/ (persistent)
 *   2. AsyncStorage fallback (for iOS/Android / non-Electron web)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Keys (AsyncStorage fallback only) ─────────────────────────
const HISTORY_KEY  = '@lance_history';
const CHATS_KEY    = '@lance_chats';
const BOOKMARK_KEY = '@lance_bookmarks';

// ── Detect Electron ──────────────────────────────────────────
const IS_ELECTRON =
  typeof window !== 'undefined' &&
  typeof (window as any).electronAPI?.store !== 'undefined';

function getStore(): any {
  return (window as any).electronAPI?.store;
}

// ── Types ────────────────────────────────────────────────────
export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
}

// ── History ───────────────────────────────────────────────────
export async function addHistory(item: { url: string; title: string }): Promise<void> {
  try {
    const existing = await loadHistory();
    const newItem: HistoryItem = {
      id: Date.now().toString(),
      url: item.url,
      title: item.title || item.url,
      visitedAt: Date.now(),
    };
    const updated = [newItem, ...existing.filter(h => h.url !== item.url)].slice(0, 500);

    if (IS_ELECTRON) {
      await getStore().saveHistory(updated);
    } else {
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
    }
  } catch {}
}

export async function loadHistory(): Promise<HistoryItem[]> {
  try {
    if (IS_ELECTRON) {
      return await getStore().loadHistory();
    }
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function clearHistory(): Promise<void> {
  if (IS_ELECTRON) {
    await getStore().clearHistory();
  } else {
    await AsyncStorage.removeItem(HISTORY_KEY);
  }
}

/** Delete history entries older than a cutoff timestamp (ms). */
export async function deleteHistoryByAge(cutoffMs: number): Promise<void> {
  try {
    if (IS_ELECTRON) {
      await getStore().deleteHistoryByAge(cutoffMs);
    } else {
      const all = await loadHistory();
      const filtered = all.filter(h => h.visitedAt < cutoffMs);
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(filtered));
    }
  } catch {}
}

// ── Chat Sessions ─────────────────────────────────────────────
export async function saveChatSession(session: ChatSession): Promise<void> {
  try {
    const existing = await loadChatSessions();
    const updated = [session, ...existing.filter(s => s.id !== session.id)].slice(0, 200);

    if (IS_ELECTRON) {
      await getStore().saveChatSessions(updated);
    } else {
      await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(updated));
    }
  } catch {}
}

export async function loadChatSessions(): Promise<ChatSession[]> {
  try {
    if (IS_ELECTRON) {
      return await getStore().loadChatSessions();
    }
    const raw = await AsyncStorage.getItem(CHATS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function deleteChatSession(id: string): Promise<void> {
  try {
    const existing = await loadChatSessions();
    const updated = existing.filter(s => s.id !== id);

    if (IS_ELECTRON) {
      await getStore().saveChatSessions(updated);
    } else {
      await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(updated));
    }
  } catch {}
}

// ── Bookmarks ─────────────────────────────────────────────────
export async function addBookmark(url: string, title: string): Promise<void> {
  try {
    const existing = await loadBookmarks();
    if (existing.some(b => b.url === url)) return; // already bookmarked
    const newBm: Bookmark = {
      id: Date.now().toString(),
      url,
      title: title || url,
      createdAt: Date.now(),
    };
    const updated = [newBm, ...existing];

    if (IS_ELECTRON) {
      await getStore().saveBookmarks(updated);
    } else {
      await AsyncStorage.setItem(BOOKMARK_KEY, JSON.stringify(updated));
    }
  } catch {}
}

export async function removeBookmark(url: string): Promise<void> {
  try {
    const existing = await loadBookmarks();
    const updated = existing.filter(b => b.url !== url);

    if (IS_ELECTRON) {
      await getStore().saveBookmarks(updated);
    } else {
      await AsyncStorage.setItem(BOOKMARK_KEY, JSON.stringify(updated));
    }
  } catch {}
}

export async function loadBookmarks(): Promise<Bookmark[]> {
  try {
    if (IS_ELECTRON) {
      return await getStore().loadBookmarks();
    }
    const raw = await AsyncStorage.getItem(BOOKMARK_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function isBookmarked(url: string): Promise<boolean> {
  const bms = await loadBookmarks();
  return bms.some(b => b.url === url);
}
