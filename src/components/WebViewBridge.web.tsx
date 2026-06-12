/**
 * WebViewBridge.web.tsx
 * Web / Electron platform implementation.
 * Uses Electron's <webview> tag when available, falls back to <iframe>.
 */
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { View } from 'react-native';

// Detect Electron renderer process
const IS_ELECTRON =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.toLowerCase().includes('electron');

// ── Shared ref interface (matches react-native-webview subset) ──
export interface WebViewBridgeRef {
  goBack:            () => void;
  goForward:         () => void;
  reload:            () => void;
  stopLoading:       () => void;
  injectJavaScript:  (js: string) => void;
}

// ── Props (subset of react-native-webview WebViewProps) ────────
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
}

interface NavState {
  url:          string;
  title:        string;
  canGoBack:    boolean;
  canGoForward: boolean;
  loading:      boolean;
}

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
    } = props;

    const wvRef = useRef<any>(null);
    // Lock the initial URL into a ref so JSX always sees the SAME string value.
    // If we wrote src={source.uri}, React's reconciler would update the <webview>
    // src attribute every time tab.url changes (e.g. YouTube in-page navigation),
    // and setting src on an Electron <webview> triggers a full page reload.
    // Instead we freeze the JSX src and manage all subsequent navigations via
    // wvRef.current.src = ... in the useEffect below.
    const initialSrcRef = useRef(source.uri);
    // Guards against feeding the webview's own in-page navigation back to it:
    // did-navigate-in-page → onNavState → source.uri changes → useEffect →
    // if we set src here the page would reload. The flag breaks that cycle.
    // We use a counter-based approach instead of a simple boolean to handle
    // async race conditions where multiple onNavigate calls overlap (e.g. YouTube
    // SPA triggering rapid did-navigate-in-page events during page load).
    const internalNavSeqRef = useRef(0);
    // Track the latest URL we KNOW was set by the webview itself (not by us),
    // so we can avoid re-setting it and triggering a reload.
    const lastWebViewUrlRef = useRef(source.uri);

    useImperativeHandle(ref, () => ({
      goBack:      () => wvRef.current?.goBack(),
      goForward:   () => wvRef.current?.goForward(),
      reload:      () => {
        if (wvRef.current) {
          wvRef.current.reload();
          // After a manual reload, assume the webview is going back to
          // wherever source.uri points — don't let internal-navigation
          // guard block it
          internalNavSeqRef.current = 0;
        }
      },
      stopLoading: () => wvRef.current?.stop(),
      injectJavaScript: async (js: string) => {
        if (!wvRef.current) return;
        try {
          // Inject shim + user script
          await wvRef.current.executeJavaScript(SHIM + js);
          // Retrieve the postMessage payload
          const data = await wvRef.current.executeJavaScript(
            'window.__rnwv_msg || null'
          );
          if (data && onMessage) {
            onMessage({ nativeEvent: { data } });
          }
        } catch (e) {
          console.warn('[WebViewBridge] injectJavaScript error:', e);
        }
      },
    }), [onMessage]);

    useEffect(() => {
      const el = wvRef.current;
      if (!el) return;

      const onStart  = () => onLoadStart?.();
      const onFinish = () => onLoadEnd?.();

      // Each onNavigate call gets a unique sequence number. When the async
      // call resolves, only the most recent sequence number actually updates
      // the parent — older (overlapped) calls are discarded. This prevents
      // YouTube SPA rapid-fire did-navigate-in-page from causing a reload loop.
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
          // Only the latest onNavigate call gets to update the parent
          if (seq !== internalNavSeqRef.current) return;
          lastWebViewUrlRef.current = url;
          onNavigationStateChange({ url, title, canGoBack, canGoForward, loading: false });
        } catch {
          // ignore
        }
      };

      el.addEventListener('did-start-loading',  onStart);
      el.addEventListener('did-stop-loading',   onFinish);
      el.addEventListener('did-finish-load',    onFinish);
      el.addEventListener('did-navigate',       onNavigate);
      el.addEventListener('did-navigate-in-page', onNavigate);

      return () => {
        el.removeEventListener('did-start-loading',  onStart);
        el.removeEventListener('did-stop-loading',   onFinish);
        el.removeEventListener('did-finish-load',    onFinish);
        el.removeEventListener('did-navigate',       onNavigate);
        el.removeEventListener('did-navigate-in-page', onNavigate);
      };
    }, [onLoadStart, onLoadEnd, onNavigationStateChange]);

    // Update src only for user-initiated URL changes (address bar, navigate()).
    // If the URL is already where the webview currently is (from internal nav),
    // skip it to avoid an unwanted full reload.
    useEffect(() => {
      if (!wvRef.current) return;
      const newUrl = source.uri;
      // Avoid reloading when the webview is already at this URL via in-page nav
      if (wvRef.current.src === newUrl || lastWebViewUrlRef.current === newUrl) {
        return;
      }
      // Reset the seq counter so overlapping in-flight onNavigate calls won't
      // update lastWebViewUrlRef after we set src
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
          allowpopups="true"
          style={{ width: '100%', height: '100%', display: 'flex' }}
          webpreferences="allowRunningInsecureContent=yes, autoplay=yes, javascript=yes"
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

    useImperativeHandle(ref, () => ({
      goBack:           () => window.history.back(),
      goForward:        () => window.history.forward(),
      reload:           () => iframeRef.current?.contentWindow?.location.reload(),
      stopLoading:      () => {},
      injectJavaScript: () => { /* cross-origin blocked */ },
    }));

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
