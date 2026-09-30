import type {
  ComponentType,
  FunctionComponent,
  ReactNode,
  ForwardRefExoticComponent,
  RefAttributes,
  ReactElement,
  Ref,
} from "react";
import type {
  StyleProp,
  ViewStyle,
  ScrollView as NativeScrollView,
  ScrollViewProps,
  FlatList as NativeFlatList,
  FlatListProps,
  TextInput as NativeTextInput,
  TextInputProps,
} from "react-native";
import type { PluginIconProps } from "./contracts.js";

export interface ModalProps {
  title: string;
  icon?: ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}

export interface ModalContentProps {
  children: ReactNode;
  /** Paint the full body below the header. */
  style?: StyleProp<ViewStyle>;
  /** Overrides the default 24px padding and 16px gap. Safe-area clearance stays host-owned. */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Default true. Set false for a bounded body with your own ScrollView or FlatList. */
  scrollable?: boolean;
}

export interface ModalComponent extends FunctionComponent<ModalProps> {
  Content: ComponentType<ModalContentProps>;
}

export type ToastVariant = "default" | "info" | "success" | "warning" | "error";

export interface ToastOptions {
  variant?: ToastVariant;
  durationMs?: number;
}

export interface ToastApi {
  show(message: string, options?: ToastOptions): void;
  error(message: string): void;
}

export declare const Icon: ComponentType<PluginIconProps>;
export declare const Modal: ModalComponent;
export declare function useToast(): ToastApi;
export declare function useRevealedText(text: string, phase: "streaming" | "complete"): string;

export type { PluginIconProps } from "./contracts.js";

/** React Native scrolling with the host's sheet gestures when rendered inside a sheet. */
export declare const ScrollView: ForwardRefExoticComponent<
  ScrollViewProps & RefAttributes<NativeScrollView>
>;
export declare function FlatList<Item>(
  props: FlatListProps<Item> & { ref?: Ref<NativeFlatList<Item>> },
): ReactElement;
/** Copies text to this client's clipboard. Rejects when copying is unavailable or denied. */
export declare function copyText(text: string): Promise<void>;

/** Native input focus integrated with modal keyboard positioning. */
export declare const TextInput: ForwardRefExoticComponent<
  TextInputProps & RefAttributes<NativeTextInput>
>;

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
