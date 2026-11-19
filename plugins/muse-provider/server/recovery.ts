import type { z } from "zod";
import type { MspHost, Notification } from "./connection.js";
import { MuseError } from "./errors.js";
import { pageSchema } from "./wire.js";

// Two minutes accommodates slow model/tool work; polling repairs a lost live view without cancelling it.
const SILENCE_MS = 2 * 60 * 1000;
// A view/page read can outlast the 10 s request budget while the native run
// stays healthy (a store scan under host IO load, pa-89is1.25). Retry the same
// cursor a bounded number of times before failing the session, so one slow
// page does not end an active turn with session.runtime_failed.
const VIEW_PAGE_ATTEMPTS = 3;
export class Recovery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private closed = false;
  private cursor: string;
  constructor(
    private readonly host: MspHost,
    private readonly sessionId: string,
    cursor: string,
    private readonly apply: (event: Notification) => Promise<void>,
    private readonly onSilent: () => void,
  ) {
    this.cursor = cursor;
  }

  activity(cursor: string | undefined, active: boolean): void {
    if (cursor !== undefined) this.cursor = cursor;
    this.active = active;
    clearTimeout(this.timer);
    if (active && !this.closed) this.timer = setTimeout(this.onSilent, SILENCE_MS);
  }
  async backfill(after = this.cursor): Promise<void> {
    let cursor: string | null = after;
    do {
      const page = await this.readPage(cursor);
      // A close during the repair ends the session: stop quietly instead of
      // failing it after the fact.
      if (!page) return;
      for (const event of page.events) await this.apply(event);
      cursor = page.nextCursor;
    } while (cursor !== null && !this.closed);
    this.activity(undefined, this.active);
  }
  private async readPage(cursor: string | null): Promise<z.infer<typeof pageSchema> | null> {
    for (let attempt = 1; ; attempt++) {
      if (this.closed) return null;
      try {
        return await this.host.request(
          "view/page",
          { sessionId: this.sessionId, cursor, direction: "forward", limit: 1000 },
          pageSchema,
        );
      } catch (error) {
        // A close during the repair ends the session: stop quietly instead
        // of failing it after the fact.
        if (this.closed) return null;
        if (!isTimeout(error) || attempt >= VIEW_PAGE_ATTEMPTS) throw error;
        console.warn(
          `[muse-provider] view/page for session ${this.sessionId} timed out ` +
            `(attempt ${attempt}/${VIEW_PAGE_ATTEMPTS}, cursor ${JSON.stringify(cursor)}); retrying`,
        );
      }
    }
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof MuseError && error.kind === "timeout";
}
