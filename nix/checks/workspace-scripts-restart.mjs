import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);
const [paseo, bash] = process.argv.slice(2);
assert(paseo && bash, "pass the built Paseo CLI and bash");
const root = await mkdtemp(join(tmpdir(), "script-restart-check-"));
const home = join(root, "daemon");
const repo = join(root, "repo");
await mkdir(home);
await mkdir(repo);
const env = {
  PATH: process.env.PATH,
  HOME: root,
  XDG_CACHE_HOME: join(root, "cache"),
  PASEO_HOME: home,
  SHELL: bash,
  NO_COLOR: "1",
  PASEO_DISABLE_AUTO_UPDATE: "1",
};
const portServer = net.createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const daemonPort = portServer.address().port;
await new Promise((r) => portServer.close(r));
await writeFile(
  join(home, "config.json"),
  JSON.stringify({
    version: 1,
    daemon: {
      listen: `127.0.0.1:${daemonPort}`,
      relay: { enabled: false },
      mcp: { enabled: false },
    },
    features: { webUi: { enabled: false }, dictation: { enabled: false } },
    pluginsEnabled: false,
    agents: { resumeOnStartup: false },
  }),
);
const node = process.execPath;
const fixture = join(repo, "fixture.mjs");
const record = join(repo, "ready.json");
const starts = join(repo, "starts");
await writeFile(
  fixture,
  `import http from 'node:http'; import fs from 'node:fs'; import {spawn} from 'node:child_process';
process.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>{});
if (process.argv[2] !== 'child') {
 fs.appendFileSync(${JSON.stringify(starts)},'start\\n');
 const child=spawn(process.execPath,[import.meta.filename,'child'],{env:process.env,stdio:'inherit'});
 setInterval(()=>{},1000);
} else {
 const server=http.createServer((req,res)=>res.end('script-okay'));
 server.listen(Number(process.env.PASEO_PORT),'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,port:server.address().port})));
}`,
);
await writeFile(
  join(repo, "paseo.json"),
  JSON.stringify({
    scripts: { web: { type: "service", command: `${node} ${JSON.stringify(fixture)}` } },
  }),
);
await exec("git", ["init", repo], { env });
async function cli(args) {
  const { stdout } = await exec(paseo, [...args, "--home", home, "--json"], {
    env,
    cwd: repo,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}
async function eventually(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await delay(100);
    }
  }
  throw last;
}
async function request(host) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port: daemonPort, path: "/", headers: { host } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("proxy request timeout")));
  });
}
async function proxyResponds(host) {
  return eventually(async () => {
    const r = await request(host);
    assert.equal(r.status, 200);
    assert.equal(r.body, "script-okay");
    return r;
  });
}
async function workerPids() {
  return (await readdir(join(home, "terminal-worker"))).filter((n) => /^\d+\.json$/.test(n)).sort();
}
let workspace;
let script;
let started = false;
try {
  await cli(["daemon", "start", "--timeout", "30"]);
  started = true;
  workspace = await cli(["workspace", "create", "--isolation", "local", "--path", repo]);
  assert(workspace.workspaceId);
  script = await cli(["script", "start", "web", "--workspace", workspace.workspaceId]);
  const first = await eventually(async () => JSON.parse(await readFile(record, "utf8")));
  assert.equal(first.port, script.port);
  await proxyResponds(script.hostname);
  const workers = await workerPids();
  for (let restart = 0; restart < 2; restart++) {
    await cli(["daemon", "stop", "--keep-terminals", "--timeout", "25"]);
    started = false;
    if (restart === 0) await rm(join(home, "workspace-scripts.json"), { force: true });
    await cli(["daemon", "start", "--timeout", "30"]);
    started = true;
    const list = await cli(["script", "ls", "--workspace", workspace.workspaceId]);
    const restored = list.find((s) => s.scriptName === "web");
    assert(restored);
    assert.equal(restored.lifecycle, "running");
    assert.equal(restored.port, first.port);
    assert.equal(restored.terminalId, script.terminalId);
    assert.equal(restored.hostname, script.hostname);
    assert.deepEqual(await workerPids(), workers);
    await proxyResponds(script.hostname);
    await assert.rejects(
      cli(["script", "start", "web", "--workspace", workspace.workspaceId]),
      (error) => /already running/.test(`${error.message} ${error.stdout} ${error.stderr}`),
    );
    assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, 1);
  }
  const stopped = await cli(["script", "stop", "web", "--workspace", workspace.workspaceId]);
  assert.equal(stopped.lifecycle, "stopped");
  const bind = net.createServer();
  await new Promise((resolve, reject) => {
    bind.once("error", reject);
    bind.listen(first.port, "127.0.0.1", resolve);
  });
  await new Promise((r) => bind.close(r));
  await eventually(async () => {
    await assert.rejects(exec("ps", ["-o", "stat=", "-p", String(first.pid)], { env }), () => true);
  });
  script = await cli(["script", "start", "web", "--workspace", workspace.workspaceId]);
  await proxyResponds(script.hostname);
  assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, 2);
  await cli(["script", "stop", "web", "--workspace", workspace.workspaceId]);
  console.log(
    JSON.stringify({
      restart_count: 2,
      status: "passed",
      terminalId: script.terminalId,
      originalPort: first.port,
      proxy: "passed",
      no_duplicate: "passed",
      stop_releases_port: "passed",
      restart_after_stop: "passed",
    }),
  );
} catch (error) {
  console.error(error);
  console.error(await readFile(join(home, "daemon.log"), "utf8").catch(() => ""));
  throw error;
} finally {
  if (started) await cli(["daemon", "stop", "--timeout", "25"]).catch(() => {});
  // Tests own this home exclusively. A failed keep-terminals phase still needs final cleanup.
  if (!started) await cli(["daemon", "stop", "--force", "--timeout", "5"]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
