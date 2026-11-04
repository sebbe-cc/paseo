// Fails when a patch in patches/ is not applied to the installed package version it targets.
// Nix builds install with --ignore-scripts, so a missed `npm run postinstall` shows up here.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const workspaceDirs = [
  ".",
  ...["packages", "plugin-examples"].flatMap((dir) =>
    existsSync(join(root, dir)) ? readdirSync(join(root, dir)).map((name) => join(dir, name)) : [],
  ),
];

function installedVersion(cwd, name) {
  const manifest = join(root, cwd, "node_modules", name, "package.json");
  return existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).version : null;
}

const missing = [];
for (const file of readdirSync(join(root, "patches")).filter((name) => name.endsWith(".patch"))) {
  // patch-package names patches <scope>+<name>+<version>.patch
  const parts = file.slice(0, -".patch".length).split("+");
  const version = parts.pop();
  const name = parts.join("/");
  const cwds = workspaceDirs.filter((cwd) => installedVersion(cwd, name) === version);
  if (cwds.length === 0) {
    console.log(`skip ${file}: ${name}@${version} not installed`);
    continue;
  }
  // Without the all-zero index lines patch-package writes, GNU patch takes each file for a new one.
  const input = readFileSync(join(root, "patches", file), "utf8").replace(/^index .*\n/gm, "");
  for (const cwd of cwds) {
    const result = spawnSync("patch", ["-p1", "-R", "--dry-run", "-s", "-f"], {
      cwd: join(root, cwd),
      input,
      encoding: "utf8",
    });
    if (result.status === 0) {
      console.log(`ok   ${file} in ${cwd}`);
    } else {
      missing.push(
        `${file} in ${cwd}: ${result.error ?? `${result.stdout}${result.stderr}`.trim()}`,
      );
    }
  }
}

if (missing.length > 0) {
  console.error(`patches not applied:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
