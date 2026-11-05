import type { PluginActiveScreen } from "@getpaseo/plugin/client";
import { parsePluginSurfaceRoute, pluginScreenParamsFromRoute } from "./routes";

export interface ScreenRouterLike {
  canGoBack(): boolean;
  back(): void;
  replace(route: string): void;
}

export type ScreenSearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** Classifies the route on top: a plugin screen with its params, else a page. */
export function parsePluginActiveScreen(
  pathname: string,
  searchParams: ScreenSearchParams,
): PluginActiveScreen {
  const surface = parsePluginSurfaceRoute(pathname);
  if (surface) {
    return {
      kind: "plugin-screen",
      serverId: surface.serverId,
      pluginId: surface.pluginId,
      screenId: surface.identity.id,
      params: pluginScreenParamsFromRoute(searchParams),
    };
  }
  return { kind: "page", route: pathname };
}

function screensEqual(a: PluginActiveScreen | null, b: PluginActiveScreen | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface PluginScreenNavigationState {
  getActiveScreen(): PluginActiveScreen | null;
  subscribeScreen(listener: (screen: PluginActiveScreen | null) => void): () => void;
  setActiveScreen(screen: PluginActiveScreen): void;
  canGoBack(): boolean;
  goBack(): boolean;
  closeScreen(): boolean;
}

export function createPluginScreenNavigation(
  router: ScreenRouterLike,
): PluginScreenNavigationState {
  let activeScreen: PluginActiveScreen | null = null;
  const listeners = new Set<(screen: PluginActiveScreen | null) => void>();

  return {
    getActiveScreen: () => activeScreen,
    subscribeScreen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setActiveScreen(screen) {
      if (screensEqual(screen, activeScreen)) return;
      activeScreen = screen;
      for (const listener of listeners) listener(screen);
    },
    canGoBack: () => router.canGoBack(),
    goBack() {
      if (!router.canGoBack()) return false;
      router.back();
      return true;
    },
    closeScreen() {
      const screen = activeScreen;
      if (!screen || screen.kind !== "plugin-screen") return false;
      // The same logic as the screen header's own close button.
      if (router.canGoBack()) router.back();
      else router.replace(`/h/${encodeURIComponent(screen.serverId)}`);
      return true;
    },
  };
}
