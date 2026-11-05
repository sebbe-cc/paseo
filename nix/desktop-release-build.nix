{ desktop }:
# Build outputs of the fork desktop app, without version stamping or signing. Nothing here reads the
# commit, so Gradient's path: evaluation and publish-mac's github: ref share this drv and its cache.
desktop.overrideAttrs (old: {
  pname = "paseo-desktop-release-build";

  buildPhase = ''
    runHook preBuild

    touch "$NIX_BUILD_TOP/build-start"
    npm run build:server
    npm run build --workspace=@getpaseo/expo-two-way-audio
    ( cd packages/app && PASEO_WEB_PLATFORM=electron npx expo export --platform web )
    npm run build:main --workspace=@getpaseo/desktop

    runHook postBuild
  '';

  # Everything the build wrote under packages/, laid out as in the source tree; desktop-release copies it back.
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    find packages -type f -newer "$NIX_BUILD_TOP/build-start" -not -path '*/node_modules/*' -print0 \
      | tar --null -cf - -T - | tar -xf - -C "$out"
    runHook postInstall
  '';

  dontFixup = true;

  meta = old.meta // {
    description = "Unstamped build outputs of the sebbe-cc/paseo desktop release";
    platforms = [ "aarch64-darwin" ];
  };
})
