import { describe, expect, test, vi } from "vitest";
import { createPluginScreenNavigation, parsePluginActiveScreen } from "./screen-navigation-model";

describe("parsePluginActiveScreen", () => {
  test("reads a plugin screen with its params", () => {
    expect(
      parsePluginActiveScreen("/h/srv1/plugin/plg1/surface/main", {
        "param.tab": "a",
        unrelated: "b",
        serverId: "srv1",
      }),
    ).toEqual({
      kind: "plugin-screen",
      serverId: "srv1",
      pluginId: "plg1",
      screenId: "main",
      params: { tab: "a" },
    });
  });

  test("decodes segments and reads sidebar screens", () => {
    expect(parsePluginActiveScreen("/h/a%20b/plugin/p/sidebar/s", {})).toEqual({
      kind: "plugin-screen",
      serverId: "a b",
      pluginId: "p",
      screenId: "s",
      params: {},
    });
  });

  test("classifies every other route as a page", () => {
    expect(parsePluginActiveScreen("/settings/appearance", {})).toEqual({
      kind: "page",
      route: "/settings/appearance",
    });
    expect(parsePluginActiveScreen("/", {})).toEqual({ kind: "page", route: "/" });
  });
});

function setupRouter(canGoBack = true) {
  const back = vi.fn();
  const replace = vi.fn();
  const navigation = createPluginScreenNavigation({
    canGoBack: () => canGoBack,
    back,
    replace,
  });
  return { back, replace, navigation };
}

describe("plugin screen navigation", () => {
  test("starts empty and publishes each distinct screen once", () => {
    const { navigation } = setupRouter();
    expect(navigation.getActiveScreen()).toBeNull();
    const listener = vi.fn();
    const unsubscribe = navigation.subscribeScreen(listener);
    const screen = {
      kind: "plugin-screen",
      serverId: "s",
      pluginId: "p",
      screenId: "m",
      params: {},
    } as const;
    navigation.setActiveScreen(screen);
    navigation.setActiveScreen({ ...screen });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(navigation.getActiveScreen()).toEqual(screen);
    unsubscribe();
    navigation.setActiveScreen({ kind: "page", route: "/sessions" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("goBack follows the router", () => {
    expect(setupRouter(true).navigation.goBack()).toBe(true);
    const { back, navigation } = setupRouter(false);
    expect(navigation.goBack()).toBe(false);
    expect(back).not.toHaveBeenCalled();
    expect(navigation.canGoBack()).toBe(false);
  });

  test("closeScreen backs out of a plugin screen", () => {
    const { back, navigation } = setupRouter(true);
    expect(navigation.closeScreen()).toBe(false);
    navigation.setActiveScreen({ kind: "page", route: "/sessions" });
    expect(navigation.closeScreen()).toBe(false);
    expect(back).not.toHaveBeenCalled();
    navigation.setActiveScreen({
      kind: "plugin-screen",
      serverId: "s",
      pluginId: "p",
      screenId: "m",
      params: {},
    });
    expect(navigation.closeScreen()).toBe(true);
    expect(back).toHaveBeenCalledOnce();
  });

  test("closeScreen falls back to the host without history", () => {
    const { replace, navigation } = setupRouter(false);
    navigation.setActiveScreen({
      kind: "plugin-screen",
      serverId: "a b",
      pluginId: "p",
      screenId: "m",
      params: {},
    });
    expect(navigation.closeScreen()).toBe(true);
    expect(replace).toHaveBeenCalledWith("/h/a%20b");
  });
});
