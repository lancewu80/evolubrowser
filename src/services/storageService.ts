import AsyncStorage from '@react-native-async-storage/async-storage';

// ── History ───────────────────────────────────────────────────
const HISTORY_KEY  = '@lance_history';
const CHATS_KEY    = '@lance_chats';
const BOOKMARK_KEY = '@lance_bookmarks';

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
}

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
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
}

export async function loadHistory(): Promise<HistoryItem[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.removeItem(HISTORY_KEY);
}

// ── Chat Sessions ─────────────────────────────────────────────
export interface ChatSession {
  id: string;
  title: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
}

export async function saveChatSession(session: ChatSession): Promise<void> {
  try {
    const existing = await loadChatSessions();
    const updated = [session, ...existing.filter(s => s.id !== session.id)].slice(0, 200);
    await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(updated));
  } catch {}
}

export async function loadChatSessions(): Promise<ChatSession[]> {
  try {
    const raw = await AsyncStorage.getItem(CHATS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function deleteChatSession(id: string): Promise<void> {
  try {
    const existing = await loadChatSessions();
    await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(existing.filter(s => s.id !== id)));
  } catch {}
}

// ── Bookmarks ─────────────────────────────────────────────────
export interface Bookmark {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

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
    await AsyncStorage.setItem(BOOKMARK_KEY, JSON.stringify([newBm, ...existing]));
  } catch {}
}

export async function removeBookmark(url: string): Promise<void> {
  try {
    const existing = await loadBookmarks();
    await AsyncStorage.setItem(BOOKMARK_KEY, JSON.stringify(existing.filter(b => b.url !== url)));
  } catch {}
}

export async function loadBookmarks(): Promise<Bookmark[]> {
  try {
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
