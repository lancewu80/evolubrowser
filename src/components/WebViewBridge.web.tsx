/**
 * WebViewBridge.web.tsx
 * Web / Electron platform implementation.
 * Uses Electron's <webview> tag when available, falls back to <iframe>.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { View } from 'react-native';

// Detect Electron renderer process
const IS_ELECTRON =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.toLowerCase().includes('electron');

const electronAPI = IS_ELECTRON ? (window as any).electronAPI : null;

// ── Shared ref interface (matches react-native-webview subset) ──
export interface WebViewBridgeRef {
  goBack:            () => void;
  goForward:         () => void;
  reload:            () => void;
  stopLoading:       () => void;
  injectJavaScript:  (js: string) => void;
  openDevTools:      (mode?: string) => void;
  getWebContentsId:  () => number | null;
}

// ── Props ──────────────────────────────────────────────────────
export interface WebViewBridgeProps {
  source:                           { uri: string };
  userAgent?:                       string;
  style?:                           any;
  onLoadStart?:                     () => void;
  onLoadEnd?:                       () => void;
  onNavigationStateChange?:         (nav: NavState) => void;
  onMessage?:                       (event: { nativeEvent: { data: string } }) => void;
  onFullscreenChange?:              (e: { nativeEvent: { isFullscreen: boolean } }) => void;
  allowsInlineMediaPlayback?:       boolean;
  mediaPlaybackRequiresUserAction?: boolean;
  allowsFullscreenVideo?:           boolean;
  javaScriptEnabled?:               boolean;
  domStorageEnabled?:               boolean;
  mixedContentMode?:                string;
  allowsBackForwardNavigationGestures?: boolean;
  onContextMenuOpenNewTab?:         (url: string) => void;
  onContextMenuCopyLink?:           (url: string) => void;
  onWebContentsIdReady?:           (id: number) => void;
}

interface NavState {
  url:          string;
  title:        string;
  canGoBack:    boolean;
  canGoForward: boolean;
  loading:      boolean;
}

// ── Context menu injector ──────────────────────────────────────
// Injected into every page to intercept right-click / long-press on links and text.
// Sends context menu data via postMessage (bypasses Electron's <webview> context-menu event).
const CONTEXT_MENU_SHIM = `
(function(){
  if (window.__lbCtxInstalled) return;
  window.__lbCtxInstalled = true;

  document.addEventListener('contextmenu', function(e) {
    var sel = window.getSelection();
    var selectedText = sel && sel.toString && sel.toString().trim();
    var a = e.target.closest && e.target.closest('a');
    var href = '';
    if (a) {
      var h = a.href || a.getAttribute('href') || '';
      if (h && !h.startsWith('javascript:')) href = h;
    }

    var type = 'page';
    if (selectedText && selectedText.length > 0 && selectedText.length < 5000) {
      type = 'text';
    } else if (href) {
      type = 'link';
    }

    window.__rnwv_msg = JSON.stringify({
      type: 'contextmenu',
      ctxType: type,
      ctxUrl: href,
      ctxText: selectedText || ''
    });
  }, true);
})();
`;

// Shim injected before EXTRACT_JS so postMessage works
const SHIM = `
  if (!window.ReactNativeWebView) {
    window.ReactNativeWebView = {
      postMessage: function(data) { window.__rnwv_msg = data; }
    };
  }
`;

// ── Electron <webview> implementation ─────────────────────────
const ElectronWebView = forwardRef<WebViewBridgeRef, WebViewBridgeProps>(
  (props, ref) => {
    const {
      source, userAgent, style,
      onLoadStart, onLoadEnd,
      onNavigationStateChange, onMessage,
      onContextMenuOpenNewTab, onContextMenuCopyLink,
    } = props;

    const wvRef = useRef<any>(null);
    const initialSrcRef = useRef(source.uri);
    const internalNavSeqRef = useRef(0);
    const lastWebViewUrlRef = useRef(source.uri);
    // Tracks whether the webview DOM is ready (dom-ready emitted)
    const domReadyRef = useRef(false);
    // Queue of executeJavaScript calls made before dom-ready
    const pendingJSRef = useRef<Array<{ js: string; resolve?: (value: any) => void }>>([]);

    // Helper: wait for dom-ready then execute JS
    const safeExecJS = useCallback(async (js: string): Promise<any> => {
      const el = wvRef.current;
      if (!el) return;
      // If dom-ready hasn't fired yet, queue it
      if (!domReadyRef.current) {
        return new Promise((resolve) => {
          pendingJSRef.current.push({ js, resolve });
        });
      }
      return el.executeJavaScript(js);
    }, []);

    // Drain queue whenever dom-ready becomes true
    const drainPending = useCallback(async () => {
      const el = wvRef.current;
      if (!el || !domReadyRef.current) return;
      const queue = pendingJSRef.current;
      pendingJSRef.current = [];
      for (const item of queue) {
        try {
          const result = await el.executeJavaScript(item.js);
          item.resolve?.(result);
        } catch (e) {
          item.resolve?.(undefined);
        }
      }
    }, []);

    useImperativeHandle(ref, () => ({
      goBack:      () => wvRef.current?.goBack(),
      goForward:   () => wvRef.current?.goForward(),
      reload:      () => {
        if (wvRef.current) {
          wvRef.current.reload();
          domReadyRef.current = false;
          internalNavSeqRef.current = 0;
        }
      },
      stopLoading: () => wvRef.current?.stop(),
      injectJavaScript: async (js: string) => {
        try {
          // Wait for the shim + user script to execute
          await safeExecJS(SHIM + js);
          // Retrieve the postMessage payload
          const data = await safeExecJS('window.__rnwv_msg || null');
          if (data && onMessage) {
            onMessage({ nativeEvent: { data } });
          }
        } catch (e) {
          console.warn('[WebViewBridge] injectJavaScript error:', e);
        }
      },
      openDevTools: (mode?: string) => {
        const el = wvRef.current;
        if (!el || !electronAPI) return;
        const id = el.getWebContentsId();
        if (id) {
          electronAPI.openWebviewDevTools(id, mode || 'right');
        }
      },
      getWebContentsId: () => {
        return wvRef.current?.getWebContentsId?.() ?? null;
      },
    }), [onMessage, safeExecJS]);

    // ── Lifecycle events ──────────────────────────────────────
    useEffect(() => {
      const el = wvRef.current;
      if (!el) return;

      const onStart  = () => onLoadStart?.();
      const onFinish = () => onLoadEnd?.();

      const onDomReady = () => {
        domReadyRef.current = true;
        // Inject context menu shim now that DOM is safe
        try { el.executeJavaScript(CONTEXT_MENU_SHIM); } catch {}
        // Drain any pending executeJavaScript calls
        drainPending();
        // Report webContentsId to parent
        try {
          const wcId = el.getWebContentsId();
          if (wcId && props.onWebContentsIdReady) {
            props.onWebContentsIdReady(wcId);
          }
        } catch {}
      };

      const onNavigate = async () => {
        if (!onNavigationStateChange) return;
        const seq = ++internalNavSeqRef.current;
        try {
          const [url, title, canGoBack, canGoForward] = await Promise.all([
            el.getURL?.() ?? el.src,
            el.getTitle?.() ?? '',
            el.canGoBack?.()    ?? false,
            el.canGoForward?.() ?? false,
          ]);
          if (seq !== internalNavSeqRef.current) return;
          lastWebViewUrlRef.current = url;
          onNavigationStateChange({ url, title, canGoBack, canGoForward, loading: false });
        } catch {
          // ignore
        }
      };

      // ── Context menu via ipc-message ────────────────────────
      // Shim posts JSON to window.ReactNativeWebView which sets __rnwv_msg.
      // Electron's <webview> fires ipc-message when the page uses
      // window.postMessage() or ipcRenderer.sendToHost().
      // We inject a small script after dom-ready to relay via
      // <webview>.sendToHost() — but that requires enableRemoteModule.
      // Simpler: poll __rnwv_msg via a periodic interval in a
      // lightweight executeJavaScript call from the context-menu event.
      const onContextMenu = async () => {
        if (!electronAPI) return;
        try {
          const raw = await el.executeJavaScript('(function(){var m=window.__rnwv_msg;window.__rnwv_msg=null;return m||null})()');
          if (raw) {
            try {
              const data = JSON.parse(raw);
              if (data.type === 'contextmenu') {
                if (data.ctxType === 'text' && data.ctxText) {
                  electronAPI.showTextContextMenu(data.ctxText);
                  return;
                }
                if (data.ctxType === 'link' && data.ctxUrl) {
                  electronAPI.showLinkContextMenu(data.ctxUrl);
                  return;
                }
              }
            } catch {}
          }
          // Fallback: plain page context menu
          electronAPI.showPageContextMenu();
        } catch (e) {
          console.error('[context-menu] error:', e);
        }
      };

      // Handle new-window events — redirect to same webview
      // (fixes Google News links and other target=_blank sites)
      const onNewWindow = (e: any) => {
        if (e.url) {
          e.preventDefault();
          try { el.loadURL(e.url); } catch {}
        }
      };

      el.addEventListener('did-start-loading',    onStart);
      el.addEventListener('did-stop-loading',     onFinish);
      el.addEventListener('did-finish-load',      () => {
        onFinish();
      });
      el.addEventListener('dom-ready',            onDomReady);
      el.addEventListener('did-navigate',         onNavigate);
      el.addEventListener('did-navigate-in-page', onNavigate);
      el.addEventListener('context-menu',         onContextMenu);
      el.addEventListener('new-window',           onNewWindow);

      return () => {
        el.removeEventListener('did-start-loading',    onStart);
        el.removeEventListener('did-stop-loading',     onFinish);
        el.removeEventListener('did-finish-load',      onFinish);
        el.removeEventListener('dom-ready',            onDomReady);
        el.removeEventListener('did-navigate',         onNavigate);
        el.removeEventListener('did-navigate-in-page', onNavigate);
        el.removeEventListener('context-menu',         onContextMenu);
        el.removeEventListener('new-window',           onNewWindow);
      };
    }, [onLoadStart, onLoadEnd, onNavigationStateChange, onContextMenuOpenNewTab, onContextMenuCopyLink, drainPending]);

    // Reset dom-ready on URL change (new page navigation)
    useEffect(() => {
      if (!wvRef.current) return;
      const newUrl = source.uri;
      if (wvRef.current.src === newUrl || lastWebViewUrlRef.current === newUrl) {
        return;
      }
      domReadyRef.current = false;
      internalNavSeqRef.current = 0;
      wvRef.current.src = newUrl;
    }, [source.uri]);


    return (
      <View style={[{ flex: 1, overflow: 'hidden' }, style]}>
        {/* @ts-ignore — webview is an Electron-specific HTML element */}
        <webview
          ref={wvRef}
          src={initialSrcRef.current}
          useragent={userAgent}
          allowpopups
          style={{ width: '100%', height: '100%', display: 'flex' }}
          webpreferences="allowRunningInsecureContent=yes, autoplay=yes, javascript=yes, backgroundThrottling=false"
          allow="autoplay; fullscreen; camera; microphone"
        />
      </View>
    );
  }
);

// ── iframe fallback (non-Electron browser) ─────────────────────
const IFrameWebView = forwardRef<WebViewBridgeRef, WebViewBridgeProps>(
  (props, ref) => {
    const { source, style, onLoadStart, onLoadEnd } = props;
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const ctxInjectedRef = useRef(false);

    useImperativeHandle(ref, () => ({
      goBack:           () => window.history.back(),
      goForward:        () => window.history.forward(),
      reload:           () => iframeRef.current?.contentWindow?.location.reload(),
      stopLoading:      () => {},
      injectJavaScript: () => { /* cross-origin blocked */ },
      openDevTools:     () => {},
      getWebContentsId: () => null,
    }));

    // Context menu support for iframe (same-origin only)
    useEffect(() => {
      const iframe = iframeRef.current;
      if (!iframe || ctxInjectedRef.current) return;
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          const script = doc.createElement('script');
          script.textContent = CONTEXT_MENU_SHIM;
          doc.body.appendChild(script);
          ctxInjectedRef.current = true;
        }
      } catch {
        // cross-origin — ignore
      }
    }, [source.uri]);

    return (
      <View style={[{ flex: 1, overflow: 'hidden' }, style]}>
        {/* @ts-ignore */}
        <iframe
          ref={iframeRef}
          src={source.uri}
          style={{ width: '100%', height: '100%', border: 'none' }}
          allow="autoplay; fullscreen; camera; microphone"
          allowFullScreen
          onLoad={onLoadEnd}
        />
      </View>
    );
  }
);

// ── Export the right one based on platform ─────────────────────
const WebViewBridge = IS_ELECTRON ? ElectronWebView : IFrameWebView;
export default WebViewBridge;
