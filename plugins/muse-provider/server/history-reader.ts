import { tmpdir } from "node:os";
import type {
  ProviderHistoryRow,
  ProviderLaunch,
  ProviderPersistence,
} from "@getpaseo/plugin/server/provider";
import type { z } from "zod";
import { MspConnection } from "./connection.js";
import { MuseError } from "./errors.js";
import { serveArgs } from "./options.js";
import { Timeline, todoItem } from "./timeline.js";
import {
  deltaSchema,
  gapSchema,
  itemNotificationSchema,
  notificationSchema,
  pageSchema,
  persistenceSchema,
  storedSessionReadSchema,
  type WireItem,
} from "./wire.js";

export interface StoredHistoryRead {
  viewCursor: string;
  rows: ProviderHistoryRow[];
}

interface WalkState {
  host: MspConnection;
  sessionId: string;
  fold: (item: WireItem) => Promise<void>;
  timeline: Timeline;
  rows: ProviderHistoryRow[];
}

async function walkPagesFromGenesis(state: WalkState): Promise<void> {
  let cursor: string | null | undefined;
  do {
    const page: z.infer<typeof pageSchema> = await state.host.request(
      "view/page",
      {
        sessionId: state.sessionId,
        ...(cursor === undefined ? {} : { cursor }),
        direction: "forward",
        limit: 1000,
      },
      pageSchema,
    );
    let gapAfter: string | null = null;
    for (const event of page.events) {
      if (event.method === "view/gap") {
        gapAfter = gapSchema.parse(event.params).after;
        break;
      }
      const envelope = notificationSchema.parse(event.params);
      if (envelope.sessionId && envelope.sessionId !== state.sessionId) continue;
      if (
        event.method === "item/started" ||
        event.method === "item/updated" ||
        event.method === "item/completed"
      ) {
        await state.fold(itemNotificationSchema.parse(event.params).item);
      } else if (event.method === "item/delta") {
        state.timeline.delta(deltaSchema.parse(event.params));
      } else if (event.method === "session/todoListChanged") {
        state.rows.push({ item: todoItem(event.params) });
      }
    }
    cursor = gapAfter ?? page.nextCursor;
  } while (cursor !== null);
}

/**
 * Read one stored Muse session without attaching to it.
 *
 * A short-lived, read-only `MspConnection` serves a single batch: `initialize`,
 * then only `session/read` (with `excludeItems: false`), `view/page`, and the
 * `item/readOutput` fetches `Timeline` needs for patch bodies. No
 * `session/resume`, `session/start`, `view/subscribe`, approval/userInput
 * recovery, usage attach, session hooks, or persistence writes run, and no
 * `Session` instance, sessions-map entry, or `SessionResumed` record is ever
 * created.
 *
 * The read host runs in an existing process directory (`os.tmpdir()`), never
 * in the agent record's workspace: the record's cwd may be deleted, and the
 * native workspace root is left untouched. The connection is closed in
 * `finally`, on success, failure, and abort alike, so no reader host lingers.
 */
export async function readStoredSessionHistory(input: {
  launch: ProviderLaunch;
  persistence: ProviderPersistence;
  /**
   * Called with the read-only host as soon as it exists, so the owning
   * provider connection can stop it on close/abort instead of leaving it
   * to its request timeouts. The reader still closes the host in `finally`.
   */
  onHost?: (host: MspConnection) => void;
}): Promise<StoredHistoryRead> {
  const saved = persistenceSchema.parse(input.persistence.data);
  const host = new MspConnection({
    launch: input.launch,
    cwd: tmpdir(),
    serveArgs: serveArgs(undefined),
  });
  input.onHost?.(host);
  try {
    await host.initialize();
    // Bounded attempts: rows walked from genesis are only labeled with the
    // header read before the walk when a metadata read after the walk
    // reports the same opaque cursor. An interleaved writer between the
    // last page and the metadata read would otherwise serve older rows
    // under a newer revision. Opaque cursors are compared, never
    // interpreted. Persistent contention fails loudly instead of looping.
    for (let attempt = 0; attempt < 3; attempt++) {
      const read = await host.request(
        "session/read",
        { sessionId: saved.sessionId, excludeItems: false },
        storedSessionReadSchema,
      );
      const rows: ProviderHistoryRow[] = [];
      const turnsByItem = new Map<string, string | undefined>();
      const timeline = new Timeline(host, saved.sessionId, `read:${saved.sessionId}`, (event) => {
        if (event.type !== "timeline.item") return;
        const turnId = turnsByItem.get(event.item.id);
        turnsByItem.delete(event.item.id);
        rows.push({
          item: event.item,
          ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
          ...(turnId !== undefined ? { turnId } : {}),
        });
      });
      const fold = async (item: WireItem): Promise<void> => {
        turnsByItem.set(item.itemId, item.turnId ?? undefined);
        try {
          await timeline.fold(item);
        } finally {
          if (turnsByItem.get(item.itemId) === (item.turnId ?? undefined)) {
            turnsByItem.delete(item.itemId);
          }
        }
      };
      if (read.history.mode === "inline") {
        // Complete point-in-time snapshot: the rows describe exactly
        // read.viewCursor. No suffix walk: paging past the snapshot could
        // serve rows newer than the returned revision. Opaque cursors are
        // never interpreted, only echoed.
        if (!read.history.items) {
          throw new MuseError("invalidHistory", "Muse inline history has no items");
        }
        for (const item of read.history.items) await fold(item);
        return { viewCursor: read.viewCursor, rows };
      }
      // Paged fallback for snapshot/anchoredSnapshot/none/unknown modes:
      // walk the whole view from genesis, then reread the header and only
      // publish rows and cursor when nothing arrived mid-walk.
      await walkPagesFromGenesis({ host, sessionId: saved.sessionId, fold, timeline, rows });
      const revalidated = await host.request(
        "session/read",
        { sessionId: saved.sessionId },
        storedSessionReadSchema,
      );
      if (revalidated.viewCursor === read.viewCursor) {
        return { viewCursor: read.viewCursor, rows };
      }
    }
    throw new MuseError(
      "historyChanged",
      `Stored history for session ${saved.sessionId} changed while reading; fetch again`,
    );
  } finally {
    await host.close();
  }
}
