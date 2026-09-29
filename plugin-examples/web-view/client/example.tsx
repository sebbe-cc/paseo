import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { WebView, type WebViewHandle } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { z } from "zod";

// The page runs whatever HTML it was given, so what it sends back is validated like any input.
const pageMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("clicks"), clicks: z.number().int().nonnegative() }),
]);

const pageHtml = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>
  body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; }
  button { font: inherit; padding: 8px 12px; }
</style>
<p>This page runs inside the plugin's WebView.</p>
<button id="count" type="button">Clicked 0 times</button>
<script>
  let clicks = 0;
  const button = document.getElementById("count");
  button.addEventListener("click", () => {
    clicks += 1;
    button.textContent = "Clicked " + clicks + " times";
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "clicks", clicks }));
  });
  window.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "theme") return;
    document.body.style.background = message.background;
    document.body.style.color = message.foreground;
  });
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: "ready" }));
</script>`;

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12 },
  frame: { height: 240, borderWidth: 1, borderRadius: 8, overflow: "hidden" },
});

export function WebViewExample({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const webView = useRef<WebViewHandle>(null);
  const [status, setStatus] = useState("Loading the page…");
  const [clicks, setClicks] = useState(0);
  const text = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const frame = useMemo(() => [styles.frame, { borderColor: theme.colors.border }], [theme]);

  const onMessage = useCallback((data: string) => {
    const message = pageMessageSchema.parse(JSON.parse(data));
    if (message.type === "ready") setStatus("The page is ready.");
    else setClicks(message.clicks);
  }, []);
  const onError = useCallback((error: Error) => setStatus(error.message), []);

  useEffect(() => {
    webView.current?.postMessage(
      JSON.stringify({
        type: "theme",
        background: theme.colors.surface1,
        foreground: theme.colors.foreground,
      }),
    );
  }, [theme]);

  return (
    <View style={styles.screen}>
      <Text style={text}>{status}</Text>
      <Text style={text}>The page reported {clicks} clicks.</Text>
      <WebView
        ref={webView}
        html={pageHtml}
        onMessage={onMessage}
        onError={onError}
        style={frame}
      />
    </View>
  );
}
