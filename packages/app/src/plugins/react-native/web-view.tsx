import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView as NativeWebView } from "react-native-webview";
import type { WebViewHandle, WebViewProps } from "@getpaseo/plugin/client/react-native";
import { allowsWebViewNavigation } from "./web-view-navigation";
import { createWebViewOutbox } from "./web-view-outbox";

// The whitelist matches everything so every scheme reaches the guard, and the base URL is inert
// so only inert URLs can pass as the initial document. file-pane/html-preview.tsx explains both.
const ORIGIN_WHITELIST = ["*"];
const BASE_URL = "about:blank";

export const WebView = forwardRef<WebViewHandle, WebViewProps>(function WebView(
  { html, onMessage, onError, style, scrollEnabled = true, testID },
  ref,
) {
  const webViewRef = useRef<NativeWebView>(null);
  const callbacksRef = useRef({ onMessage, onError });
  callbacksRef.current = { onMessage, onError };
  const source = useMemo(() => ({ html, baseUrl: BASE_URL }), [html]);
  const outbox = useMemo(
    () =>
      createWebViewOutbox((data) => {
        webViewRef.current?.injectJavaScript(
          `window.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(data)} })); true;`,
        );
      }),
    [],
  );

  useEffect(() => {
    outbox.reset();
  }, [outbox, source]);

  useImperativeHandle(ref, () => ({ postMessage: outbox.post }), [outbox]);

  const handleLoadEnd = useCallback(() => outbox.loaded(), [outbox]);
  const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    callbacksRef.current.onMessage?.(event.nativeEvent.data);
  }, []);
  const handleError = useCallback((event: { nativeEvent: { description: string } }) => {
    callbacksRef.current.onError?.(new Error(event.nativeEvent.description));
  }, []);
  const handleTerminated = useCallback(() => {
    callbacksRef.current.onError?.(new Error("The web content process stopped"));
  }, []);

  return (
    <View style={style} testID={testID}>
      <NativeWebView
        ref={webViewRef}
        style={styles.webView}
        source={source}
        originWhitelist={ORIGIN_WHITELIST}
        onShouldStartLoadWithRequest={allowsWebViewNavigation}
        onMessage={handleMessage}
        onLoadEnd={handleLoadEnd}
        onError={handleError}
        onContentProcessDidTerminate={handleTerminated}
        onRenderProcessGone={handleTerminated}
        scrollEnabled={scrollEnabled}
        nestedScrollEnabled
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowsLinkPreview={false}
        domStorageEnabled={false}
        thirdPartyCookiesEnabled={false}
        cacheEnabled={false}
        incognito
      />
    </View>
  );
});

const styles = StyleSheet.create({
  webView: { flex: 1, backgroundColor: "transparent" },
});
