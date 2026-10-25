# Codex Live voice provider

Use Paseo's normal voice button to talk to the selected coding agent through
Codex Live. You can interrupt speech and give further guidance while the agent
continues working. Explicit cancellation remains available in Paseo.

In Codex Live settings, choose a voice and use **Provlyssna** to hear the same
Swedish sample in that voice. Previewing uses packaged recordings and does not
activate your microphone or coding agent. Voice changes apply to the next call.
Porto and Selva currently have no preview because the voice service rejects them.

This experimental server plugin needs the `feat/plugin-voice-provider` fork of
Paseo 0.12 and an updated app. It sends microphone audio and delegated agent
responses to the configured Codex Live service through CLIProxyAPI. The CPA key
stays on the daemon machine in the private file named by
`CODEX_LIVE_API_KEY_FILE`. `CODEX_LIVE_BASE_URL` defaults to
`http://127.0.0.1:8083/v1/`. Bifrost does not currently support this protocol path.

The daemon must support the plugin's native WebRTC library and outbound ICE
connectivity to OpenAI. Clients reuse Paseo's existing PCM audio transport.
Physical mobile devices, backgrounding, Bluetooth and remote network behavior
still need verification. A disconnect ends the call; starting voice again makes
a fresh call. The speech detector uses a fixed threshold and needs device QA.

See [the review guide](README.md) for isolated setup, verification and limits.
