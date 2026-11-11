import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  PluginCliSchema,
  PluginIdSchema,
  PluginRequirementsSchema,
} from "@getpaseo/protocol/messages";
import { validatePluginRequirements } from "@getpaseo/protocol/plugin-requirements";

const MANIFEST_FILENAME = "paseo-plugin.json";
const PluginBuildCommandSchema = z
  .array(z.string().refine((argument) => argument.trim().length > 0))
  .min(1);
// Manifest asset paths use forward slashes and stay inside the plugin package.
const PluginAssetPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value === value.trim() &&
      !value.startsWith("/") &&
      !/[\\:?#\p{Cc}]/u.test(value) &&
      !value.split("/").includes("..") &&
      !value.endsWith("/") &&
      value.split("/").at(-1) !== ".",
    "Expected a relative file path inside the plugin package",
  );
// npm package names, or `@scope/*` for every package in a scope. Host modules keep their
// own runtime instances and cannot be redirected to the plugin's node_modules.
const PluginRuntimeExternalSchema = z
  .string()
  .regex(
    /^(?:@[a-z0-9-~][a-z0-9-._~]*\/(?:\*|[a-z0-9-~][a-z0-9-._~]*)|[a-z0-9-~][a-z0-9-._~]*)$/,
    "Expected an npm package name or an @scope/* pattern",
  )
  .refine(
    (value) => !/^@(?:getpaseo|paseo)\//.test(value) && value !== "zod",
    "Paseo host modules cannot be runtime externals",
  );
const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  icon: PluginAssetPathSchema.refine(
    (value) => /\.png$/i.test(value),
    "Expected a relative path to a PNG",
  ).optional(),
  media: z.array(z.union([PluginAssetPathSchema, z.url({ protocol: /^https$/ })])).optional(),
  // A misspelled requirement must not silently disable compatibility checks.
  requirements: PluginRequirementsSchema.strict().optional(),
  build: z.array(PluginBuildCommandSchema).min(1).optional(),
  // Server-bundle dependencies esbuild must not follow (optional or lazily required
  // packages); the plugin subprocess requires them from the plugin's own node_modules.
  runtimeExternals: z.array(PluginRuntimeExternalSchema).optional(),
  cli: PluginCliSchema.optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  const info = await stat(manifestPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Plugin manifest is missing: ${manifestPath}`);
  const manifest = PluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  validatePluginRequirements(manifest.requirements);
  return manifest;
}
