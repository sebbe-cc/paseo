import { z } from "zod";
import { PluginAdmissionQuerySchema } from "@getpaseo/plugin/server";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AdmissionJournal } from "./admission-journal.js";

export const AdmissionApiRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("bindings.get"), agentId: z.string() }).strict(),
  z.object({ method: z.literal("bindings.list"), since: z.string().optional() }).strict(),
  z
    .object({
      method: z.literal("bindings.set"),
      agentId: z.string(),
      data: z.unknown(),
      expectRevision: z.number().int().positive().nullable(),
    })
    .strict(),
  z
    .object({
      method: z.literal("bindings.clear"),
      agentId: z.string(),
      expectRevision: z.number().int().positive(),
    })
    .strict(),
  z.object({ method: z.literal("admissions.get"), operationId: z.string() }).strict(),
  z.object({ method: z.literal("admissions.query"), filter: PluginAdmissionQuerySchema }).strict(),
  z.object({ method: z.literal("admissions.ack"), operationId: z.string() }).strict(),
]);
export type AdmissionApiRequest = z.infer<typeof AdmissionApiRequestSchema>;
export async function admissionApiRequest(
  pluginId: string,
  request: AdmissionApiRequest,
  storage: AgentStorage,
  journal: AdmissionJournal,
): Promise<unknown> {
  switch (request.method) {
    case "bindings.get":
      return storage.getBinding(request.agentId, pluginId);
    case "bindings.list":
      return storage.listBindings(pluginId, request.since);
    case "bindings.set":
      return storage.setBinding(request.agentId, pluginId, request.data, request.expectRevision);
    case "bindings.clear":
      await storage.clearBinding(request.agentId, pluginId, request.expectRevision);
      return null;
    case "admissions.get":
      return journal.get(request.operationId);
    case "admissions.query":
      return journal.query(request.filter);
    case "admissions.ack":
      await journal.ack(request.operationId, pluginId);
      return null;
  }
}
