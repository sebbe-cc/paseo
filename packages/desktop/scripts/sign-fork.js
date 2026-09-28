const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// rcodesign signs from a PEM file, so the Nix build needs no keychain; nix/desktop-release.nix sets PASEO_SIGN_PEM.
exports.default = async function signFork(opts) {
  const pem = process.env.PASEO_SIGN_PEM;
  if (!pem) {
    throw new Error("PASEO_SIGN_PEM is not set; build with nix build .#desktop-release");
  }
  // The main and inherited entitlement plists are identical, so one file covers every executable.
  const entitlements = path.join(__dirname, "..", "build", "entitlements.mac.plist");
  const helpers = fs
    .readdirSync(path.join(opts.app, "Contents", "Frameworks"))
    .filter((name) => name.endsWith(".app"))
    .map((name) => `Contents/Frameworks/${name}`);

  const args = ["sign", "--pem-file", pem, "--timestamp-url", "none"];
  args.push("--code-signature-flags", "runtime", "--entitlements-xml-file", entitlements);
  for (const helper of helpers) {
    args.push("--code-signature-flags", `${helper}:runtime`);
    args.push("--entitlements-xml-file", `${helper}:${entitlements}`);
  }
  args.push(opts.app);
  execFileSync("rcodesign", args, { stdio: "inherit" });
};
