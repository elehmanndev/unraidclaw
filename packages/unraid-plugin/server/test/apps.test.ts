// Behavioural tests for calling an installed app's own API.
//
// The routes run for real through app.inject(). The "app" is a small HTTP
// server on loopback, docker is a fake whose inspect output points at it, and
// the saved keys are a real file in a temp directory. Nothing here touches a
// real Unraid server or a real container.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

const flashBase = await mkdtemp(join(tmpdir(), "unraidclaw-apps-"));
process.env.FLASH_BASE = flashBase;

const { loadPermissions } = await import("../src/config.js");
const { registerAppRoutes, createAppsRuntime, resolveContainer } = await import("../src/routes/apps.js");
const { parseAppKeys, readAppKeys } = await import("../src/app-keys.js");
const Fastify = (await import("fastify")).default;

const KEY = "immich-secret-key-123";

async function setPermissions(perms: Record<string, boolean>): Promise<void> {
  await writeFile(join(flashBase, "permissions.json"), JSON.stringify(perms), "utf8");
  loadPermissions();
}

// ── A stand-in app ──────────────────────────────────────────────

const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/echo") {
      res.setHeader("content-type", "application/json");
      res.setHeader("set-cookie", "session=abc; HttpOnly");
      res.end(JSON.stringify({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, sawKey: req.headers["x-api-key"] ?? null }));
    } else if (url.pathname === "/leak") {
      res.setHeader("content-type", "text/plain");
      res.setHeader("location", `/next?token=${KEY}`);
      res.end(`your key is ${KEY}`);
    } else if (url.pathname === "/big") {
      res.setHeader("content-type", "text/plain");
      res.end("x".repeat(900 * 1024));
    } else if (url.pathname === "/image") {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.alloc(2048, 7));
    } else if (url.pathname === "/slow") {
      // Never answers; the request must time out.
    } else if (url.pathname === "/missing") {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end('{"message":"not found"}');
    } else {
      res.end("ok");
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const appPort = (server.address() as AddressInfo).port;
after(() => server.close());

// ── A fake docker ───────────────────────────────────────────────

interface Box {
  name: string;
  running?: boolean;
  network?: string;
  ip?: string;
  ports?: number[];
  webui?: string;
}

function inspectJson(b: Box): Record<string, unknown> {
  const network = b.network ?? "bridge";
  return {
    Name: `/${b.name}`,
    State: { Running: b.running ?? true },
    Config: {
      ExposedPorts: Object.fromEntries((b.ports ?? [appPort]).map((p) => [`${p}/tcp`, {}])),
      Labels: b.webui !== undefined ? { "net.unraid.docker.webui": b.webui } : {},
    },
    HostConfig: { NetworkMode: network },
    NetworkSettings: { Networks: network === "host" ? { host: {} } : { [network]: { IPAddress: b.ip ?? "127.0.0.1" } } },
  };
}

function fakeDocker(boxes: Box[]) {
  const runs: string[][] = [];
  const run = async (file: string, args: string[]) => {
    runs.push([file, ...args]);
    if (file !== "docker") throw new Error(`unexpected ${file}`);
    if (args[0] === "ps") return { stdout: boxes.map((b) => b.name).join("\n") + "\n", stderr: "" };
    if (args[0] === "inspect") {
      const names = args.slice(3);
      const out = names.map((n) => {
        const b = boxes.find((x) => x.name === n);
        if (!b) throw Object.assign(new Error(`Error: No such container: ${n}`), { stderr: `Error: No such container: ${n}` });
        return inspectJson(b);
      });
      return { stdout: JSON.stringify(out), stderr: "" };
    }
    throw new Error(`the fake does not implement docker ${args.join(" ")}`);
  };
  return { run, runs };
}

async function harness(boxes: Box[], keys: Record<string, unknown> = {}) {
  const keysFile = join(await mkdtemp(join(tmpdir(), "unraidclaw-keys-")), "app-keys.json");
  await writeFile(keysFile, JSON.stringify(keys), "utf8");
  const docker = fakeDocker(boxes);
  const app = Fastify();
  registerAppRoutes(app, createAppsRuntime({ run: docker.run, readKeys: () => readAppKeys(keysFile) }));
  await app.ready();
  return { app, docker };
}

const IMMICH: Box = { name: "immich" };
const IMMICH_KEY = { immich: { type: "header", header: "x-api-key", value: KEY } };

const call = (app: Awaited<ReturnType<typeof harness>>["app"], name: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/apps/${name}/request`, payload: payload as object, headers: { "content-type": "application/json" } });

// ── Keys file ───────────────────────────────────────────────────

test("the keys file accepts the three kinds of key and skips anything malformed", () => {
  const keys = parseAppKeys(JSON.stringify({
    immich: { type: "header", header: "x-api-key", value: "a" },
    jellyfin: { type: "bearer", value: "b" },
    npm: { type: "basic", username: "admin", value: "c" },
    "bad name!": { type: "bearer", value: "x" },
    noheader: { type: "header", header: "bad header", value: "x" },
    colon: { type: "basic", username: "a:b", value: "x" },
    newline: { type: "bearer", value: "x\ny" },
    unknown: { type: "cookie", value: "x" },
  }));
  assert.deepEqual([...keys.keys()].sort(), ["immich", "jellyfin", "npm"]);
  assert.equal(keys.get("jellyfin")?.header, "Authorization");
  assert.equal(parseAppKeys("not json").size, 0);
});

// ── Permissions ─────────────────────────────────────────────────

test("app requests are off in a default permission file", async () => {
  await setPermissions({});
  const { app, docker } = await harness([IMMICH]);
  assert.equal((await app.inject({ method: "GET", url: "/api/apps" })).statusCode, 403);
  assert.equal((await call(app, "immich", { path: "/echo" })).statusCode, 403);
  assert.deepEqual(docker.runs, []);
});

test("apps:read allows GET and HEAD but not a change, not even as a dry run", async () => {
  await setPermissions({ "apps:read": true });
  const { app } = await harness([IMMICH]);
  assert.equal((await call(app, "immich", { path: "/echo" })).statusCode, 200);
  assert.equal((await call(app, "immich", { method: "HEAD", path: "/echo" })).statusCode, 200);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await call(app, "immich", { method, path: "/echo", dryRun: true });
    assert.equal(res.statusCode, 403, method);
    assert.match(res.json().error.message, /apps:update/);
  }
});

// ── Requests ────────────────────────────────────────────────────

test("a request reaches the container with the saved key, which never comes back", async () => {
  await setPermissions({ "apps:read": true, "apps:update": true });
  const { app } = await harness([IMMICH], IMMICH_KEY);
  seen.length = 0;
  const res = await call(app, "immich", { method: "POST", path: "/echo", query: { page: 2, all: true }, body: { albumName: "test" } });
  assert.equal(res.statusCode, 200, res.body);
  const { data } = res.json();
  assert.equal(data.status, 200);
  assert.deepEqual(data.key, { type: "header", header: "x-api-key" });
  assert.equal(data.requestHeaders["x-api-key"], "***");
  assert.deepEqual(data.json.query, { page: "2", all: "true" });
  assert.equal(data.json.body, '{"albumName":"test"}');
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.equal(seen[0].headers["x-api-key"], KEY, "the app got the real key");
  assert.equal(data.json.sawKey, "***", "an echoed key is redacted");
  assert.equal(data.headers["set-cookie"], undefined, "session cookies are not passed back");
  assert.doesNotMatch(res.body, new RegExp(KEY));
});

test("bearer and basic keys become an Authorization header", async () => {
  await setPermissions({ "apps:read": true });
  const { app } = await harness([{ name: "jellyfin" }, { name: "npm" }], {
    jellyfin: { type: "bearer", value: "tok-123456" },
    npm: { type: "basic", username: "admin", value: "pass-123456" },
  });
  seen.length = 0;
  await call(app, "jellyfin", { path: "/echo" });
  await call(app, "npm", { path: "/echo" });
  assert.equal(seen[0].headers.authorization, "Bearer tok-123456");
  assert.equal(seen[1].headers.authorization, `Basic ${Buffer.from("admin:pass-123456").toString("base64")}`);
});

test("a key found in a body or a Location header is redacted", async () => {
  await setPermissions({ "apps:read": true });
  const { app } = await harness([IMMICH], IMMICH_KEY);
  const res = await call(app, "immich", { path: "/leak" });
  const { data } = res.json();
  assert.equal(data.text, "your key is ***");
  assert.equal(data.headers.location, "/next?token=***");
});

test("the caller cannot override the saved key or set transport headers", async () => {
  await setPermissions({ "apps:read": true });
  const { app } = await harness([IMMICH], IMMICH_KEY);
  const override = await call(app, "immich", { path: "/echo", headers: { "X-API-Key": "other" } });
  assert.equal(override.statusCode, 400);
  assert.match(override.json().error.message, /carries the key/);
  const host = await call(app, "immich", { path: "/echo", headers: { Host: "evil.example" } });
  assert.equal(host.statusCode, 400);
});

test("a dry run shows the request and sends nothing", async () => {
  await setPermissions({ "apps:read": true, "apps:update": true });
  const { app } = await harness([IMMICH], IMMICH_KEY);
  seen.length = 0;
  const res = await call(app, "immich", { method: "DELETE", path: "/api/albums/42", dryRun: true });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.equal(data.dryRun, true);
  assert.equal(data.url, `http://127.0.0.1:${appPort}/api/albums/42`);
  assert.equal(data.status, undefined);
  assert.equal(seen.length, 0, "nothing reached the app");
});

// ── Finding the app ─────────────────────────────────────────────

test("the port comes from the request, then the WebUI link, then the only exposed port", async () => {
  await setPermissions({ "apps:read": true });
  const { app } = await harness([
    { name: "one", ports: [appPort] },
    { name: "webui", ports: [1, 2], webui: `http://[IP]:[PORT:${appPort}]/` },
    { name: "many", ports: [1, 2] },
  ]);
  assert.equal((await call(app, "one", { path: "/echo" })).json().data.status, 200);
  assert.equal((await call(app, "webui", { path: "/echo" })).json().data.status, 200);
  const many = await call(app, "many", { path: "/echo" });
  assert.equal(many.statusCode, 400);
  assert.equal(many.json().error.code, "APP_PORT_AMBIGUOUS");
  assert.equal((await call(app, "many", { path: "/echo", port: appPort })).json().data.status, 200);
});

test("a host-network container is reached on loopback", () => {
  const r = resolveContainer(inspectJson({ name: "ha", network: "host", webui: "http://[IP]:[PORT:8123]" }));
  assert.equal(r.host, "127.0.0.1");
  assert.equal(r.webuiPort, 8123);
});

test("a container sharing another's network, a stopped one and an unknown one are refused", async () => {
  await setPermissions({ "apps:read": true });
  const { app } = await harness([{ name: "down", running: false }, { name: "shared", network: "container:vpn" }]);
  assert.equal((await call(app, "down", { path: "/" })).json().error.code, "APP_NOT_RUNNING");
  assert.equal((await call(app, "shared", { path: "/" })).json().error.code, "APP_UNREACHABLE");
  assert.equal((await call(app, "ghost", { path: "/" })).statusCode, 404);
});

test("the path can only be a path on the container", async () => {
  await setPermissions({ "apps:read": true });
  const { app } = await harness([IMMICH]);
  for (const path of ["http://evil.example/", "//evil.example/x", "echo", "/a b", "/a#b", "/a\nb"]) {
    assert.equal((await call(app, "immich", { path })).statusCode, 400, path);
  }
});

test("request bodies are checked by hand", async () => {
  await setPermissions({ "apps:read": true, "apps:update": true });
  const { app } = await harness([IMMICH]);
  assert.match((await call(app, "immich", { path: "/", dryrun: true })).json().error.message, /Did you mean "dryRun"/);
  assert.equal((await call(app, "immich", { path: "/", body: "x" })).statusCode, 400, "a GET cannot have a body");
  assert.equal((await call(app, "immich", { method: "TRACE", path: "/" })).statusCode, 400);
  assert.equal((await call(app, "immich", { path: "/", timeoutMs: 10 })).statusCode, 400);
});

// ── Responses ───────────────────────────────────────────────────

test("an app's own error status is reported, not turned into a failure", async () => {
  await setPermissions({ "apps:read": true });
  const { app } = await harness([IMMICH]);
  const res = await call(app, "immich", { path: "/missing" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.json().data.status, res.json().data.json], [404, { message: "not found" }]);
});

test("large bodies are cut off, binary ones are only measured, and slow apps time out", async () => {
  await setPermissions({ "apps:read": true });
  const { app } = await harness([IMMICH]);
  const big = (await call(app, "immich", { path: "/big" })).json().data;
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, 512 * 1024);
  const image = (await call(app, "immich", { path: "/image" })).json().data;
  assert.deepEqual([image.binaryBytes, image.text, image.json], [2048, undefined, undefined]);
  const slow = await call(app, "immich", { path: "/slow", timeoutMs: 1000 });
  assert.equal(slow.statusCode, 502);
  assert.match(slow.json().error.message, /no answer within 1000 ms/);
});

test("the app list says where requests go and which apps have a key, never the key", async () => {
  await setPermissions({ "apps:read": true });
  const { app } = await harness([IMMICH, { name: "many", ports: [1, 2] }, { name: "vpn-client", network: "container:vpn" }], IMMICH_KEY);
  const res = await app.inject({ method: "GET", url: "/api/apps" });
  assert.equal(res.statusCode, 200);
  const apps = res.json().data.apps as Array<{ name: string; baseUrl: string | null; key: unknown }>;
  assert.deepEqual(apps.map((a) => [a.name, a.baseUrl, a.key]), [
    ["immich", `http://127.0.0.1:${appPort}`, { type: "header", header: "x-api-key" }],
    ["many", null, null],
    ["vpn-client", null, null],
  ]);
  assert.doesNotMatch(res.body, new RegExp(KEY));
});
