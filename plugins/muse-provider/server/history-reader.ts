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
  sessionReadSchema,
  type WireItem,
} from "./wire.js";

export interface StoredHistoryRead {
  viewCursor: string;
  rows: ProviderHistoryRow[];
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
    const read = await host.request(
      "session/read",
      { sessionId: saved.sessionId, excludeItems: false },
      sessionReadSchema,
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
    // Paged fallback for snapshot/anchoredSnapshot/none/unknown modes: walk
    // the whole view from genesis, then revalidate the revision with a
    // metadata read so the returned rows and cursor stay consistent even if
    // rows arrived between the first read and the walk. Revision dedupe in
    // `Timeline.fold` keeps replays idempotent.
    let cursor: string | null | undefined;
    do {
      const page: z.infer<typeof pageSchema> = await host.request(
        "view/page",
        {
          sessionId: saved.sessionId,
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
        if (envelope.sessionId && envelope.sessionId !== saved.sessionId) continue;
        if (
          event.method === "item/started" ||
          event.method === "item/updated" ||
          event.method === "item/completed"
        ) {
          await fold(itemNotificationSchema.parse(event.params).item);
        } else if (event.method === "item/delta") {
          timeline.delta(deltaSchema.parse(event.params));
        } else if (event.method === "session/todoListChanged") {
          rows.push({ item: todoItem(event.params) });
        }
      }
      cursor = gapAfter ?? page.nextCursor;
    } while (cursor !== null);
    const revalidated = await host.request(
      "session/read",
      { sessionId: saved.sessionId },
      sessionReadSchema,
    );
    return { viewCursor: revalidated.viewCursor, rows };
  } finally {
    await host.close();
  }
}
