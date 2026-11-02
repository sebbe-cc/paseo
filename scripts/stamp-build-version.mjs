// Appends semver build metadata to every workspace version: 0.9.2 -> 0.9.2+desvio.3f9a1c2.
// Run before building; the daemon and app read their version from package.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildMetadata = (process.argv[2] ?? process.env.PASEO_BUILD_METADATA ?? "").trim();

if (!/^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(buildMetadata)) {
  console.error(
    "usage: node scripts/stamp-build-version.mjs <build-metadata>  (e.g. desvio.3f9a1c2)",
  );
  process.exit(1);
}

const rootPackage = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = `${rootPackage.version.replace(/\+.*$/, "")}+${buildMetadata}`;
const packageDirs = [".", ...(rootPackage.workspaces ?? [])];

for (const dir of packageDirs) {
  const packagePath = path.join(rootDir, dir, "package.json");
  if (!existsSync(packagePath)) continue;
  const raw = readFileSync(packagePath, "utf8");
  const pkg = JSON.parse(raw);
  pkg.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}${raw.endsWith("\n") ? "\n" : ""}`);
}

console.log(`Stamped version ${version}`);
