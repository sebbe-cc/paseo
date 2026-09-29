import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { View } from "react-native";
import type { WebViewHandle, WebViewProps } from "@getpaseo/plugin/client/react-native";
import { createWebViewOutbox } from "./web-view-outbox";

// `allow-scripts` alone: an opaque origin with no storage, no parent access, no top navigation,
// and no popups. file-pane/html-preview.web.tsx explains the choice.
const SANDBOX = "allow-scripts";

// The page gets the same send API it has on native. The shim is supplied ahead of the page's own
// doctype, for the reasons file-pane/html-preview-csp.ts gives for its prologue.
const BRIDGE =
  '<script>window.ReactNativeWebView={postMessage:function(d){parent.postMessage(String(d),"*")}}</script>';
const PROLOGUE = `<!doctype html>${BRIDGE}`;
const BOM = "\uFEFF";

function withWebViewBridge(html: string): string {
  return PROLOGUE + (html.startsWith(BOM) ? html.slice(BOM.length) : html);
}

export const WebView = forwardRef<WebViewHandle, WebViewProps>(function WebView(
  { html, onMessage, style, testID },
  ref,
) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const document = useMemo(() => withWebViewBridge(html), [html]);
  const outbox = useMemo(
    () =>
      createWebViewOutbox((data) => {
        frameRef.current?.contentWindow?.postMessage(data, "*");
      }),
    [],
  );

  useEffect(() => {
    outbox.reset();
  }, [outbox, document]);

  useImperativeHandle(ref, () => ({ postMessage: outbox.post }), [outbox]);

  const handleLoad = useCallback(() => outbox.loaded(), [outbox]);

  useEffect(() => {
    function receive(event: MessageEvent): void {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (typeof event.data !== "string") return;
      onMessageRef.current?.(event.data);
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  return (
    <View style={style} testID={testID}>
      <iframe
        ref={frameRef}
        title=""
        sandbox={SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={document}
        onLoad={handleLoad}
        style={frameStyle}
      />
    </View>
  );
});

const frameStyle = {
  flex: 1,
  minHeight: 0,
  width: "100%",
  border: "none",
  display: "block",
} as const;
