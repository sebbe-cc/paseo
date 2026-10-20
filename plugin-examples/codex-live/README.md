# Codex Live voice provider

This example needs Paseo's `feat/plugin-voice-provider` topic based on v0.12.0.
Upstream v0.12.0 does not implement `registerVoiceProvider`.

The normal Paseo voice button records PCM16 at 16 kHz and plays PCM16 at 24 kHz.
This server-only plugin bridges that transport to Codex FramelessBidi with
`@roamhq/wrtc`. Clients do not receive the CPA key or need a WebRTC library.
There is no separate voice UI. Omit the provider selection to keep the existing
STT/agent/TTS implementation.

## Run in an isolated daemon

Install the example's native WebRTC dependency on the daemon machine:

```sh
npm ci --prefix plugin-examples/codex-live
npm run build:server
```

Create a dedicated Paseo home, with this `config.json` (replace the absolute path):

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "codex-live": {
      "source": "directory",
      "path": "/absolute/path/to/paseo/plugin-examples/codex-live",
      "enabled": true
    }
  },
  "features": {
    "voiceMode": {
      "provider": { "pluginId": "codex-live", "providerId": "live" }
    }
  }
}
```

Use a CPA principal allowed to create Codex Live calls. Put its key alone in a
private file, readable by the daemon. Set these variables on the isolated daemon:

```sh
export CODEX_LIVE_API_KEY_FILE=/absolute/private/path/cliproxy-key
export CODEX_LIVE_BASE_URL=http://127.0.0.1:8083/v1/
PASEO_HOME=/tmp/paseo-live-review PASEO_LISTEN=127.0.0.1:6798 npm run dev:server:raw
```

Ensure the port is free, point a dev app at that daemon, open an existing agent,
and use its normal voice button. The provider selection is read at startup.
Plugin code changes use `paseo plugin reload codex-live` against the isolated host.
Do not restart the main daemon on 6767.

Plugins run trusted, unsandboxed Node code. The example loads its own native
library from its installed directory; that binary must support the daemon's OS
and architecture. No WebRTC dependency is added to Paseo itself.

## Protocol and delegation

The plugin uses multipart `POST /v1/realtime/calls`, `gpt-live-1-codex`,
`OpenAI-Alpha: quicksilver=v2`, and `delegation: {type: "client"}`. It omits
`session.type`. The returned Location identifies the call. The authenticated
`/v1/live/<call-id>` control socket connects before microphone audio is sent.
This is not the public `/v1/live/sessions` API.

Delegations go to the selected agent through the normal SDK. Each accepted
message and turn owns its speakable updates, chunked on Unicode character
boundaries at 500 UTF-8 bytes. A later guidance request takes over that speech
context. A duplicate delegation never submits a second message. External prompts
and lost timeline observations invalidate attribution. Agent permission requests
send a spoken instruction to review Paseo's permission UI.

`steer_only` rejects guidance when the provider cannot steer its active turn;
it never replaces the job. An explicit cancel in Paseo still cancels the agent.
Stopping voice, disconnecting audio, or unloading the plugin leaves agent work
running. The plugin never registers the old `speak` bridge or enables its TTS.

A closed remote channel or failed ICE connection ends voice. Reconnecting the
Paseo socket creates a fresh remote call, not a replay of pending delegations.
Call hangup is attempted before disconnecting sideband. It is bounded to 1.5 s
so plugin shutdown can release media promptly even if CPA is unreachable.

## Verification

Recorded results and the platform matrix are in the
[verification evidence](../../docs/qa-evidence/plugin-voice-provider.md).

Use the existing server and app suites, from their package directories:

```sh
# packages/server
npx vitest run src/server/session/voice/voice-session.test.ts --bail=1
npx vitest run src/server/plugins/plugin-process.test.ts --bail=1
npx vitest run src/server/agent/agent-prompt.test.ts --bail=1
npx vitest run src/server/plugins/plugin-paseo-api.e2e.test.ts --bail=1

# packages/app
npx vitest run src/voice/voice-runtime.test.ts --bail=1
```

The default daemon integration test uses a fixture voice provider and a fake
agent. For actual CPA media and a real Codex agent, install `espeak-ng`, ensure
Codex works on the daemon machine, then run from `packages/server`:

```sh
PASEO_TEST_CODEX_LIVE=1 \
CODEX_LIVE_API_KEY_FILE=/absolute/private/path/cliproxy-key \
PASEO_TEST_ESPEAK=/absolute/path/to/espeak-ng \
npx vitest run src/server/plugins/plugin-paseo-api.e2e.test.ts \
  -t 'Codex Live carries' --bail=1
```

This test creates a separate daemon on an OS-assigned loopback port and an
isolated home. It sends synthetic speech through Paseo's PCM transport, asks a
real Codex agent to inspect a temporary file containing a random phrase, and
requires that phrase in the agent timeline and the Live spoken transcript, plus
nonzero returned audio energy. It cleans up the daemon and files. It uses live
services and incurs inference usage; the ordinary suite skips it.

## Limits

- WebRTC media runs between the daemon and OpenAI. CPA handles bootstrap and
  control; its current media relay is disabled. The daemon needs working ICE and
  outbound media connectivity. An HTTPS tunnel does not carry this WebRTC leg.
- Capture and playback reuse Paseo's web/native engines. Mac Electron has a
  user-confirmed voice round trip; see the verification evidence above. Physical
  iOS/Android devices, Bluetooth, acoustic echo cancellation, backgrounding and
  remote network behavior still need verification.
- Input speech detection uses a fixed energy threshold with a 60 ms onset and
  400 ms release. Noisy rooms may need a different detector. Live owns remote
  speech interruption; client playback is cleared independently of agent work.
- Output downmixes and resamples the WebRTC sink to mono at 24 kHz, including
  the initial 16 kHz silence before Opus audio arrives. Each
  audio backlog is bounded. This initial bridge adds 100 ms output batching and
  300 ms silence grouping. Client playback adds a 150 ms startup buffer for
  packet jitter; audio quality and long-session latency need device QA.
- Agent outputs without an accepted message/turn ID are not attributed to a
  delegation. There is no inferred match to arbitrary last messages.
- Live-to-agent transcript and delegation text leave the daemon for the configured
  remote service. Credentials remain in the server process.
- Bifrost currently loses the Alpha header and call Location and lacks the Codex
  sideband route. Point this example directly at CPA.
- No production packaging, desvio manifest entry, or deployment is included.
  There are no dependencies on other fork topics.
