import { randomUUID } from "node:crypto";
import type { PaseoApi, PaseoAgentTimelineEvent, PaseoAgentStream } from "@getpaseo/client";
import { z } from "zod";

export const DelegationSchema = z.object({
  type: z.literal("delegation.created"),
  item: z.object({
    type: z.literal("delegation"),
    target: z.literal("client"),
    id: z.string().min(1),
    content: z.array(z.object({ type: z.literal("input_text"), text: z.string() })),
  }),
});

export function utf8Chunks(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 500) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Each accepted user message owns one delegation; later guidance supersedes its speech context. */
export function createDelegations(options: {
  paseo: PaseoApi;
  agentId: string;
  send(message: unknown): void;
  fail(): void;
}) {
  const agent = options.paseo.agents.ref(options.agentId);
  const seen = new Set<string>();
  let current: { id: string; messageId: string; turnId: string | null; accepted: boolean } | null =
    null;
  let closed = false;
  let submitting = false;
  function reply(id: string, text: string) {
    if (closed) return;
    for (const chunk of utf8Chunks(text))
      options.send({
        type: "delegation.context.append",
        delegation_item_id: id,
        channel: "speakable",
        content: [{ type: "input_text", text: chunk }],
      });
  }
  function onPrompt(event: Extract<PaseoAgentStream["event"], { type: "timeline" }>) {
    if (!current || event.item.type !== "user_message") return;
    if (event.item.clientMessageId === current.messageId) {
      current.accepted = true;
      current.turnId = event.turnId ?? null;
    } else current = null;
  }
  function onTimeline(update: PaseoAgentTimelineEvent) {
    if (closed || update.agentId !== options.agentId) return;
    const event = update.event;
    if (
      event.type === "subscription_restored" ||
      event.type === "replacement" ||
      event.type === "error"
    ) {
      options.fail();
      return;
    }
    if (!current) return;
    if (event.type === "timeline" && event.item.type === "user_message") {
      onPrompt(event);
      return;
    }
    if (current.accepted && event.type === "permission_requested") {
      reply(current.id, "The coding agent needs permission. Review the request in Paseo.");
      return;
    }
    if (
      !current.accepted ||
      !current.turnId ||
      !("turnId" in event) ||
      event.turnId !== current.turnId
    )
      return;
    if (event.type === "timeline" && event.item.type === "assistant_message")
      reply(current.id, event.item.text);
    if (event.type === "turn_completed") {
      current = null;
      return;
    }
    if (event.type === "turn_failed")
      reply(current.id, "The coding agent reported an error. Check the agent chat.");
    if (event.type === "turn_canceled") reply(current.id, "The coding agent was stopped.");
  }
  const subscription = agent.timeline.subscribe((update) => {
    try {
      onTimeline(update);
    } catch {
      options.fail();
    }
  });
  return {
    ready: subscription.ready,
    async accept(input: unknown) {
      const parsed = DelegationSchema.safeParse(input);
      if (!parsed.success || closed) return;
      const { item } = parsed.data;
      if (seen.has(item.id)) return;
      if (seen.size >= 256)
        throw new Error("Live delegation limit reached; start a new voice session");
      seen.add(item.id);
      if (submitting) {
        reply(item.id, "A request is being delivered. Please try again.");
        return;
      }
      const text = item.content
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text) {
        reply(item.id, "Please repeat the request.");
        return;
      }
      submitting = true;
      const previous = current;
      current = { id: item.id, messageId: randomUUID(), turnId: null, accepted: false };
      try {
        await agent.send(
          text +
            "\n\nRespond concisely in plain text suitable for speech. Do not use a speak tool.",
          {
            messageId: current.messageId,
            activeTurnBehavior: "steer_only",
          },
        );
      } catch {
        current = previous;
        reply(
          item.id,
          "The request could not be delivered. Any existing agent job continues. Check the agent chat.",
        );
      } finally {
        submitting = false;
      }
    },
    close() {
      closed = true;
      current = null;
      subscription();
    },
  };
}
