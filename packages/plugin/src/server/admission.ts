import { z } from "zod";

export const PluginRequestOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plugin"), pluginId: z.string() }).strict(),
  z
    .object({
      kind: z.literal("client"),
      principalId: z.string(),
      clientId: z.string(),
      clientType: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("agent"), callerAgentId: z.string() }).strict(),
  z
    .object({
      kind: z.literal("daemon"),
      source: z.enum(["restore", "schedule", "hub", "voice", "loop"]),
    })
    .strict(),
]);
export type PluginRequestOrigin = z.infer<typeof PluginRequestOriginSchema>;
export const PluginAgentBindingSchema = z.object({
  revision: z.number().int().positive(),
  data: z.unknown(),
  boundAt: z.string(),
  boundBy: PluginRequestOriginSchema,
});
export type PluginAgentBinding = z.infer<typeof PluginAgentBindingSchema>;
export const PluginBindingStateSchema = z
  .object({
    epoch: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    recordDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const PluginBindingCasSchema = z
  .object({
    operationKey: z.string().regex(/^[a-f0-9]{64}$/),
    expected: PluginBindingStateSchema,
    expectRevision: z.number().int().positive().nullable(),
  })
  .strict();
export const PluginBindingProofSchema = z
  .object({
    operationKey: z.string().regex(/^[a-f0-9]{64}$/),
    agentId: z.string(),
    pluginId: z.string(),
    expectRevision: z.number().int().positive().nullable(),
    predecessor: PluginBindingStateSchema,
    successor: PluginBindingStateSchema,
  })
  .strict();
export const PluginBindingObservationSchema = z
  .object({
    binding: PluginAgentBindingSchema.nullable(),
    state: PluginBindingStateSchema,
  })
  .strict();
export const PluginBindingSuccessorSchema = z
  .object({
    binding: PluginAgentBindingSchema,
    proof: PluginBindingProofSchema,
  })
  .strict();
export const PluginAdmissionOperationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  reason: z.enum(["create", "resume", "refresh", "import"]),
  attempt: z.number().int().positive(),
  supersedes: z.string().nullable(),
  startedAt: z.string(),
});
export type PluginAdmissionOperation = z.infer<typeof PluginAdmissionOperationSchema>;
export const PluginAdmissionHistorySchema = z.object({
  epoch: z.string().nullable(),
  nextSeq: z.number().int(),
  persistence: z.object({ provider: z.string(), sessionId: z.string().nullable() }).nullable(),
});
export const PluginAdmissionStatusSchema = z.enum(["pending", "opened", "failed", "interrupted"]);
export type PluginAdmissionStatus = z.infer<typeof PluginAdmissionStatusSchema>;
export const PluginAdmissionRecordSchema = PluginAdmissionOperationSchema.extend({
  status: PluginAdmissionStatusSchema,
  finishedAt: z.string().nullable(),
  effect: z
    .object({
      persistence: PluginAdmissionHistorySchema.shape.persistence,
      historyEpoch: z.string().nullable(),
    })
    .nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      stage: z.enum(["hook", "fence", "provider", "interrupted"]),
    })
    .nullable(),
  origin: PluginRequestOriginSchema,
  undeliveredTo: z.array(z.string()),
});
export type PluginAdmissionRecord = z.infer<typeof PluginAdmissionRecordSchema>;
export const PluginAdmissionQuerySchema = z.object({
  agentId: z.string().optional(),
  status: z.array(PluginAdmissionStatusSchema).optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().max(10000).optional(),
});
export interface PluginAgentBindings {
  observe(agentId: string): Promise<z.infer<typeof PluginBindingObservationSchema>>;
  setWithProof(
    agentId: string,
    data: unknown,
    opts: z.infer<typeof PluginBindingCasSchema>,
  ): Promise<z.infer<typeof PluginBindingSuccessorSchema>>;
  get(agentId: string): Promise<PluginAgentBinding | null>;
  list(filter?: {
    since?: string;
  }): Promise<Array<{ agentId: string; binding: PluginAgentBinding }>>;
  set(
    agentId: string,
    data: unknown,
    opts: { expectRevision: number | null },
  ): Promise<PluginAgentBinding>;
  clear(agentId: string, opts: { expectRevision: number }): Promise<void>;
}
export interface PluginAdmissions {
  get(operationId: string): Promise<PluginAdmissionRecord | null>;
  query(filter: z.infer<typeof PluginAdmissionQuerySchema>): Promise<PluginAdmissionRecord[]>;
  ack(operationId: string): Promise<void>;
}
