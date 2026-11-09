---
addressed:
  - id: code/code-3
    status: fixed
    note: "Full QA-daemon reproduction with working speech dependencies: isolated
      daemon (70d2098e1) using real local models; voice enabled for real; plugin
      reloaded while voice ACTIVE; same persistence session id, launches 2->2,
      post-reload spoken turn transcribed exactly and ran a second agent turn,
      MCP served hot-swapped v2 tool + new extra tool, speak TTS 68322 bytes,
      refreshAgent recovery with second speak roundtrip (78088 bytes), 0 Unknown
      agent lines. Evidence: /tmp/qa-pa-8ndi-voice/EVIDENCE.json (+daemon.log,
      repro.mts). No code change."
  - id: simplicity/simplicity-2
    status: fixed
    note: "Same evidence as code-3: active voice target, plugin reload mid-voice,
      next spoken input verified with voice response, unchanged running provider
      session, no Unknown agent failure, plus reload/resume recovery via
      explicit refreshAgent."
tests:
  - run: npx vitest run src/server/session/voice/voice-session.test.ts --bail=1
    because: voice enable retry + abort paths on current tree
  - run: npx vitest run src/server/agent/agent-manager.test.ts --bail=1
    because: plugin reload hot-swap + generation race on current tree
---

No source changes this round (findings asked for QA evidence only); worktree clean, origin/main unmoved at 30178c4f5, branch pushed (up-to-date). fix.md at .orbit/review/round-2/fix.md (uncommitted).
