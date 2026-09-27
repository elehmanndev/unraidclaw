// Behavioural tests for background jobs.
//
// The job routes run for real, and so do the tool definitions they call: a job
// for unraid_ca_update really goes through that tool into POST
// /api/ca/app/:name/update. That route and the notification route are small
// fakes here, so a test controls when an operation finishes and how, and sees
// exactly what each request carried.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const flashBase = await mkdtemp(join(tmpdir(), "unraidclaw-jobs-"));
process.env.FLASH_BASE = flashBase;

const { loadPermissions } = await import("../src/config.js");
const { registerJobRoutes, createJobsRuntime } = await import("../src/routes/jobs.js");
const Fastify = (await import("fastify")).default;

const KEY = "job-test-key-123";

async function setPermissions(perms: Record<string, boolean>): Promise<void> {
  await writeFile(join(flashBase, "permissions.json"), JSON.stringify(perms), "utf8");
  loadPermissions();
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

async function harness(opts: { maxRunning?: number; keep?: number; notifyStatus?: number } = {}) {
  const app = Fastify();
  const updates: Array<{ name: string; key: unknown; body: unknown }> = [];
  const notifications: Array<Record<string, string>> = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  let seq = 0;

  app.post<{ Params: { name: string } }>("/api/ca/app/:name/update", async (req, reply) => {
    updates.push({ name: req.params.name, key: req.headers["x-api-key"], body: req.body });
    await gates.get(req.params.name)?.promise;
    if (req.params.name === "broken") {
      return reply.status(422).send({ ok: false, error: { code: "CA_NOT_UPDATABLE", message: "broken cannot be updated" } });
    }
    return reply.send({ ok: true, data: { name: req.params.name, updated: true } });
  });
  app.post("/api/notifications", async (req, reply) => {
    notifications.push(req.body as Record<string, string>);
    if (opts.notifyStatus && opts.notifyStatus !== 200) {
      return reply.status(opts.notifyStatus).send({ ok: false, error: { code: "FORBIDDEN", message: "Permission denied: notification:create" } });
    }
    return reply.send({ ok: true, data: { message: "Notification created" } });
  });
  registerJobRoutes(app, createJobsRuntime({ maxRunning: opts.maxRunning ?? 2, keep: opts.keep ?? 50, id: () => `job-${++seq}` }));
  await app.ready();

  const start = (payload: unknown, key: string | undefined = KEY) =>
    app.inject({ method: "POST", url: "/api/jobs", payload: payload as object, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) } });
  const get = (id: string) => app.inject({ method: "GET", url: `/api/jobs/${id}` });
  const settle = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const job = get(id).then((r) => r.json().data);
      const d = await job;
      if (d && (d.status === "succeeded" || d.status === "failed") && d.notification !== "pending") return d;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`job ${id} did not finish`);
  };
  return { app, updates, notifications, gates, start, get, settle };
}

const ALL = { "jobs:read": true, "jobs:create": true };

test("jobs are off by default", async () => {
  await setPermissions({});
  const h = await harness();
  assert.equal((await h.start({ tool: "unraid_ca_update", arguments: { name: "jellyfin" } })).statusCode, 403);
  assert.equal((await h.app.inject({ method: "GET", url: "/api/jobs" })).statusCode, 403);
  assert.deepEqual(h.updates, []);
});

test("only the long-running tools can be jobs, and arguments are checked before queueing", async () => {
  await setPermissions(ALL);
  const h = await harness();
  const other = await h.start({ tool: "unraid_docker_list" });
  assert.equal(other.statusCode, 400);
  assert.match(other.json().error.message, /quick enough to call directly/);
  const typo = await h.start({ tool: "unraid_ca_update", arguments: { name: "jellyfin", dryrun: true } });
  assert.equal(typo.statusCode, 400);
  assert.match(typo.json().error.message, /Nothing was queued/);
  assert.equal((await h.start({ tool: "unraid_ca_update", arguments: {}, colour: "red" })).statusCode, 400);
  assert.deepEqual(h.updates, [], "nothing ran");
});

test("a job runs the tool as the caller and reports its result and a notification", async () => {
  await setPermissions(ALL);
  const h = await harness();
  const res = await h.start({ tool: "unraid_ca_update", arguments: { name: "jellyfin" } });
  assert.equal(res.statusCode, 202);
  const { id, target } = res.json().data;
  assert.equal(target, "jellyfin");
  const job = await h.settle(id);
  assert.equal(job.status, "succeeded");
  assert.deepEqual(job.result, { name: "jellyfin", updated: true });
  assert.equal(h.updates[0].key, KEY, "the tool's request carried the submitter's key");
  assert.equal(job.notification, "sent");
  assert.deepEqual([h.notifications[0].subject, h.notifications[0].importance], ["Finished: ca update of jellyfin", "normal"]);
  assert.doesNotMatch(JSON.stringify(job), new RegExp(KEY), "the key is never shown");
  assert.equal(job.arguments, undefined, "arguments are not echoed");
});

test("a failed tool fails the job and sends a warning", async () => {
  await setPermissions(ALL);
  const h = await harness();
  const { id } = (await h.start({ tool: "unraid_ca_update", arguments: { name: "broken" } })).json().data;
  const job = await h.settle(id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /CA_NOT_UPDATABLE: broken cannot be updated/);
  assert.deepEqual([h.notifications[0].subject, h.notifications[0].importance], ["Failed: ca update of broken", "warning"]);
});

test("notifications can be turned off, and a missing permission is reported, not fatal", async () => {
  await setPermissions(ALL);
  const off = await harness();
  const a = await off.settle((await off.start({ tool: "unraid_ca_update", arguments: { name: "jellyfin" }, notify: false })).json().data.id);
  assert.deepEqual([a.status, a.notification, off.notifications.length], ["succeeded", "off", 0]);

  const denied = await harness({ notifyStatus: 403 });
  const b = await denied.settle((await denied.start({ tool: "unraid_ca_update", arguments: { name: "jellyfin" } })).json().data.id);
  assert.deepEqual([b.status, b.notification], ["succeeded", "not permitted"]);
});

test("jobs beyond the running limit wait their turn", async () => {
  await setPermissions(ALL);
  const h = await harness({ maxRunning: 1 });
  const gate = deferred();
  h.gates.set("first", gate);
  const first = (await h.start({ tool: "unraid_ca_update", arguments: { name: "first" } })).json().data.id;
  const second = (await h.start({ tool: "unraid_ca_update", arguments: { name: "second" } })).json().data.id;
  await new Promise((r) => setImmediate(r));
  assert.equal((await h.get(first)).json().data.status, "running");
  assert.equal((await h.get(second)).json().data.status, "queued");
  const list = (await h.app.inject({ method: "GET", url: "/api/jobs" })).json().data;
  assert.deepEqual([list.running, list.queued, list.jobs[0].id], [1, 1, second], "newest first");
  gate.release();
  assert.equal((await h.settle(first)).status, "succeeded");
  assert.equal((await h.settle(second)).status, "succeeded");
  assert.deepEqual(h.updates.map((u) => u.name), ["first", "second"]);
});

test("only the last finished jobs are kept", async () => {
  await setPermissions(ALL);
  const h = await harness({ keep: 2 });
  const ids: string[] = [];
  for (const name of ["a", "b", "c"]) {
    const id = (await h.start({ tool: "unraid_ca_update", arguments: { name } })).json().data.id;
    await h.settle(id);
    ids.push(id);
  }
  assert.equal((await h.get(ids[0])).statusCode, 404);
  assert.equal((await h.get(ids[2])).statusCode, 200);
});

test("a job needs the caller's key to run", async () => {
  await setPermissions(ALL);
  const h = await harness();
  const res = await h.start({ tool: "unraid_ca_update", arguments: { name: "jellyfin" } }, "");
  assert.equal(res.statusCode, 401);
});
