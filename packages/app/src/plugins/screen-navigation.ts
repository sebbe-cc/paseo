import { useEffect } from "react";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import {
  createPluginScreenNavigation,
  parsePluginActiveScreen,
  type ScreenSearchParams,
} from "./screen-navigation-model";

export const pluginScreenNavigation = createPluginScreenNavigation(router);

export function setPluginActiveScreenFromRoute(
  pathname: string,
  searchParams: ScreenSearchParams,
): void {
  pluginScreenNavigation.setActiveScreen(parsePluginActiveScreen(pathname, searchParams));
}

/** Publishes the route on top to navigation.getActiveScreen(). Mount once at the root. */
export function usePublishPluginActiveScreen(): void {
  const pathname = usePathname();
  const searchParams = useGlobalSearchParams();
  useEffect(() => {
    setPluginActiveScreenFromRoute(pathname, searchParams);
  }, [pathname, searchParams]);
}
