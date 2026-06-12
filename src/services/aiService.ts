/**
 * aiService.ts — DeepSeek API client
 *
 * Settings stored via Electron IPC (persistent JSON) when available,
 * falls back to AsyncStorage for native/web.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Detect Electron ──────────────────────────────────────────
const IS_ELECTRON =
  typeof window !== 'undefined' &&
  typeof (window as any).electronAPI?.store !== 'undefined';

function getStore(): any {
  return (window as any).electronAPI?.store;
}

// ── DeepSeek API ──────────────────────────────────────────────
const DEEPSEEK_BASE  = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = 'deepseek-chat';
const SETTINGS_KEY   = '@lance_settings';

export interface Settings {
  deepseekApiKey: string;
}

export async function getSettings(): Promise<Settings> {
  try {
    if (IS_ELECTRON) {
      return await getStore().loadSettings();
    }
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : { deepseekApiKey: '' };
  } catch {
    return { deepseekApiKey: '' };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  if (IS_ELECTRON) {
    await getStore().saveSettings(s);
  } else {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}

// ── Types ─────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── Non-streaming completion ──────────────────────────────────
export async function chatCompletion(
  messages: ChatMessage[],
  systemPrompt?: string,
): Promise<string> {
  const { deepseekApiKey } = await getSettings();
  if (!deepseekApiKey) throw new Error('請先在設定裡輸入 DeepSeek API Key');

  const msgs: ChatMessage[] = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deepseekApiKey}`,
    },
    body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: msgs, stream: false }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Streaming completion ──────────────────────────────────────
export async function chatStream(
  messages: ChatMessage[],
  onChunk: (delta: string) => void,
  systemPrompt?: string,
): Promise<void> {
  const { deepseekApiKey } = await getSettings();
  if (!deepseekApiKey) throw new Error('請先在設定裡輸入 DeepSeek API Key');

  const msgs: ChatMessage[] = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deepseekApiKey}`,
    },
    body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: msgs, stream: true }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${err}`);
  }

  // Streaming via ReadableStream
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.replace(/^data: /, '').trim();
        if (!trimmed || trimmed === '[DONE]') continue;
        try {
          const json = JSON.parse(trimmed);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) onChunk(delta);
        } catch {}
      }
    }
  } else {
    // Fallback non-streaming
    const text = await chatCompletion(messages, systemPrompt);
    onChunk(text);
  }
}

// ── Prompt builders ───────────────────────────────────────────
export function buildSummaryPrompt(title: string, url: string, text: string): ChatMessage[] {
  return [{
    role: 'user',
    content: `請用繁體中文摘要以下網頁內容，200字以內，重點列點。\n\n標題：${title}\n網址：${url}\n\n內容：\n${text}`,
  }];
}

export function buildKeyPointsPrompt(title: string, url: string, text: string): ChatMessage[] {
  return [{
    role: 'user',
    content: `請用繁體中文列出以下網頁的 5-8 個重點，每點一行，格式：• 重點。\n\n標題：${title}\n網址：${url}\n\n內容：\n${text}`,
  }];
}

export function buildTranslatePrompt(title: string, url: string, text: string): ChatMessage[] {
  return [{
    role: 'user',
    content: `請將以下網頁內容翻譯成繁體中文，保持原文結構。\n\n標題：${title}\n網址：${url}\n\n內容：\n${text}`,
  }];
}

export function buildAskPrompt(
  question: string,
  title: string,
  url: string,
  text: string,
): ChatMessage[] {
  return [{
    role: 'user',
    content: `根據以下網頁內容回答問題。請用繁體中文回答。\n\n標題：${title}\n網址：${url}\n\n內容：\n${text}\n\n問題：${question}`,
  }];
}
