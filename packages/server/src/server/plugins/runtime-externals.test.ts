import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateBundle } from "./bundle-evaluator.js";
import { compileDirectoryPlugin, compilePlugin } from "./compiler.js";
import { matchesRuntimeExternal } from "./runtime-externals.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function writePackage(directory: string, name: string, source: string): Promise<void> {
  const packageDirectory = path.join(directory, "node_modules", name);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ name }));
  await writeFile(path.join(packageDirectory, "index.js"), source);
}

// Mirrors an SDK whose optional features require packages it does not depend on,
// as DBOS does for OTLP telemetry and its enterprise add-on.
async function createLazySdkPlugin(runtimeExternals?: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-runtime-externals-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "server"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "lazy", requirements: { paseo: ">=0.8.0" }, runtimeExternals }),
  );
  await writePackage(
    directory,
    "lazy-sdk",
    `exports.loadExporter = () => require("@otel/exporter").name;
exports.loadEnterprise = () => require("enterprise-addon");`,
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import { loadEnterprise, loadExporter } from "lazy-sdk";
export default function contribute() { return { loadEnterprise, loadExporter }; }`,
  );
  return directory;
}

interface LazyContribution {
  loadEnterprise: () => unknown;
  loadExporter: () => unknown;
}

describe("plugin runtime externals", () => {
  it("matches exact packages with their subpaths and whole scopes", () => {
    const externals = ["winston", "@opentelemetry/*", "@dbos-inc/dbos-enterprise"];
    expect(matchesRuntimeExternal("winston", externals)).toBe(true);
    expect(matchesRuntimeExternal("winston/lib/logger", externals)).toBe(true);
    expect(matchesRuntimeExternal("winston-transport", externals)).toBe(false);
    expect(matchesRuntimeExternal("@opentelemetry/api", externals)).toBe(true);
    expect(matchesRuntimeExternal("@opentelemetry/sdk-logs/build", externals)).toBe(true);
    expect(matchesRuntimeExternal("@opentelemetry", externals)).toBe(false);
    expect(matchesRuntimeExternal("@dbos-inc/dbos-enterprise", externals)).toBe(true);
    expect(matchesRuntimeExternal("@dbos-inc/dbos-sdk", externals)).toBe(false);
  });

  it("fails the server build on unresolvable lazy requires that are not declared", async () => {
    const directory = await createLazySdkPlugin();
    await expect(compileDirectoryPlugin(directory, "0.14.0")).rejects.toThrow(
      'Could not resolve "@otel/exporter"',
    );
  });

  it("leaves declared packages out of the server bundle and requires them from the plugin", async () => {
    const runtimeExternals = ["@otel/*", "enterprise-addon"];
    const directory = await createLazySdkPlugin(runtimeExternals);
    await writePackage(directory, "@otel/exporter", 'exports.name = "exporter from plugin";');

    const { manifest, serverBundle } = await compileDirectoryPlugin(directory, "0.14.0");

    expect(manifest.runtimeExternals).toEqual(runtimeExternals);
    expect(serverBundle).toContain('require("@otel/exporter")');
    expect(serverBundle).not.toContain("exporter from plugin");
    const contribute = evaluateBundle(serverBundle!, {
      pluginDirectory: directory,
      runtimeExternals,
    });
    const sdk = (await contribute(undefined as never)) as unknown as LazyContribution;
    expect(sdk.loadExporter()).toBe("exporter from plugin");
    // A declared package the plugin does not install fails only when it is required.
    expect(() => sdk.loadEnterprise()).toThrow(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" }),
    );
  });

  it("does not resolve undeclared requires from the plugin's node_modules", async () => {
    const runtimeExternals = ["@otel/*", "enterprise-addon"];
    const directory = await createLazySdkPlugin(runtimeExternals);
    await writePackage(directory, "@otel/exporter", 'exports.name = "exporter from plugin";');
    const { serverBundle } = await compileDirectoryPlugin(directory, "0.14.0");

    const contribute = evaluateBundle(serverBundle!, { pluginDirectory: directory });
    const sdk = (await contribute(undefined as never)) as unknown as LazyContribution;
    expect(() => sdk.loadExporter()).toThrow(expect.objectContaining({ code: "MODULE_NOT_FOUND" }));
  });

  it("keeps runtime externals out of the client bundle", async () => {
    const directory = await createLazySdkPlugin();
    const client = path.join(directory, "index.client.ts");
    await writeFile(
      client,
      `import { loadExporter } from "lazy-sdk";
export default function contribute() { loadExporter(); return () => undefined; }`,
    );
    await expect(
      compilePlugin({ client, server: null }, ["@otel/*", "enterprise-addon"]),
    ).rejects.toThrow('Could not resolve "@otel/exporter"');
  });
});
