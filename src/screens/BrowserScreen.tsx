import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Animated,
  Dimensions,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from '../components/WebViewBridge';
import type { WebViewNavigation } from 'react-native-webview';
import { useTheme } from '../theme';
import {
  ChatMessage,
  buildKeyPointsPrompt,
  buildSummaryPrompt,
  chatStream,
  getSettings,
  saveSettings,
} from '../services/aiService';
import {
  Bookmark,
  HistoryItem,
  addBookmark,
  addHistory,
  isBookmarked,
  loadBookmarks,
  loadHistory,
  removeBookmark,
} from '../services/storageService';

// ── Constants ─────────────────────────────────────────────────
const IS_IOS     = Platform.OS === 'ios';
const IS_ANDROID = Platform.OS === 'android';
const IS_WEB     = Platform.OS === 'web';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const TAB_W     = IS_WEB ? 200 : 140;
const PANEL_H   = Math.round(SCREEN_H * 0.65);
const SIDEBAR_W = 400;

const CHROME_UA = IS_IOS
  ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1'
  : IS_ANDROID
    ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Safari/537.36';

// Chrome Web Store extension detail page pattern
const CWS_REGEX = /(?:chromewebstore\.google\.com\/detail\/[^/]+\/|chrome\.google\.com\/webstore\/detail\/[^/]+\/)([a-z]{32})/;

// Injected into CWS pages to (1) fix Chrome detection, (2) add install button
const CWS_INJECT_JS = `(function(){
  try{
    // Fix Chrome API detection so CWS doesn't show "無法購買"
    if(!window.chrome)window.chrome={};
    if(!window.chrome.runtime)window.chrome.runtime={};
    if(!window.chrome.webstore)window.chrome.webstore={
      onInstallStageChanged:{addListener:function(){}},
      onDownloadProgress:{addListener:function(){}},
      install:function(u,s){s&&s();}
    };
  }catch(e){}

  // Add floating "安裝到 LanceBrowser" button on extension detail pages
  var m=location.href.match(/detail\\/[^\\/]+\\/([a-z]{32})/);
  if(!m)return;
  var extId=m[1];
  if(document.getElementById('_lb_btn'))return;
  var b=document.createElement('button');
  b.id='_lb_btn';
  b.textContent='🚀 安裝到 LanceBrowser';
  b.style.cssText='position:fixed;bottom:28px;right:28px;z-index:99999;background:#6c63ff;color:#fff;border:none;padding:13px 22px;border-radius:26px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.35);';
  b.onclick=function(){
    b.textContent='⏳ 下載安裝中...';b.disabled=true;
    window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'install-ext',extId:extId}));
    // Fallback: store in global so polling can pick it up
    window.__lb_install=extId;
  };
  document.body.appendChild(b);
})();true;`;

const EXTRACT_JS = `(function(){
  try{
    var clone=document.body.cloneNode(true);
    clone.querySelectorAll('script,style,nav,footer,header,aside,[class*="ad"],[id*="ad"]').forEach(function(e){e.remove();});
    var text=(clone.innerText||'').replace(/\\s+/g,' ').trim().substring(0,12000);
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'content',title:document.title||location.href,text:text}));
  }catch(e){
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'content',title:document.title||'',text:''}));
  }
})();true;`;

// ── Types ─────────────────────────────────────────────────────
interface Tab {
  id: string;
  url: string;
  inputUrl: string;
  title: string;
  isLoading: boolean;
  canBack: boolean;
  canFwd: boolean;
  pageContent: { title: string; text: string } | null;
}

function newTab(url = 'https://www.google.com'): Tab {
  return {
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    url, inputUrl: url,
    title: 'New Tab',
    isLoading: false, canBack: false, canFwd: false,
    pageContent: null,
  };
}

type PanelMode = 'summary' | 'keypoints' | 'chat' | 'history' | 'bookmarks' | 'settings';

const PANEL_LABELS: Record<PanelMode, string> = {
  summary:   '摘要',
  keypoints: '重點',
  chat:      'AI 對話',
  history:   '瀏覽記錄',
  bookmarks: '書籤',
  settings:  '設定',
};

// ─────────────────────────────────────────────────────────────
export default function BrowserScreen() {
  const { colors, isDark, toggleTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const S = useMemo(() => makeStyles(colors, isDark, insets), [colors, isDark, insets]);

  // ── Tabs ───────────────────────────────────────────────────
  const [tabs, setTabs]         = useState<Tab[]>([newTab()]);
  const [activeId, setActiveId] = useState<string>(tabs[0].id);
  const wvRefs = useRef<Map<string, WebView>>(new Map());

  const activeTab = tabs.find(t => t.id === activeId) ?? tabs[0];

  const updateTab = useCallback((id: string, patch: Partial<Tab>) =>
    setTabs(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t)), []);

  const navigate = useCallback((raw: string) => {
    let url = raw.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      url = url.includes('.') && !url.includes(' ')
        ? 'https://' + url
        : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    }
    updateTab(activeId, { url, inputUrl: url });
    Keyboard.dismiss();
  }, [activeId, updateTab]);

  const addTab = useCallback(() => {
    const t = newTab();
    setTabs(p => [...p, t]);
    setActiveId(t.id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      const remaining = prev.filter(t => t.id !== id);
      if (!remaining.length) return [newTab()];
      return remaining;
    });
    setActiveId(prev => {
      const remaining = tabs.filter(t => t.id !== id);
      return remaining.length ? remaining[remaining.length - 1].id : tabs[0].id;
    });
  }, [tabs]);

  // ── Panel ──────────────────────────────────────────────────
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>('chat');
  const slideAnim = useRef(new Animated.Value(PANEL_H)).current; // starts off-screen

  const openPanel = useCallback((mode: PanelMode) => {
    setPanelMode(mode);
    setPanelOpen(true);
    Animated.spring(slideAnim, {
      toValue: 0,
      useNativeDriver: true,
      tension: 65,
      friction: 11,
    }).start();
  }, [slideAnim]);

  const closePanel = useCallback(() => {
    Keyboard.dismiss();
    Animated.timing(slideAnim, {
      toValue: PANEL_H,
      duration: 240,
      useNativeDriver: true,
    }).start(() => setPanelOpen(false));
  }, [slideAnim]);

  // Toggle: same button = close, different button = switch mode
  const togglePanel = useCallback((mode: PanelMode) => {
    if (panelOpen && panelMode === mode) {
      closePanel();
    } else if (panelOpen) {
      // already open — just switch mode, no re-animation
      setPanelMode(mode);
      if (mode === 'history') loadHistory().then(setHistoryItems);
      if (mode === 'bookmarks') loadBookmarks().then(setBookmarkItems);
    } else {
      if (mode === 'history') loadHistory().then(setHistoryItems);
      if (mode === 'bookmarks') loadBookmarks().then(setBookmarkItems);
      openPanel(mode);
    }
  }, [panelOpen, panelMode, openPanel, closePanel]);

  // ── AI ─────────────────────────────────────────────────────
  const [aiOutput, setAiOutput]       = useState('');
  const [aiLoading, setAiLoading]     = useState(false);
  const [chatMsgs, setChatMsgs]       = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput]     = useState('');
  const chatScrollRef = useRef<ScrollView>(null);

  const runAiMode = useCallback(async (mode: 'summary' | 'keypoints') => {
    // Toggle off if already showing
    if (panelOpen && panelMode === mode) { closePanel(); return; }

    setAiOutput('');
    openPanel(mode);

    const tab = activeTab;
    if (!tab.pageContent) {
      wvRefs.current.get(tab.id)?.injectJavaScript(EXTRACT_JS);
      setAiOutput('正在提取頁面內容，請稍候...');
      return;
    }
    setAiLoading(true);
    const msgs = mode === 'summary'
      ? buildSummaryPrompt(tab.pageContent.title, tab.url, tab.pageContent.text)
      : buildKeyPointsPrompt(tab.pageContent.title, tab.url, tab.pageContent.text);
    try {
      await chatStream(msgs, delta => setAiOutput(prev => prev + delta));
    } catch (e: any) {
      setAiOutput('❌ ' + (e?.message ?? '未知錯誤'));
    } finally {
      setAiLoading(false);
    }
  }, [panelOpen, panelMode, closePanel, openPanel, activeTab]);

  // Re-run AI when page content loads (for summary/keypoints)
  useEffect(() => {
    if (!activeTab.pageContent) return;
    if (!panelOpen) return;
    if (panelMode !== 'summary' && panelMode !== 'keypoints') return;
    if (aiOutput && aiOutput !== '正在提取頁面內容，請稍候...') return;
    // content just arrived, run AI
    setAiLoading(true);
    const msgs = panelMode === 'summary'
      ? buildSummaryPrompt(activeTab.pageContent.title, activeTab.url, activeTab.pageContent.text)
      : buildKeyPointsPrompt(activeTab.pageContent.title, activeTab.url, activeTab.pageContent.text);
    chatStream(msgs, delta => setAiOutput(prev => prev === '正在提取頁面內容，請稍候...' ? delta : prev + delta))
      .catch((e: any) => setAiOutput('❌ ' + (e?.message ?? '錯誤')))
      .finally(() => setAiLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab.pageContent]);

  const sendChat = useCallback(async () => {
    const q = chatInput.trim();
    if (!q || aiLoading) return;
    setChatInput('');
    Keyboard.dismiss();
    const userMsg: ChatMessage = { role: 'user', content: q };
    const history = [...chatMsgs, userMsg];
    setChatMsgs(history);
    setAiLoading(true);
    const tab = activeTab;
    const sys = tab.pageContent
      ? `你是網頁助理，使用繁體中文回答。\n當前頁面：${tab.pageContent.title}\n網址：${tab.url}\n內容：${tab.pageContent.text.substring(0, 3000)}`
      : '你是智慧助理，使用繁體中文回答。';
    let resp = '';
    try {
      await chatStream(history, delta => {
        resp += delta;
        setChatMsgs(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant') return [...prev.slice(0, -1), { role: 'assistant', content: resp }];
          return [...prev, { role: 'assistant', content: resp }];
        });
        setTimeout(() => chatScrollRef.current?.scrollToEnd({ animated: true }), 50);
      }, sys);
    } catch (e: any) {
      setChatMsgs(prev => [...prev, { role: 'assistant', content: '❌ ' + (e?.message ?? '錯誤') }]);
    } finally {
      setAiLoading(false);
    }
  }, [chatInput, chatMsgs, aiLoading, activeTab]);

  // ── Settings ───────────────────────────────────────────────
  const [apiKey, setApiKey]         = useState('');
  const [apiKeySaved, setApiKeySaved] = useState(false);
  useEffect(() => { getSettings().then(s => setApiKey(s.deepseekApiKey ?? '')); }, []);

  // ── Extensions (Electron only) ─────────────────────────────
  const eAPI = IS_WEB ? (window as any).electronAPI : null;
  interface ExtInfo { id: string; name: string; version: string; popup?: string | null; icon?: string | null }
  const [extensions, setExtensions] = useState<ExtInfo[]>([]);
  const [extMsg, setExtMsg] = useState('');

  // Toast notification
  const [toast, setToast] = useState('');
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  }, []);

  // Detect Chrome Web Store extension page
  const cwsExtId = eAPI ? (activeTab.url.match(CWS_REGEX)?.[1] ?? null) : null;

  const refreshExtensions = useCallback(async () => {
    if (!eAPI) return;
    const list = await eAPI.getExtensionDetails();
    setExtensions(list ?? []);
  }, [eAPI]);

  useEffect(() => { refreshExtensions(); }, [refreshExtensions]);

  // Install from Chrome Web Store by extension ID
  const handleInstallFromId = useCallback(async (extId: string) => {
    if (!eAPI) return;
    showToast('⏳ 下載並安裝擴充套件中...');
    const result = await eAPI.installFromId(extId);
    if (result?.ok) {
      showToast(`✅ 已安裝：${result.name}`);
      refreshExtensions();
    } else {
      showToast(`❌ ${result?.error ?? '安裝失敗'}`);
    }
  }, [eAPI, showToast, refreshExtensions]);

  const handleInstallExt = useCallback(async () => {
    if (!eAPI) return;
    setExtMsg('');
    const result = await eAPI.installExtension();
    if (result?.ok) {
      setExtMsg(`✅ 已安裝：${result.name}`);
      refreshExtensions();
    } else {
      setExtMsg(`❌ ${result?.error ?? '安裝失敗'}`);
    }
  }, [eAPI, refreshExtensions]);

  const handleRemoveExt = useCallback(async (id: string) => {
    if (!eAPI) return;
    await eAPI.removeExtension(id);
    setExtMsg('🗑 已移除');
    refreshExtensions();
  }, [eAPI, refreshExtensions]);

  // ── Bookmarks ──────────────────────────────────────────────
  const [bookmarkItems, setBookmarkItems] = useState<Bookmark[]>([]);
  const [historyItems, setHistoryItems]   = useState<HistoryItem[]>([]);
  const [curBookmarked, setCurBookmarked] = useState(false);

  useEffect(() => {
    isBookmarked(activeTab.url).then(setCurBookmarked);
  }, [activeTab.url]);

  const toggleBookmark = useCallback(async () => {
    if (curBookmarked) {
      await removeBookmark(activeTab.url);
      setCurBookmarked(false);
      setBookmarkItems(prev => prev.filter(b => b.url !== activeTab.url));
    } else {
      await addBookmark(activeTab.url, activeTab.title);
      setCurBookmarked(true);
      loadBookmarks().then(setBookmarkItems);
    }
  }, [curBookmarked, activeTab.url, activeTab.title]);

  // ── Fullscreen ─────────────────────────────────────────────
  const [isFullscreen, setIsFullscreen] = useState(false);
  const handleFullscreen = useCallback((full: boolean) => {
    setIsFullscreen(full);
    StatusBar.setHidden(full, 'fade');
  }, []);

  // ── WebView callbacks ──────────────────────────────────────
  const onNavState = useCallback((id: string, nav: WebViewNavigation) => {
    updateTab(id, {
      url: nav.url,
      inputUrl: nav.url,
      title: nav.title || nav.url,
      canBack: nav.canGoBack,
      canFwd: nav.canGoForward,
    });
    if (nav.url && nav.title && !nav.loading) {
      addHistory({ url: nav.url, title: nav.title });
    }
  }, [updateTab]);

  const onMessage = useCallback((id: string, e: any) => {
    try {
      const data = JSON.parse(e.nativeEvent.data);
      if (data.type === 'content') updateTab(id, { pageContent: { title: data.title, text: data.text } });
      if (data.type === 'install-ext' && data.extId) handleInstallFromId(data.extId);
    } catch {}
  }, [updateTab, handleInstallFromId]);

  // ─────────────────────────────────────────────────────────
  // Render sections
  // ─────────────────────────────────────────────────────────

  function renderPanelContent() {
    if (panelMode === 'summary' || panelMode === 'keypoints') {
      return (
        <ScrollView style={S.flex} contentContainerStyle={S.scrollPad}>
          {aiLoading && !aiOutput
            ? <Text style={S.placeholder}>🤖 AI 思考中...</Text>
            : <Text style={S.outputText}>{aiOutput || '尚無內容'}</Text>
          }
        </ScrollView>
      );
    }

    if (panelMode === 'chat') {
      return (
        <KeyboardAvoidingView
          style={S.flex}
          behavior={IS_IOS ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          <ScrollView
            ref={chatScrollRef}
            style={S.flex}
            contentContainerStyle={S.scrollPad}
            keyboardShouldPersistTaps="handled"
          >
            {chatMsgs.length === 0 && (
              <Text style={S.placeholder}>👋 輸入問題，或問我關於當前頁面的內容</Text>
            )}
            {chatMsgs.map((m, i) => (
              <View key={i} style={[S.bubble, m.role === 'user' ? S.bubbleUser : S.bubbleAI]}>
                <Text style={[S.bubbleText, m.role === 'user' ? S.bubbleUserText : S.bubbleAIText]}>
                  {m.content}
                </Text>
              </View>
            ))}
            {aiLoading && (
              <View style={[S.bubble, S.bubbleAI]}>
                <Text style={S.bubbleAIText}>⏳ 思考中...</Text>
              </View>
            )}
          </ScrollView>

          {/* Chat input — always visible at bottom */}
          <View style={S.chatInputRow}>
            <TextInput
              style={S.chatInput}
              value={chatInput}
              onChangeText={setChatInput}
              placeholder="輸入問題..."
              placeholderTextColor={colors.textSub}
              multiline
              returnKeyType="send"
              blurOnSubmit
              onSubmitEditing={sendChat}
            />
            <TouchableOpacity
              style={[S.sendBtn, (!chatInput.trim() || aiLoading) && S.sendBtnDisabled]}
              onPress={sendChat}
              disabled={!chatInput.trim() || aiLoading}
            >
              <Text style={S.sendBtnText}>➤</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      );
    }

    if (panelMode === 'history') {
      return (
        <FlatList
          data={historyItems}
          keyExtractor={i => i.id}
          contentContainerStyle={historyItems.length === 0 ? S.emptyContainer : undefined}
          ListEmptyComponent={<Text style={S.placeholder}>尚無瀏覽記錄</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={S.listItem} onPress={() => { navigate(item.url); closePanel(); }}>
              <Text style={S.listTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={S.listUrl}   numberOfLines={1}>{item.url}</Text>
            </TouchableOpacity>
          )}
        />
      );
    }

    if (panelMode === 'bookmarks') {
      return (
        <FlatList
          data={bookmarkItems}
          keyExtractor={i => i.id}
          contentContainerStyle={bookmarkItems.length === 0 ? S.emptyContainer : undefined}
          ListEmptyComponent={
            <View style={S.emptyBox}>
              <Text style={S.emptyIcon}>☆</Text>
              <Text style={S.placeholder}>尚無書籤</Text>
              <Text style={S.placeholderSub}>點網址列旁的 ☆ 按鈕即可加入書籤</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={S.listItemRow}>
              <TouchableOpacity
                style={S.listItemMain}
                onPress={() => { navigate(item.url); closePanel(); }}
              >
                <Text style={S.listTitle} numberOfLines={1}>{item.title}</Text>
                <Text style={S.listUrl}   numberOfLines={1}>{item.url}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={S.deleteBtn}
                onPress={async () => {
                  await removeBookmark(item.url);
                  setBookmarkItems(prev => prev.filter(b => b.id !== item.id));
                  if (item.url === activeTab.url) setCurBookmarked(false);
                }}
              >
                <Text style={S.deleteText}>🗑</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      );
    }

    if (panelMode === 'settings') {
      return (
        <ScrollView style={S.flex} contentContainerStyle={S.scrollPad}>
          <Text style={S.settingsLabel}>DeepSeek API Key</Text>
          <Text style={S.settingsHint}>
            前往 platform.deepseek.com 申請 API Key，貼入下方後點「儲存」
          </Text>
          <TextInput
            style={S.settingsInput}
            value={apiKey}
            onChangeText={v => { setApiKey(v); setApiKeySaved(false); }}
            placeholder="sk-..."
            placeholderTextColor={colors.textSub}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={S.saveBtn}
            onPress={async () => {
              await saveSettings({ deepseekApiKey: apiKey.trim() });
              setApiKeySaved(true);
              Keyboard.dismiss();
            }}
          >
            <Text style={S.saveBtnText}>{apiKeySaved ? '✅ 已儲存' : '儲存 API Key'}</Text>
          </TouchableOpacity>

          {/* Extensions — Electron only */}
          {eAPI && (
            <>
              <Text style={[S.settingsLabel, { marginTop: 24 }]}>Chrome 擴充套件</Text>
              <Text style={S.settingsHint}>
                支援已解壓縮的 Chrome 擴充套件資料夾（.crx 需先解壓）
              </Text>

              {/* Open Chrome Web Store */}
              <TouchableOpacity
                style={[S.saveBtn, { backgroundColor: '#6c63ff', marginBottom: 8 }]}
                onPress={() => { navigate('https://chromewebstore.google.com'); closePanel(); }}
              >
                <Text style={S.saveBtnText}>🌐 開啟 Chrome Web Store</Text>
              </TouchableOpacity>

              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                <TouchableOpacity style={[S.saveBtn, { flex: 1 }]} onPress={handleInstallExt}>
                  <Text style={S.saveBtnText}>＋ 從資料夾安裝</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[S.saveBtn, { flex: 1, backgroundColor: colors.textSub }]}
                  onPress={() => eAPI.openExtensionFolder()}
                >
                  <Text style={S.saveBtnText}>📁 擴充套件資料夾</Text>
                </TouchableOpacity>
              </View>

              {extMsg ? <Text style={{ color: colors.text, marginBottom: 10, fontSize: 12 }}>{extMsg}</Text> : null}

              {extensions.length === 0
                ? <Text style={S.placeholder}>尚未安裝任何擴充套件</Text>
                : extensions.map(ext => (
                    <View key={ext.id} style={[S.listItemRow, { borderRadius: 8, marginBottom: 6 }]}>
                      <View style={S.listItemMain}>
                        <Text style={S.listTitle} numberOfLines={1}>🧩 {ext.name}</Text>
                        <Text style={S.listUrl}>v{ext.version} · {ext.id.slice(0, 16)}…</Text>
                      </View>
                      <TouchableOpacity style={S.deleteBtn} onPress={() => handleRemoveExt(ext.id)}>
                        <Text style={S.deleteText}>🗑</Text>
                      </TouchableOpacity>
                    </View>
                  ))
              }
            </>
          )}
        </ScrollView>
      );
    }

    return null;
  }

  // ── Bottom toolbar buttons ─────────────────────────────────
  const BOTTOM_BTNS: Array<{ label: string; mode: PanelMode; isAi?: boolean }> = [
    { label: '摘要',  mode: 'summary',   isAi: true },
    { label: '重點',  mode: 'keypoints', isAi: true },
    { label: '💬 AI', mode: 'chat' },
    { label: '📚 書籤', mode: 'bookmarks' },
    { label: '🕐 記錄', mode: 'history' },
    { label: '⚙️ 設定', mode: 'settings' },
  ];

  const isActive = (mode: PanelMode) => panelOpen && panelMode === mode;

  // ─────────────────────────────────────────────────────────
  return (
    <View style={S.root}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={isFullscreen ? '#000' : colors.bg2}
        hidden={isFullscreen}
        translucent={false}
      />

      {/* ── Top chrome ────────────────────────────────────── */}
      {!isFullscreen && (
        <View style={[S.topChrome, { paddingTop: insets.top }]}>
          {/* Tab bar */}
          <View style={S.tabBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={S.tabScroll}
            >
              {tabs.map(tab => {
                const active = tab.id === activeId;
                return (
                  <TouchableOpacity
                    key={tab.id}
                    style={[S.tab, active && S.tabActive]}
                    onPress={() => setActiveId(tab.id)}
                  >
                    <Text style={[S.tabLabel, active && S.tabLabelActive]} numberOfLines={1}>
                      {tab.isLoading ? '⏳ ' : ''}{tab.title || 'New Tab'}
                    </Text>
                    {tabs.length > 1 && (
                      <TouchableOpacity style={S.tabX} onPress={() => closeTab(tab.id)}>
                        <Text style={S.tabXText}>×</Text>
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={S.newTab} onPress={addTab}>
              <Text style={S.newTabText}>＋</Text>
            </TouchableOpacity>
          </View>

          {/* Address bar */}
          <View style={S.addrBar}>
            <TouchableOpacity
              style={[S.navBtn, !activeTab.canBack && S.navBtnOff]}
              disabled={!activeTab.canBack}
              onPress={() => wvRefs.current.get(activeId)?.goBack()}
            >
              <Text style={S.navBtnTxt}>‹</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.navBtn, !activeTab.canFwd && S.navBtnOff]}
              disabled={!activeTab.canFwd}
              onPress={() => wvRefs.current.get(activeId)?.goForward()}
            >
              <Text style={S.navBtnTxt}>›</Text>
            </TouchableOpacity>

            <TextInput
              style={S.urlInput}
              value={activeTab.inputUrl}
              onChangeText={v => updateTab(activeId, { inputUrl: v })}
              onSubmitEditing={() => navigate(activeTab.inputUrl)}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              selectTextOnFocus
              placeholder="搜尋或輸入網址"
              placeholderTextColor={colors.textSub}
            />

            {/* Bookmark star */}
            {/* CWS install button — shows on extension detail pages */}
            {cwsExtId && (
              <TouchableOpacity style={S.cwsBtn} onPress={() => handleInstallFromId(cwsExtId)}>
                <Text style={S.cwsBtnTxt}>🧩安裝</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={S.navBtn} onPress={toggleBookmark}>
              <Text style={[S.navBtnTxt, { color: curBookmarked ? '#f5c518' : colors.textSub, fontSize: 18 }]}>
                {curBookmarked ? '★' : '☆'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={S.navBtn} onPress={() => wvRefs.current.get(activeId)?.reload()}>
              <Text style={S.navBtnTxt}>↻</Text>
            </TouchableOpacity>

            {/* Extension icons */}
            {extensions.filter(e => e.popup || e.icon).map(ext => (
              <TouchableOpacity
                key={ext.id}
                style={S.extIconBtn}
                onPress={() => {
                  if (ext.popup) eAPI?.openExtensionPopup(ext.popup, ext.name);
                  else showToast(`ℹ️ ${ext.name} 無 popup（Content Script 類型，自動生效）`);
                }}
                title={ext.name}
              >
                {ext.icon
                  ? <Image source={{ uri: ext.icon }} style={S.extIcon} />
                  : <Text style={S.navBtnTxt}>🧩</Text>
                }
              </TouchableOpacity>
            ))}

            <TouchableOpacity style={S.navBtn} onPress={toggleTheme}>
              <Text style={S.navBtnTxt}>{isDark ? '☀️' : '🌙'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── WebView area + sidebar ─────────────────────────── */}
      <View style={S.body}>
        <View style={S.wvArea}>
          {tabs.map(tab => {
            const active = tab.id === activeId;
            return (
              <View
                key={tab.id}
                style={[S.wvWrap, active ? S.wvShow : S.wvHide]}
                pointerEvents={active ? 'auto' : 'none'}
              >
                <WebView
                  ref={r => { if (r) wvRefs.current.set(tab.id, r); else wvRefs.current.delete(tab.id); }}
                  source={{ uri: tab.url }}
                  userAgent={CHROME_UA}
                  allowsInlineMediaPlayback
                  mediaPlaybackRequiresUserAction={false}
                  allowsAirPlayForMediaPlayback
                  allowsFullscreenVideo
                  onFullscreenChange={e => handleFullscreen(e.nativeEvent.isFullscreen)}
                  javaScriptEnabled
                  domStorageEnabled
                  allowsBackForwardNavigationGestures={IS_IOS}
                  mixedContentMode="always"
                  onLoadStart={() => updateTab(tab.id, { isLoading: true })}
                  onLoadEnd={() => {
                    updateTab(tab.id, { isLoading: false });
                    const wv = wvRefs.current.get(tab.id);
                    wv?.injectJavaScript(EXTRACT_JS);
                    // Inject CWS fix + install button on Chrome Web Store pages
                    if (tab.url.includes('chromewebstore.google.com') ||
                        tab.url.includes('chrome.google.com/webstore')) {
                      wv?.injectJavaScript(CWS_INJECT_JS);
                    }
                  }}
                  onNavigationStateChange={nav => onNavState(tab.id, nav)}
                  onMessage={e => onMessage(tab.id, e)}
                  style={S.wv}
                />
              </View>
            );
          })}
        </View>

        {/* Desktop sidebar panel */}
        {IS_WEB && panelOpen && (
          <View style={S.desktopPanel}>
            <View style={S.panelHead}>
              <Text style={S.panelTitle}>{PANEL_LABELS[panelMode]}</Text>
              <TouchableOpacity onPress={closePanel} style={S.closeBtn}>
                <Text style={S.closeBtnTxt}>×</Text>
              </TouchableOpacity>
            </View>
            {renderPanelContent()}
          </View>
        )}
      </View>

      {/* ── Bottom toolbar (mobile + web) ─────────────────── */}
      {!isFullscreen && (
        <View style={[S.toolbar, { paddingBottom: insets.bottom }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={S.toolbarScroll}
            keyboardShouldPersistTaps="handled"
          >
            {/* 加書籤 / 移除書籤 — 直接操作當前頁 */}
            <TouchableOpacity
              style={[S.toolBtn, curBookmarked && S.toolBtnBookmarked]}
              onPress={toggleBookmark}
            >
              <Text style={[S.toolBtnTxt, curBookmarked && S.toolBtnTxtOn]}>
                {curBookmarked ? '★ 已加入' : '☆ 加書籤'}
              </Text>
            </TouchableOpacity>

            {BOTTOM_BTNS.map(b => (
              <TouchableOpacity
                key={b.mode}
                style={[S.toolBtn, isActive(b.mode) && S.toolBtnOn]}
                onPress={() => b.isAi ? runAiMode(b.mode as 'summary' | 'keypoints') : togglePanel(b.mode)}
              >
                <Text style={[S.toolBtnTxt, isActive(b.mode) && S.toolBtnTxtOn]}>
                  {b.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── Toast notification ────────────────────────────── */}
      {!!toast && (
        <View style={S.toast} pointerEvents="none">
          <Text style={S.toastText}>{toast}</Text>
        </View>
      )}

      {/* ── Mobile slide-up panel ──────────────────────────── */}
      {!IS_WEB && panelOpen && (
        <>
          {/* Backdrop — tap to close */}
          <Pressable style={S.backdrop} onPress={closePanel} />

          <Animated.View
            style={[S.mobilePanel, { transform: [{ translateY: slideAnim }] }]}
          >
            {/* Drag handle */}
            <View style={S.handle} />

            {/* Panel header */}
            <View style={S.panelHead}>
              {/* Mode switcher tabs */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={S.modeTabs}
                contentContainerStyle={S.modeTabsContent}
              >
                {BOTTOM_BTNS.map(b => (
                  <TouchableOpacity
                    key={b.mode}
                    style={[S.modeTab, panelMode === b.mode && S.modeTabOn]}
                    onPress={() => {
                      if (b.isAi) { runAiMode(b.mode as 'summary' | 'keypoints'); }
                      else { setPanelMode(b.mode);
                        if (b.mode === 'history') loadHistory().then(setHistoryItems);
                        if (b.mode === 'bookmarks') loadBookmarks().then(setBookmarkItems); }
                    }}
                  >
                    <Text style={[S.modeTabTxt, panelMode === b.mode && S.modeTabTxtOn]}>
                      {b.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <TouchableOpacity onPress={closePanel} style={S.closeBtn}>
                <Text style={S.closeBtnTxt}>×</Text>
              </TouchableOpacity>
            </View>

            {/* Content */}
            <View style={S.panelBody}>
              {renderPanelContent()}
            </View>
          </Animated.View>
        </>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────
function makeStyles(
  colors: any,
  isDark: boolean,
  insets: { top: number; bottom: number; left: number; right: number },
) {
  const line = isDark ? '#2a2a4a' : '#e0e0ee';

  return StyleSheet.create({
    root:         { flex: 1, backgroundColor: colors.bg },
    flex:         { flex: 1 },
    body:         { flex: 1, flexDirection: 'row' },

    // Top chrome
    topChrome:    { backgroundColor: colors.bg2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: line },

    // Tab bar
    tabBar:       { flexDirection: 'row', alignItems: 'center', height: 36 },
    tabScroll:    { alignItems: 'center', paddingHorizontal: 4 },
    tab:          { flexDirection: 'row', alignItems: 'center', width: TAB_W, height: 30, borderRadius: 6, paddingHorizontal: 8, marginHorizontal: 2, backgroundColor: isDark ? '#1a1a30' : '#e4e4f0' },
    tabActive:    { backgroundColor: colors.bg2, borderTopWidth: 2, borderTopColor: colors.accent },
    tabLabel:     { flex: 1, fontSize: 11, color: colors.textSub },
    tabLabelActive: { color: colors.text, fontWeight: '600' },
    tabX:         { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
    tabXText:     { fontSize: 15, color: colors.textSub },
    newTab:       { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
    newTabText:   { fontSize: 22, color: colors.accent, fontWeight: '300' },

    // Address bar
    addrBar:      { flexDirection: 'row', alignItems: 'center', height: 44, paddingHorizontal: 6, gap: 4 },
    navBtn:       { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
    navBtnOff:    { opacity: 0.3 },
    navBtnTxt:    { fontSize: 22, color: colors.text },
    urlInput:     { flex: 1, height: 36, backgroundColor: isDark ? '#1a1a30' : '#f0f0fa', borderRadius: 18, paddingHorizontal: 14, fontSize: 13, color: colors.text },

    // WebView
    wvArea:       { flex: 1 },
    wvWrap:       { ...StyleSheet.absoluteFillObject },
    wvShow:       { display: 'flex' },
    wvHide:       { display: 'none' },
    wv:           { flex: 1 },

    // Desktop panel
    desktopPanel: { width: SIDEBAR_W, backgroundColor: colors.bg2, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: line },

    // Panel header
    panelHead:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: line },
    panelTitle:   { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text },
    panelBody:    { flex: 1 },
    closeBtn:     { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: isDark ? '#2a2a4a' : '#e8e8f8' },
    closeBtnTxt:  { fontSize: 20, color: colors.textSub, lineHeight: 22 },

    // Mobile panel
    backdrop:     { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 10 },
    mobilePanel:  { position: 'absolute', left: 0, right: 0, bottom: 0, height: PANEL_H, backgroundColor: colors.bg2, borderTopLeftRadius: 18, borderTopRightRadius: 18, zIndex: 20, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.25, shadowRadius: 10, elevation: 20 },
    handle:       { width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#444' : '#ccc', alignSelf: 'center', marginTop: 10, marginBottom: 2 },

    // Mode switcher inside panel
    modeTabs:       { flex: 1 },
    modeTabsContent: { alignItems: 'center', paddingRight: 8 },
    modeTab:        { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, marginHorizontal: 2, backgroundColor: isDark ? '#1a1a30' : '#e8e8f4' },
    modeTabOn:      { backgroundColor: colors.accent },
    modeTabTxt:     { fontSize: 12, color: colors.textSub },
    modeTabTxtOn:   { color: '#fff', fontWeight: '600' },

    // Toolbar (bottom)
    toolbar:      { backgroundColor: colors.bg2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: line },
    toolbarScroll: { paddingHorizontal: 8, paddingVertical: 7, gap: 4 },
    toolBtn:      { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: isDark ? '#1a1a30' : '#e8e8f0', marginHorizontal: 2 },
    toolBtnOn:    { backgroundColor: colors.accent },
    toolBtnTxt:        { fontSize: 12, color: colors.text, fontWeight: '500' },
    toolBtnTxtOn:      { color: '#fff' },
    toolBtnBookmarked: { backgroundColor: '#f5c518' },

    // Scroll / content
    scrollPad:    { padding: 16 },
    outputText:   { fontSize: 14, lineHeight: 22, color: colors.text },
    placeholder:  { fontSize: 13, color: colors.textSub, textAlign: 'center', marginTop: 24 },
    placeholderSub: { fontSize: 11, color: colors.textSub, textAlign: 'center', marginTop: 6 },
    emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    emptyBox:     { alignItems: 'center', marginTop: 40 },
    emptyIcon:    { fontSize: 40, marginBottom: 8 },

    // Chat
    bubble:       { maxWidth: '85%', borderRadius: 14, padding: 10, marginVertical: 3 },
    bubbleUser:   { alignSelf: 'flex-end', backgroundColor: colors.accent, borderBottomRightRadius: 4 },
    bubbleAI:     { alignSelf: 'flex-start', backgroundColor: isDark ? '#1a1a30' : '#eeeef8', borderBottomLeftRadius: 4 },
    bubbleText:   { fontSize: 13, lineHeight: 20 },
    bubbleUserText: { color: '#fff' },
    bubbleAIText: { color: colors.text },
    chatInputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, paddingBottom: Math.max(insets.bottom, 10), gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: line, backgroundColor: colors.bg2 },
    chatInput:    { flex: 1, minHeight: 38, maxHeight: 100, backgroundColor: isDark ? '#1a1a30' : '#f0f0fa', borderRadius: 19, paddingHorizontal: 14, paddingVertical: 8, fontSize: 14, color: colors.text },
    sendBtn:      { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    sendBtnDisabled: { opacity: 0.4 },
    sendBtnText:  { color: '#fff', fontSize: 16 },

    // List items
    listItem:     { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: line },
    listItemRow:  { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: line },
    listItemMain: { flex: 1, paddingHorizontal: 16, paddingVertical: 10 },
    listTitle:    { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 2 },
    listUrl:      { fontSize: 11, color: colors.textSub },
    deleteBtn:    { paddingHorizontal: 14, paddingVertical: 10 },
    deleteText:   { fontSize: 18 },

    // CWS install button
    cwsBtn:    { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, backgroundColor: '#6c63ff', marginHorizontal: 2, justifyContent: 'center', alignItems: 'center' },
    cwsBtnTxt: { fontSize: 11, color: '#fff', fontWeight: '700' },

    // Extension icons in address bar
    extIconBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 6, marginHorizontal: 1 },
    extIcon:    { width: 18, height: 18, borderRadius: 3 },

    // Toast
    toast:     { position: 'absolute', top: 90, alignSelf: 'center', backgroundColor: 'rgba(30,30,60,0.92)', borderRadius: 14, paddingHorizontal: 20, paddingVertical: 12, zIndex: 200 },
    toastText: { color: '#fff', fontSize: 13, fontWeight: '600' },

    // Settings
    settingsLabel: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: 4, marginTop: 8 },
    settingsHint:  { fontSize: 11, color: colors.textSub, marginBottom: 10, lineHeight: 16 },
    settingsInput: { backgroundColor: isDark ? '#1a1a30' : '#f0f0fa', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, color: colors.text, marginBottom: 14 },
    saveBtn:       { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
    saveBtnText:   { color: '#fff', fontWeight: '700', fontSize: 14 },
  });
}
