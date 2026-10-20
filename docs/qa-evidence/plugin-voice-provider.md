# Plugin voice provider verification

2026-10-20, Linux daemon, topic `feat/plugin-voice-provider`, based on upstream
v0.12.0. Initial implementation and isolated tests precede production integration
in fleet/paseo.

## Real service and real agent

The opt-in `Codex Live carries` test used direct CLIProxyAPI 8.0.35 on loopback
8083, Codex Live, and a real Codex agent through an isolated Paseo daemon on an
OS-assigned loopback port. The temporary workspace contained a text file with a
random phrase. The phrase was absent from the synthetic microphone input.
Assertions required the phrase in both the selected agent's assistant timeline
and Live's completed spoken transcript, plus nonzero returned PCM energy.
This exercises the existing voice WebSocket transport with synthetic PCM; it
does not exercise a physical microphone, speaker or the app's voice button.

Raw successful evidence:

```json
{
  "inputPcmBytes": 336306,
  "outputEnergy": 741061715870,
  "phrase": "rabbit poppy poppy violet",
  "spoken": [
    " On it, checking the workspace text file now. Found it and pulling the status and phrase now. Hang on.",
    " Test status is green; verification phrase is \"rabbit poppy poppy violet.\""
  ],
  "selectedAgentId": "b3e69972-1b2f-4d31-b999-ba43fd1d54c5",
  "failures": []
}
```

```text
 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Duration  50.11s (transform 10.66s, setup 47ms, import 13.06s, tests 36.85s, environment 0ms)
```

An earlier attempt failed: speech recognition changed a hyphenated filename,
and Live spoke an invented result before correcting it from the agent's reply.
The reference instructions now require waiting for agent results. The passing
probe asks the agent to locate the text file instead of spelling a filename.
This verifies delegation and returned audio; it does not establish transcript
or answer accuracy in arbitrary conversations.

## Mac Electron microphone and playback

A separate Electron 44.2.0 dev client on the Mac connected over SSH forwards to
the Linux daemon on 6798 and its Electron renderer on 8118. The installed app
and both production daemons were left running. The user confirmed that physical
microphone input, Live delegation to a real Codex agent, and speaker playback
worked. The agent received the user's weather question and ran its tool.
CDP observed 83 returned audio packets in a 12-second window. Mac microphone
launch requirements are documented in [development](../development.md).

The user reported clicks between packets. Before the playback correction, 901
Web Audio buffer starts showed a median 1.33 ms gap, p95 6.67 ms and maximum
60 ms among 893 boundaries shorter than 150 ms. Live PCM now shares one audio
clock rather than waiting for JavaScript completion callbacks between packets.
A synthetic speech probe through the updated Electron client and real Live
service produced 131 buffer starts; all 118 boundaries shorter than 150 ms were
contiguous within floating-point precision. Longer pauses between speech groups
were excluded in both measurements. These are scheduling measurements, not a
recording or a controlled comparison of identical speech. Perceived quality
after the change still needs user confirmation.

Focused playback and voice-runtime tests cover scheduling ahead, acknowledgement
after consumption, an empty terminal packet, cancellation while waiting for new
packets, and leaving agent work running. Native playback uses its existing
communication engine's PCM queue; physical mobile devices remain untested.

## Fixture and regression tests

The Codex Live settings/King integration test loads the real plugin in an isolated
daemon with fake agents. It rejects unknown voices, persists Maple through reload,
finds King by `gc-session=king`, refuses missing/ambiguous recipients, and resolves
the replacement after the previous King is archived. This test sends no prompt to
the production King and does not create a remote Live call.

Mac Electron manual UI checks selected Maple in the plugin picker and observed it
saved. The King action displayed its missing-recipient error in the isolated
daemon. Temporarily labelling that daemon's test agent `gc-session=king` made the
same action navigate to its existing workspace. No production agent was prompted.

The default integration test uses a fixture provider and fake agent. It verifies
registration and selection, a rejected old-client capability, source-scoped audio
(no audio to a sibling), agent delivery, unload, exactly-once close, and published
unavailability. Unit coverage checks abort during bootstrap, late output after
agent switching, stale agent/turn/delegation attribution, UTF-8 context chunks,
audio pacing and backlog limits, initial 16 kHz sink silence, and explicit agent
cancellation while ordinary speech leaves the job running. Existing voice tests
continue to exercise the default STT/TTS path.

Commands are run from each package directory with `npx vitest run <files> --bail=1`.
Filters are shown when only selected tests ran. No full suite ran.

packages/server: voice-session, voice/index, plugin-process, compiler:

```text
 Test Files  4 passed (4)
      Tests  97 passed (97)
   Duration  14.83s (transform 5.20s, setup 89ms, import 427ms, tests 13.70s, environment 0ms)
```

packages/server: voice-session after the PCM wire format correction:

```text
 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  603ms (transform 155ms, setup 40ms, import 199ms, tests 229ms, environment 0ms)
```

packages/app: voice-runtime after reconnect and capture lifetime fixes:

```text
 Test Files  1 passed (1)
      Tests  22 passed (22)
   Duration  619ms (transform 144ms, setup 64ms, import 112ms, tests 305ms, environment 1ms)
```

packages/app: voice-runtime and plugins/evaluate (client runtime loader):

```text
 Test Files  2 passed (2)
      Tests  63 passed (63)
   Duration  9.48s (transform 7.62s, setup 67ms, import 9.43s, tests 313ms, environment 1ms)
```

packages/plugin: boundaries:

```text
 Test Files  1 passed (1)
      Tests  54 passed (54)
   Duration  1.02s (transform 306ms, setup 0ms, import 700ms, tests 103ms, environment 0ms)
```

packages/client: daemon-client, filter strict voice steering:

```text
 Test Files  1 passed (1)
      Tests  2 passed | 171 skipped (173)
   Duration  5.10s (transform 4.09s, setup 0ms, import 4.93s, tests 18ms, environment 0ms)
```

packages/client: connection, filter capabilit:

```text
 Test Files  1 passed (1)
      Tests  2 passed | 31 skipped (33)
   Duration  4.92s (transform 3.95s, setup 0ms, import 4.73s, tests 32ms, environment 0ms)
```

packages/server: plugin-paseo-api.e2e, filter plugin voice uses:

```text
 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Duration  10.63s (transform 7.24s, setup 29ms, import 9.30s, tests 1.20s, environment 0ms)
```

The agent-prompt suite also passed in the initial focused run, including the
regression proving an unsupported strict steer never replaces a running job.
The server plugin subprocess and client bundle loaders were exercised above.

`npm run build:server`, `npm run typecheck`, `npm run lint` and
`npm run format` completed successfully. Lint reported zero warnings and errors.

## Compatibility and remaining verification

Wire additions are optional fields on existing messages. The new inbound
`steer_only` enum value is sent only after the SDK checks
`server_info.features.pluginVoiceProviders`. Legacy send behavior is unchanged.
Clients advertise `plugin_voice_providers`; older apps receive a correlated
update error before starting a plugin session, because they cannot stop capture
on remote session termination.

| Surface                                            | Evidence                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Linux daemon, CPA media and real Codex             | Passing integrated synthetic-speech test above                                 |
| App voice state and client/server plugin loaders   | Focused automated tests                                                        |
| Mac Electron UI, microphone and speaker            | User-confirmed voice round trip; packet scheduling measured above              |
| Plain browser app                                  | Not manually exercised                                                         |
| iOS and Android devices                            | Not exercised; existing PCM engines reused                                     |
| Other daemon OS/architectures                      | Native WebRTC dependency not verified                                          |
| Reconnect                                          | Generation and teardown unit coverage; real network reconnection not exercised |
| NAT, Bluetooth, backgrounding, echo and long calls | Not exercised                                                                  |

Hangup is attempted before sideband closes, with a 1.5 s cleanup bound. The
integration test verifies local completion; it does not assert CPA's hangup
HTTP status or remote resource retention. ICE/media runs from the daemon to
OpenAI, so app HTTPS connectivity alone does not verify that leg.

[Review setup and transport limits](../../plugin-examples/codex-live/README.md).
No dependency on another fork topic; production packaging belongs in fleet/paseo.
