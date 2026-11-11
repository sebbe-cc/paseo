// A plugin's `runtimeExternals` name packages its server bundle leaves to Node: an exact
// package name (which also covers its subpaths) or an `@scope/*` pattern for a whole scope.
// esbuild reads the same two forms for `external`, so the compiler passes them through.
export function matchesRuntimeExternal(
  specifier: string,
  runtimeExternals: readonly string[],
): boolean {
  return runtimeExternals.some((pattern) =>
    pattern.endsWith("/*")
      ? specifier.startsWith(pattern.slice(0, -1))
      : specifier === pattern || specifier.startsWith(`${pattern}/`),
  );
}
