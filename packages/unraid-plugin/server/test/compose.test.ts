// Behavioural tests for Docker Compose stacks.
//
// The routes run for real through app.inject(), against real stack
// directories in a temp folder. docker is a fake that holds containers with
// Compose labels and plays the part of the docker:cli container for `docker
// run ... docker compose ...`, reading the files it would see, including a
// candidate mounted over the real compose file. Nothing here touches a real
// server, container or registry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const flashBase = await mkdtemp(join(tmpdir(), "unraidclaw-compose-"));
process.env.FLASH_BASE = flashBase;

const { loadPermissions } = await import("../src/config.js");
const { registerComposeRoutes, createComposeRuntime } = await import("../src/routes/compose.js");
const { redactCompose, restoreHidden, unifiedDiff, groupStacks } = await import("../src/compose.js");
const Fastify = (await import("fastify")).default;

const SECRET = "supersecret123";

async function setPermissions(perms: Record<string, boolean>): Promise<void> {
  await writeFile(join(flashBase, "permissions.json"), JSON.stringify(perms), "utf8");
  loadPermissions();
}

const LOCAL_COMPOSE = `services:
  app:
    image: nginx:alpine
    environment:
      DB_PASSWORD: hunter2
      LOG_LEVEL: info
      API_TOKEN: \${API_TOKEN}
    ports:
      - "8080:80"
  worker:
    image: busybox
    environment:
      - SECRET_KEY=abcdef123
      - MODE=fast
`;

interface Box {
  id: string;
  name: string;
  project: string;
  service: string;
  workingDir: string;
  configFiles: string;
  running: boolean;
}

class FakeDocker {
  boxes: Box[] = [];
  runs: string[][] = [];
  /** Services that stop right after an up, as a broken edit would leave them. */
  crashOnUp = new Set<string>();

  run = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    this.runs.push([file, ...args]);
    if (file === "git") return { stdout: "https://eric:ghp_token123@github.com/eric/gitapp.git\n", stderr: "" };
    if (file !== "docker") throw new Error(`unexpected ${file}`);
    const [cmd] = args;
    if (cmd === "ps") return { stdout: this.boxes.map((b) => b.id).join("\n") + "\n", stderr: "" };
    if (cmd === "inspect") {
      const out = args.slice(1).map((id) => {
        const b = this.boxes.find((x) => x.id === id)!;
        return {
          Id: b.id,
          Name: `/${b.name}`,
          State: { Status: b.running ? "running" : "exited", Running: b.running },
          Config: {
            Image: "img",
            Labels: {
              "com.docker.compose.project": b.project,
              "com.docker.compose.service": b.service,
              "com.docker.compose.project.working_dir": b.workingDir,
              "com.docker.compose.project.config_files": b.configFiles,
            },
          },
        };
      });
      return { stdout: JSON.stringify(out), stderr: "" };
    }
    if (cmd === "start" || cmd === "stop" || cmd === "restart") {
      for (const id of args.slice(1)) {
        const b = this.boxes.find((x) => x.id === id)!;
        b.running = cmd !== "stop";
      }
      return { stdout: "", stderr: "" };
    }
    if (cmd === "run") return this.compose(args);
    throw new Error(`the fake does not implement docker ${args.join(" ")}`);
  };

  /** The docker:cli container: `docker run ... <image> docker compose ...`. */
  private async compose(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const at = args.indexOf("compose");
    const mounts = args.flatMap((a, i) => (a === "-v" ? [args[i + 1]] : []));
    const rest = args.slice(at + 1);
    const project = rest[rest.indexOf("-p") + 1];
    const dryRun = rest.includes("--dry-run");
    const files = rest.flatMap((a, i) => (a === "-f" ? [rest[i + 1]] : []));
    const lastFile = rest.lastIndexOf("-f");
    const sub = rest.slice(lastFile + 2);
    // What the container sees at a path: a mounted candidate wins.
    const seen = async (path: string) => {
      const overlay = mounts.find((m) => m.split(":")[1] === path);
      return readFile(overlay ? overlay.split(":")[0] : path, "utf8");
    };
    const contents = await Promise.all(files.map(seen));
    const stack = this.boxes.filter((b) => b.project === project);

    if (sub[0] === "config") {
      if (contents.some((c) => c.includes("INVALID"))) {
        throw Object.assign(new Error("exit 15"), { stderr: "yaml: line 3: did not find expected key" });
      }
      return { stdout: "", stderr: "" };
    }
    if (sub[0] === "up" && dryRun) {
      return { stdout: stack.map((b) => `DRY-RUN MODE -  Container ${b.name}  Recreate`).join("\n") + "\n", stderr: "" };
    }
    if (sub[0] === "up") {
      for (const b of stack) b.running = !this.crashOnUp.has(b.service) && !contents.some((c) => c.includes(`CRASH_${b.service}`));
      return { stdout: "", stderr: "Container started" };
    }
    if (sub[0] === "pull") return { stdout: "", stderr: "Pulled" };
    if (sub[0] === "logs") return { stdout: `${sub[sub.length - 1]} | fatal: bad config, key ${SECRET}\n`, stderr: "" };
    throw new Error(`the fake compose does not implement ${sub.join(" ")}`);
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "unraidclaw-stacks-"));
  const local = join(root, "web");
  const git = join(root, "gitapp");
  await mkdir(local, { recursive: true });
  await mkdir(join(git, ".git"), { recursive: true });
  await writeFile(join(local, "docker-compose.yml"), LOCAL_COMPOSE, "utf8");
  await writeFile(join(local, ".env"), `API_TOKEN="${SECRET}"\nOTHER=x\n`, "utf8");
  await writeFile(join(git, "docker-compose.yml"), "services:\n  api:\n    image: api\n", "utf8");

  const docker = new FakeDocker();
  const box = (id: string, name: string, project: string, service: string, wd: string, running = true) =>
    docker.boxes.push({ id, name, project, service, workingDir: wd, configFiles: `${wd}/docker-compose.yml`, running });
  box("c1", "web-app-1", "web", "app", local);
  box("c2", "web-worker-1", "web", "worker", local);
  // Deployed from inside a webhook container that mounts the checkout at /app/repo.
  box("c3", "gitapp-api-1", "gitapp", "api", "/app/repo");
  box("c4", "gitapp-db-1", "gitapp", "db", git);
  box("c5", "ghost-x-1", "ghost", "x", "/nowhere");

  const backups = join(root, "backups");
  const app = Fastify();
  registerComposeRoutes(app, createComposeRuntime({ run: docker.run, settleMs: 0, wait: async () => undefined, now: () => new Date("2026-09-27T12:00:00Z"), backup: async (path, project, when) => {
    const dir = join(backups, project);
    await mkdir(dir, { recursive: true });
    const target = join(dir, `file.${when.getTime()}`);
    await writeFile(target, await readFile(path, "utf8"));
    return target;
  } }));
  await app.ready();
  return { app, docker, local, git, backups };
}

const post = (app: Awaited<ReturnType<typeof setup>>["app"], url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object, headers: { "content-type": "application/json" } });

const READ = { "compose:read": true };
const ALL = { "compose:read": true, "compose:update": true };

// ── Pure helpers ────────────────────────────────────────────────

test("secret-looking values and .env values are hidden, references are not", () => {
  const out = redactCompose(LOCAL_COMPOSE, [SECRET]);
  assert.match(out, /DB_PASSWORD: \*\*\*/);
  assert.match(out, /- SECRET_KEY=\*\*\*/);
  assert.match(out, /LOG_LEVEL: info/);
  assert.match(out, /API_TOKEN: \$\{API_TOKEN\}/, "a variable reference is not the secret");
  assert.equal(redactCompose(`x: ${SECRET}`, [SECRET]), "x: ***");
});

test("a hidden value sent back unchanged keeps the real one, and one with nothing to keep is refused", () => {
  const edited = redactCompose(LOCAL_COMPOSE).replace("LOG_LEVEL: info", "LOG_LEVEL: debug");
  const restored = restoreHidden(edited, LOCAL_COMPOSE);
  assert.match(restored, /DB_PASSWORD: hunter2/);
  assert.match(restored, /- SECRET_KEY=abcdef123/);
  assert.match(restored, /LOG_LEVEL: debug/);
  assert.throws(() => restoreHidden("services:\n  a:\n    environment:\n      NEW_PASSWORD: ***\n", LOCAL_COMPOSE), /no value for it to keep/);
});

test("the diff shows only what changed, with context", () => {
  const diff = unifiedDiff("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nd\nX\nf\ng\nh\n", "f.yml");
  assert.match(diff, /^--- f\.yml\n\+\+\+ f\.yml\n@@ -2,7 \+2,7 @@/);
  assert.match(diff, /\n-e\n\+X\n/);
  assert.equal(unifiedDiff("same\n", "same\n", "f"), "");
});

test("one-off containers are not part of a stack", () => {
  const groups = groupStacks([
    { Id: "a", Name: "/p-a-1", State: { Running: true }, Config: { Labels: { "com.docker.compose.project": "p", "com.docker.compose.service": "a" } } },
    { Id: "b", Name: "/p-a-run-1", State: { Running: true }, Config: { Labels: { "com.docker.compose.project": "p", "com.docker.compose.service": "a", "com.docker.compose.oneoff": "True" } } },
  ]);
  assert.equal(groups[0].containers.length, 1);
});

// ── Permissions ─────────────────────────────────────────────────

test("compose routes are off by default, and changes need compose:update", async () => {
  await setPermissions({});
  const { app, docker } = await setup();
  assert.equal((await app.inject({ method: "GET", url: "/api/compose" })).statusCode, 403);
  await setPermissions(READ);
  assert.equal((await app.inject({ method: "GET", url: "/api/compose" })).statusCode, 200);
  assert.equal((await post(app, "/api/compose/web/action", { action: "restart" })).statusCode, 403);
  assert.equal((await post(app, "/api/compose/web/edit", { content: "x" })).statusCode, 403);
  assert.ok(!docker.runs.some((r) => ["restart", "run"].includes(r[1])));
});

// ── Reading ─────────────────────────────────────────────────────

test("stacks are found on the host, including ones deployed from inside a container", async () => {
  await setPermissions(READ);
  const { app, local, git } = await setup();
  const { stacks } = (await app.inject({ method: "GET", url: "/api/compose" })).json().data;
  const by = Object.fromEntries(stacks.map((s: { project: string }) => [s.project, s]));
  assert.deepEqual([by.web.managedBy, by.web.workingDir, by.web.files], ["local", local, [`${local}/docker-compose.yml`]]);
  assert.deepEqual([by.gitapp.managedBy, by.gitapp.workingDir, by.gitapp.files], ["git", git, [`${git}/docker-compose.yml`]]);
  assert.equal(by.ghost.managedBy, "unmanaged");
  assert.deepEqual(by.web.services.map((s: { service: string }) => s.service), ["app", "worker"]);
});

test("a stack's files come back with secrets hidden, and the .env only as keys", async () => {
  await setPermissions(READ);
  const { app } = await setup();
  const res = await app.inject({ method: "GET", url: "/api/compose/web" });
  const d = res.json().data;
  assert.deepEqual(d.envKeys, ["API_TOKEN", "OTHER"]);
  assert.match(d.composeFiles[0].content, /DB_PASSWORD: \*\*\*/);
  assert.doesNotMatch(res.body, /hunter2|abcdef123|supersecret123/);
  const gitRes = await app.inject({ method: "GET", url: "/api/compose/gitapp" });
  assert.equal(gitRes.json().data.gitRemote, "github.com/eric/gitapp.git");
  assert.doesNotMatch(gitRes.body, /ghp_token123/, "remote credentials are never shown");
});

// ── Actions ─────────────────────────────────────────────────────

test("start, stop and restart work on any stack with plain docker", async () => {
  await setPermissions(ALL);
  const { app, docker } = await setup();
  const res = await post(app, "/api/compose/gitapp/action", { action: "stop", services: ["api"] });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(docker.runs.find((r) => r[1] === "stop"), ["docker", "stop", "c3"]);
  assert.equal(docker.boxes.find((b) => b.id === "c3")!.running, false);
  assert.equal(docker.boxes.find((b) => b.id === "c4")!.running, true, "only the named service");
  assert.equal(docker.runs.some((r) => r[1] === "run"), false, "no compose needed");
});

test("pull and up are refused for a git stack, and run through compose for a local one", async () => {
  await setPermissions(ALL);
  const { app, docker, local } = await setup();
  const refused = await post(app, "/api/compose/gitapp/action", { action: "up" });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, "COMPOSE_GIT_MANAGED");

  const dry = await post(app, "/api/compose/web/action", { action: "up", dryRun: true });
  assert.match(dry.json().data.output, /Recreate/);
  const up = await post(app, "/api/compose/web/action", { action: "up" });
  assert.equal(up.statusCode, 200, up.body);
  const run = docker.runs.filter((r) => r[1] === "run").pop()!;
  assert.ok(run.includes("docker:29.5.2-cli"), "the pinned image");
  assert.ok(run.includes(`${local}:${local}`), "the stack's directory at the same path");
  assert.deepEqual(run.slice(run.indexOf("-p")), ["-p", "web", "-f", `${local}/docker-compose.yml`, "up", "-d"]);
});

test("an unknown service or action is refused before anything runs", async () => {
  await setPermissions(ALL);
  const { app, docker } = await setup();
  assert.equal((await post(app, "/api/compose/web/action", { action: "restart", services: ["nope"] })).statusCode, 400);
  assert.equal((await post(app, "/api/compose/web/action", { action: "down" })).statusCode, 400);
  assert.equal((await post(app, "/api/compose/web/action", { action: "restart", dryrun: true })).json().error.message.includes("dryRun"), true);
  assert.equal(docker.runs.some((r) => ["restart", "run"].includes(r[1])), false);
});

// ── Edits ───────────────────────────────────────────────────────

test("a git stack's files are never edited here", async () => {
  await setPermissions(ALL);
  const { app, git } = await setup();
  const res = await post(app, "/api/compose/gitapp/edit", { content: "services: {}\n" });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "COMPOSE_GIT_MANAGED");
  assert.equal(await readFile(join(git, "docker-compose.yml"), "utf8"), "services:\n  api:\n    image: api\n");
});

test("a dry run checks the candidate in place of the file and changes nothing", async () => {
  await setPermissions(ALL);
  const { app, docker, local } = await setup();
  const shown = (await app.inject({ method: "GET", url: "/api/compose/web" })).json().data.composeFiles[0].content;
  const res = await post(app, "/api/compose/web/edit", { content: shown.replace("LOG_LEVEL: info", "LOG_LEVEL: debug"), dryRun: true });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.match(d.diff, /-      LOG_LEVEL: info\n\+      LOG_LEVEL: debug/);
  assert.doesNotMatch(d.diff, /hunter2|abcdef123/, "secrets stay hidden in the diff");
  assert.ok(d.plannedActions.some((l: string) => l.includes("Recreate")));
  const config = docker.runs.find((r) => r.includes("config"))!;
  assert.ok(config.some((a) => a.endsWith(`:${local}/docker-compose.yml:ro`)), "the candidate is mounted over the real file");
  assert.equal(await readFile(join(local, "docker-compose.yml"), "utf8"), LOCAL_COMPOSE);
  assert.equal(docker.runs.some((r) => r[1] === "run" && r.includes("up") && !r.includes("--dry-run")), false);
});

test("an edit keeps hidden secrets, backs up the file and redeploys", async () => {
  await setPermissions(ALL);
  const { app, local } = await setup();
  const shown = (await app.inject({ method: "GET", url: "/api/compose/web" })).json().data.composeFiles[0].content;
  const res = await post(app, "/api/compose/web/edit", { content: shown.replace("MODE=fast", "MODE=slow") });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json().data;
  assert.equal(d.redeployed, true);
  const saved = await readFile(join(local, "docker-compose.yml"), "utf8");
  assert.match(saved, /- MODE=slow/);
  assert.match(saved, /DB_PASSWORD: hunter2/, "the real password, not ***");
  assert.match(saved, /- SECRET_KEY=abcdef123/);
  assert.equal(await readFile(d.backupPath, "utf8"), LOCAL_COMPOSE);
});

test("a file Compose rejects is refused and never written", async () => {
  await setPermissions(ALL);
  const { app, local } = await setup();
  const res = await post(app, "/api/compose/web/edit", { content: "services:\n  INVALID\n" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "COMPOSE_INVALID");
  assert.equal(await readFile(join(local, "docker-compose.yml"), "utf8"), LOCAL_COMPOSE);
});

test("an edit that leaves a service down is rolled back and redeployed as it was", async () => {
  await setPermissions(ALL);
  const { app, docker, local, backups } = await setup();
  const broken = LOCAL_COMPOSE.replace("MODE=fast", "MODE=CRASH_worker");
  const res = await post(app, "/api/compose/web/edit", { content: broken });
  assert.equal(res.statusCode, 500);
  const { error } = res.json();
  assert.equal(error.code, "COMPOSE_REDEPLOY_FAILED");
  assert.match(error.message, /worker did not stay up/);
  assert.match(error.details.logs.worker, /fatal: bad config, key \*\*\*/, "logs are redacted");
  assert.equal(await readFile(join(local, "docker-compose.yml"), "utf8"), LOCAL_COMPOSE, "the previous file is back");
  assert.equal(docker.boxes.find((b) => b.id === "c2")!.running, true, "and redeployed");
  assert.equal((await readdir(join(backups, "web"))).length, 1);
});

test("an edit with no real change does nothing", async () => {
  await setPermissions(ALL);
  const { app, docker } = await setup();
  const shown = (await app.inject({ method: "GET", url: "/api/compose/web" })).json().data.composeFiles[0].content;
  const res = await post(app, "/api/compose/web/edit", { content: shown });
  assert.equal(res.statusCode, 200);
  assert.match(res.json().data.warnings[0], /already has this content/);
  assert.equal(docker.runs.some((r) => r[1] === "run"), false);
});
