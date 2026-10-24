import { z } from "zod";
import { PluginAgentBindingSchema, PluginAdmissionRecordSchema } from "./admission.js";

export const HostInventoryDomainSchema = z.enum([
  "agent-records",
  "admissions",
  "live-history",
  "provider-registry",
  "plugin-lifecycle",
]);
export type HostInventoryDomain = z.infer<typeof HostInventoryDomainSchema>;
export const HostWatermarkSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal("paseo-host"),
    epoch: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    activeWriters: z.number().int().nonnegative(),
    productionFence: z.literal(false),
    covered: z.array(HostInventoryDomainSchema),
    excluded: z.array(z.string()),
    oldestSequence: z.number().int().nonnegative(),
    changes: z
      .array(
        z.object({
          sequence: z.number().int().positive(),
          domain: HostInventoryDomainSchema,
        }),
      )
      .max(64),
  })
  .strict();
export type HostWatermark = z.infer<typeof HostWatermarkSchema>;
export const HostWatermarkResultSchema = z
  .object({
    watermark: HostWatermarkSchema,
    local: z.object({ path: z.string(), expiresAt: z.number().int().positive() }).nullable(),
  })
  .strict();
export const HostFenceLockSchema = z
  .object({
    path: z.string(),
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
  })
  .strict();
export type HostFenceLock = z.infer<typeof HostFenceLockSchema>;
export const HostFenceTokenSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal("paseo-host"),
    watermark: HostWatermarkSchema,
    local: z.object({ path: z.string(), expiresAt: z.number().int().positive() }),
    lock: HostFenceLockSchema,
  })
  .strict();
export type HostFenceToken = z.infer<typeof HostFenceTokenSchema>;
export const HostInventoryRequestSchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict();
export const HostInventoryAgentSchema = z
  .object({
    agentId: z.string(),
    provider: z.string(),
    cwd: z.string(),
    workspaceId: z.string().nullable(),
    archivedAt: z.string().nullable(),
    status: z.string(),
    persistence: z.object({ provider: z.string(), sessionId: z.string() }).nullable(),
    binding: PluginAgentBindingSchema.nullable(),
  })
  .strict();
export const HostInventoryPageSchema = z
  .object({
    watermark: HostWatermarkSchema,
    agents: z.array(HostInventoryAgentSchema),
    admissions: z.array(PluginAdmissionRecordSchema),
    complete: z.boolean(),
    truncated: z.boolean(),
    nextCursor: z.string().uuid().nullable(),
    recordsRead: z.number().int().nonnegative(),
    limits: z.object({
      rows: z.literal(100),
      bytes: z.literal(262144),
      cursorTtlMs: z.literal(10000),
    }),
    // Completeness is for the host's stored agents and retained admission journal only.
    admissionRetentionDays: z.number().int().positive(),
  })
  .strict();
export type HostInventoryPage = z.infer<typeof HostInventoryPageSchema>;
export interface PluginHostInventory {
  read(request?: z.infer<typeof HostInventoryRequestSchema>): Promise<HostInventoryPage>;
  fence(): Promise<HostFenceToken>;
  watermark(): Promise<z.infer<typeof HostWatermarkResultSchema>>;
}
