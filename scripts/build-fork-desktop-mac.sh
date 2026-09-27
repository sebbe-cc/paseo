#!/usr/bin/env bash
# Signed fork macOS build (PASEO_SIGNING_P12) on a desvio tree; --publish uploads a sebbe-cc/paseo release via GH_TOKEN.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

publish=never
case "${1:-}" in
  "") ;;
  --publish) publish=always ;;
  *) echo "usage: $0 [--publish]" >&2; exit 2 ;;
esac

p12="${PASEO_SIGNING_P12:?set PASEO_SIGNING_P12 to the Apple Development .p12}"
[ -f "$p12" ] || { echo "no such file: $p12" >&2; exit 1; }
if [ "$publish" = always ] && [ -z "${GH_TOKEN:-}" ]; then
  echo "--publish needs GH_TOKEN with write access to sebbe-cc/paseo" >&2
  exit 1
fi

# The updater ignores +metadata, so only the desktop app gets a prerelease that grows each build.
sha="$(git rev-parse --short HEAD)"
base="$(node -p 'require("./package.json").version.replace(/[-+].*$/, "")')"
version="${base}-desvio.$(date -u +%Y%m%d%H%M%S).${sha}"

# A throwaway keychain, so codesign never prompts and the login keychain stays untouched.
keychain="$(mktemp -d)/paseo-signing.keychain-db"
keychain_password="$(uuidgen)"
original_keychains=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  original_keychains+=("${line//\"/}")
done < <(security list-keychains -d user)
cleanup() {
  security list-keychains -d user -s "${original_keychains[@]}" || true
  security delete-keychain "$keychain" 2>/dev/null || true
  git -C "$root" checkout -- package.json 'packages/*/package.json' 2>/dev/null || true
}
trap cleanup EXIT

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 7200 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$p12" -k "$keychain" -P "${PASEO_SIGNING_P12_PASSWORD:-}" -T /usr/bin/codesign >/dev/null
wwdr="$(mktemp)"
curl -fsSL -o "$wwdr" https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
security import "$wwdr" -k "$keychain" >/dev/null || true
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${original_keychains[@]}"

identity_line="$(security find-identity -v -p codesigning "$keychain" | grep '"Apple Development: ' | head -n 1 || true)"
[ -n "$identity_line" ] || { echo "no valid Apple Development identity in $p12" >&2; exit 1; }
identity_hash="$(awk '{print $2}' <<<"$identity_line")"
echo "Signing with ${identity_line#*) }"

node scripts/stamp-build-version.mjs "desvio.${sha}"
node -e '
  const fs = require("node:fs");
  const file = "packages/desktop/package.json";
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = process.argv[1];
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$version"
echo "Desktop version $version"

npm run build:app-deps:clean
(cd packages/app && PASEO_WEB_PLATFORM=electron npx expo export --platform web)
npm run build:server:clean
npm run build:main --workspace=@getpaseo/desktop

(
  cd packages/desktop
  PASEO_SIGN_IDENTITY="$identity_hash" PASEO_SIGN_KEYCHAIN="$keychain" \
    npx electron-builder --config electron-builder.fork.yml --mac --arm64 --publish "$publish"
)

app=packages/desktop/release/mac-arm64/Paseo.app
codesign --verify --deep --strict "$app"
codesign -dv "$app" 2>&1 | grep -E "Authority=Apple Development|TeamIdentifier"
ls -1 packages/desktop/release/*.dmg packages/desktop/release/*.zip packages/desktop/release/*.yml
