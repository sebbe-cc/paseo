{
  lib,
  fetchurl,
  openssl,
  rcodesign,
  python3Packages,
  desktop,
  buildVersion,
  releaseVersion,
  buildMetadata,
  # Read at build time from the tempus agenix secret; a string so the key never enters the store.
  signingPem ? "/run/agenix/paseo-signing",
  # Part of the derivation hash, so a renewed certificate forces a rebuild.
  signingCertSha1 ? "990C55EA4965A4AE6E385CAECF81A2A7F1F59CF6",
}:
let
  electronVersion = (lib.importJSON ../packages/desktop/package.json).devDependencies.electron;
  # Bumping Electron changes the URL, so a stale hash fails the fetch instead of shipping the wrong build.
  electronZip = fetchurl {
    url = "https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-darwin-arm64.zip";
    hash = "sha256-+Qbf9dBUsbkuVxF4GxPMIG/XE5zmZGdQO50KPm+8mwI=";
  };
in
desktop.overrideAttrs (old: {
  pname = "paseo-desktop-release";
  version = releaseVersion;
  __intentionallyOverridingVersion = true;

  nativeBuildInputs = old.nativeBuildInputs ++ [
    openssl
    rcodesign
  ];

  # Only tempus advertises this feature, and only tempus can read the signing key.
  requiredSystemFeatures = [ "paseo-signing" ];

  env = old.env // {
    PASEO_SIGN_PEM = signingPem;
    PASEO_SIGN_CERT_SHA1 = signingCertSha1;
    CSC_IDENTITY_AUTO_DISCOVERY = "false";
    CUSTOM_DMGBUILD_PATH = lib.getExe python3Packages.dmgbuild;
  };

  buildPhase = ''
    runHook preBuild

    if [ ! -r "$PASEO_SIGN_PEM" ]; then
      echo "$PASEO_SIGN_PEM is not readable; this builds only on tempus with the paseo-signing secret" >&2
      exit 1
    fi
    cert_sha1="$(openssl x509 -in "$PASEO_SIGN_PEM" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)"
    if [ "$cert_sha1" != "$PASEO_SIGN_CERT_SHA1" ]; then
      echo "signing certificate is $cert_sha1, expected $PASEO_SIGN_CERT_SHA1" >&2
      exit 1
    fi

    # The updater ignores +metadata, so the desktop app gets a prerelease that grows with each commit.
    node scripts/stamp-build-version.mjs ${lib.escapeShellArg buildMetadata}
    node -e '
      const fs = require("node:fs");
      const file = "packages/desktop/package.json";
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      pkg.version = process.argv[1];
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    ' ${lib.escapeShellArg releaseVersion}

    npm rebuild node-pty
    npm run build:server
    npm run build --workspace=@getpaseo/expo-two-way-audio
    ( cd packages/app && PASEO_WEB_PLATFORM=electron npx expo export --platform web )
    npm run build:main --workspace=@getpaseo/desktop

    # A directory holding the default zip name makes electron-builder unpack it instead of downloading.
    electron_dist="$NIX_BUILD_TOP/electron-dist"
    mkdir -p "$electron_dist"
    cp ${electronZip} "$electron_dist/electron-v${electronVersion}-darwin-arm64.zip"

    (
      cd packages/desktop
      # hdiutil and sips are host tools; tempus builds unsandboxed.
      export PATH="$PATH:/usr/bin:/usr/sbin"
      export ELECTRON_BUILDER_CACHE="$NIX_BUILD_TOP/electron-builder-cache"
      ../../node_modules/.bin/electron-builder \
        --config electron-builder.fork.yml \
        --mac zip dmg \
        --arm64 \
        --publish never \
        --config.electronDist="$electron_dist" \
        --config.buildVersion=${lib.escapeShellArg buildVersion}
    )

    /usr/bin/codesign --verify --deep --strict packages/desktop/release/mac-arm64/Paseo.app

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    release=packages/desktop/release
    mkdir -p "$out/Applications"
    cp "$release"/latest-mac.yml "$release"/*.zip "$release"/*.dmg "$release"/*.blockmap "$out/"
    cp -R "$release/mac-arm64/Paseo.app" "$out/Applications/Paseo.app"

    runHook postInstall
  '';

  # Stripping or patching after signing would invalidate the signatures.
  dontFixup = true;

  meta = old.meta // {
    description = "Signed Paseo desktop release for the sebbe-cc/paseo fork";
    platforms = [ "aarch64-darwin" ];
  };
})
