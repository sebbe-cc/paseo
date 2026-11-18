import { describe, expect, it } from "vitest";
import {
  parseBackgroundState,
  setWorkspaceBackground,
  type WorkspaceBackgroundClient,
} from "./background.js";

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

class FakeClient implements WorkspaceBackgroundClient {
  readonly calls: Array<[string, boolean]> = [];
  closed = false;
  constructor(private readonly supported: boolean) {}
  getLastServerInfoMessage() {
    return { features: { workspaceBackgroundToggle: this.supported } };
  }
  async setWorkspaceBackground(workspaceId: string, background: boolean) {
    this.calls.push([workspaceId, background]);
    return { background };
  }
  async close() {
    this.closed = true;
  }
}

const options = { daemonTarget: { type: "tcp", host: "127.0.0.1", port: 6767 } } as never;

describe("workspace background", () => {
  it("reads on and off, case-insensitive, and rejects anything else", () => {
    expect(parseBackgroundState("on")).toBe(true);
    expect(parseBackgroundState(" OFF ")).toBe(false);
    expect(catchError(() => parseBackgroundState("yes"))).toMatchObject({
      code: "INVALID_STATE",
    });
  });

  it("shows a workspace with off", async () => {
    const client = new FakeClient(true);
    const result = await setWorkspaceBackground(
      "wks_f84d793565413550",
      "off",
      options,
      async () => client,
    );

    expect(client.calls).toEqual([["wks_f84d793565413550", false]]);
    expect(result.data).toEqual({ workspaceId: "wks_f84d793565413550", background: false });
    expect(client.closed).toBe(true);
  });

  it("asks for a host update when the daemon cannot change the setting", async () => {
    const client = new FakeClient(false);
    await expect(
      setWorkspaceBackground("wks_1", "off", options, async () => client),
    ).rejects.toMatchObject({ code: "DAEMON_UPDATE_REQUIRED" });
    expect(client.calls).toEqual([]);
  });
});
