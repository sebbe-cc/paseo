const { signAsync } = require("@electron/osx-sign");

// electron-builder only auto-selects Developer ID certificates, so the fork passes its Apple Development identity itself.
exports.default = async function signFork(opts) {
  const identity = process.env.PASEO_SIGN_IDENTITY;
  if (!identity) {
    throw new Error("PASEO_SIGN_IDENTITY is not set; run scripts/build-fork-desktop-mac.sh");
  }
  await signAsync({
    ...opts,
    identity,
    keychain: process.env.PASEO_SIGN_KEYCHAIN || opts.keychain,
  });
};
