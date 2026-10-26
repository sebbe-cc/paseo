import type { ForwardRefExoticComponent, RefAttributes } from "react";
import type { StyleProp, ViewStyle } from "react-native";

// COMPAT(pluginReactNativeEntrypoint): added in v0.13.0, remove after 2027-04-20
/** @deprecated Import Paseo UI from @getpaseo/plugin/client/ui. */
export * from "./ui.js";

/** @deprecated Render StreamedText from @getpaseo/plugin/client/ui. Removed after 2027-04-20 with this entry. */
export declare function useRevealedText(text: string, phase: "streaming" | "complete"): string;

export interface WebViewProps {
  /** The document to render. A new value loads a new document. */
  html: string;
  /** Receives text the page sends with `window.ReactNativeWebView.postMessage(text)`. */
  onMessage?(data: string): void;
  /** The document failed to load or its web content process stopped. Native only. */
  onError?(error: Error): void;
  /** Sizes the view. Give it a height, or `flex: 1` inside a bounded parent. */
  style?: StyleProp<ViewStyle>;
  /** Default true. Native only. */
  scrollEnabled?: boolean;
  testID?: string;
}

export interface WebViewHandle {
  /** Delivers text to the page as a `message` event on `window`. Waits for the document to load. */
  postMessage(data: string): void;
}

/**
 * One HTML document in an isolated frame: a sandboxed iframe on web and the app's web view on
 * iOS and Android. The document loads once, later navigations are refused, and it has no storage,
 * cookies, or windows. Messages are strings in both directions.
 */
export declare const WebView: ForwardRefExoticComponent<
  WebViewProps & RefAttributes<WebViewHandle>
>;
