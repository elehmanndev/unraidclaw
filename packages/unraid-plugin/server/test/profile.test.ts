// Tests for the setup profile: the values new installs fill in.
//
// The routes run for real through app.inject(). docker is a fake that answers
// `ps` and `inspect` from fixture records, and the profile is a real file in a
// temp directory. Nothing here touches a real Unraid server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaConfigEntry } from "@unraidclaw/shared";

const flashBase = await mkdtemp(join(tmpdir(), "unraidclaw-profile-"));
process.env.FLASH_BASE = flashBase;

const { loadPermissions } = await import("../src/config.js");
const { registerProfileRoutes, createProfileRuntime } = await import("../src/routes/profile.js");
const { applyProfile, detectConventions, mergeProfile, parseProfileUpdate, parseStoredProfile, ProfileError } = await import("../src/profile.js");
const { overrideKey } = await import("../src/ca-template.js");
const { createCaRuntime } = await import("../src/routes/ca.js");
const Fastify = (await import("fastify")).default;

const ALL = { "profile:read": true, "profile:update": true };

async function setPermissions(perms: Record<string, boolean>): Promise<void> {
  await writeFile(join(flashBase, "permissions.json"), JSON.stringify(perms), "utf8");
  loadPermissions();
}

function entry(type: CaConfigEntry["type"], target: string, value: string, extra: Partial<CaConfigEntry> = {}): CaConfigEntry {
  return { name: `${type}: ${target}`, target, type, default: value, mode: type === "Path" ? "rw" : "", description: "", required: false, mask: false, ...extra };
}

function box(name: string, env: string[], mounts: Array<[string, string]>, network = "bridge") {
  return {
    Name: `/${name}`,
    Config: { Env: env },
    HostConfig: { NetworkMode: network },
    Mounts: mounts.map(([Source, Destination]) => ({ Type: "bind", Source, Destination })),
  };
}

const BOXES = [
  box("jellyfin", ["TZ=Europe/Madrid", "PUID=99", "PGID=100", "PATH=/usr/bin"], [["/mnt/user/appdata/jellyfin", "/config"], ["/mnt/user/Media", "/media"]]),
  box("immich", ["TZ=Europe/Madrid"], [["/mnt/user/appdata/immich", "/config"], ["/mnt/user/Media/", "/media/"], ["/mnt/user/Photos", "/photos"]]),
  box("deluge", ["TZ=Europe/Paris", "PUID=99", "PGID=100"], [["/mnt/user/appdata/deluge", "/config"], ["/mnt/user/downloads", "/data"]], "br0"),
  box("couch", ["TZ=Europe/Paris"], [["/mnt/cache/appdata/couch", "/opt/couchdb/data"]]),
  box("volume-only", [], []),
];

function fakeRun(boxes: unknown[], calls: string[][] = []) {
  return async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (file !== "docker") throw new Error(`unexpected ${file}`);
    if (args[0] === "ps") return { stdout: boxes.map((_, i) => `id${i}`).join("\n") + "\n", stderr: "" };
    if (args[0] === "inspect") return { stdout: JSON.stringify(boxes), stderr: "" };
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
}

async function harness(file: string, opts: { run?: ReturnType<typeof fakeRun>; timeZone?: string | null } = {}) {
  const runtime = createProfileRuntime(createCaRuntime(), {
    file,
    run: opts.run ?? fakeRun(BOXES),
    readHostVars: async () => ({ timeZone: opts.timeZone === undefined ? "Europe/Madrid" : opts.timeZone, hostName: "Tower" }),
    now: () => new Date("2026-09-29T10:00:00.000Z"),
  });
  const app = Fastify();
  registerProfileRoutes(app, runtime);
  await app.ready();
  return app;
}

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "unraidclaw-profile-file-")), "profile.json");
}

// ── Checking a change ───────────────────────────────────────────

test("a profile change refuses unknown fields and names the one meant", () => {
  assert.throws(() => parseProfileUpdate({ variable: { TZ: "UTC" } }), (e: InstanceType<typeof ProfileError>) => {
    assert.equal(e.code, "PROFILE_INVALID_BODY");
    assert.match(e.message, /Allowed fields are/);
    return true;
  });
  assert.throws(() => parseProfileUpdate({ dryrun: true, notes: "x" }), /Did you mean "dryRun"/);
});

test("a profile change refuses values that could not be used as they are", () => {
  const bad: Array<[unknown, RegExp]> = [
    [{ dryRun: "true", notes: "x" }, /"dryRun" must be true or false/],
    [{ variables: { "BAD NAME": "1" } }, /not a valid variable name/],
    [{ variables: { TZ: "Europe/Madrid\n-e EVIL=1" } }, /control character/],
    [{ variables: { PUID: 99 } }, /must be a string/],
    [{ variables: ["TZ"] }, /must be an object/],
    [{ paths: { media: "/mnt/user/Media" } }, /absolute path inside the container/],
    [{ paths: { "/media": "relative/Media" } }, /must be an absolute folder/],
    [{ paths: { "/media": "/" } }, /other than \//],
    [{ paths: { "/media": "/mnt/user/Media:/etc" } }, /must not contain a colon/],
    [{ appdataRoot: "/boot/appdata" } , /folder under \/mnt/],
    [{ appdataRoot: 5 }, /must be a string/],
    [{ notes: "ring\u0007bell" }, /control character/],
    [{}, /Nothing to change/],
    [{ dryRun: true }, /Nothing to change/],
    [[], /must be a JSON object/],
  ];
  for (const [body, message] of bad) {
    assert.throws(() => parseProfileUpdate(body), message, JSON.stringify(body));
  }
});

test("a profile change normalizes paths and keeps notes as prose", () => {
  const update = parseProfileUpdate({
    paths: { "/media/": "/mnt/user/Media/" },
    appdataRoot: "/mnt/cache/appdata/",
    notes: "Line one\r\nLine two\twith a tab",
    variables: { TZ: "Europe/Madrid", PUID: null },
  });
  assert.deepEqual(update.paths, { "/media": "/mnt/user/Media" });
  assert.equal(update.appdataRoot, "/mnt/cache/appdata");
  assert.equal(update.notes, "Line one\nLine two\twith a tab");
  assert.deepEqual(update.variables, { TZ: "Europe/Madrid", PUID: null });
  assert.equal(parseProfileUpdate({ appdataRoot: "" }).appdataRoot, null);
  assert.equal(parseProfileUpdate({ notes: "" }).notes, null);
});

test("merging a change keeps what it leaves out and reports what changed", () => {
  const current = { variables: { TZ: "Europe/Paris", PUID: "99" }, paths: { "/media": "/mnt/user/Media" }, notes: "keep", updatedAt: "2026-01-01T00:00:00.000Z" };
  const { profile, changed } = mergeProfile(current, { variables: { TZ: "Europe/Madrid", PUID: null, UMASK: "022" }, appdataRoot: "/mnt/user/appdata" });
  assert.deepEqual(profile, {
    variables: { TZ: "Europe/Madrid", UMASK: "022" },
    paths: { "/media": "/mnt/user/Media" },
    appdataRoot: "/mnt/user/appdata",
    notes: "keep",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(changed.sort(), ["appdataRoot", "variables.PUID", "variables.TZ", "variables.UMASK"]);

  const cleared = mergeProfile(current, { paths: null, notes: null });
  assert.equal(cleared.profile.paths, undefined);
  assert.equal(cleared.profile.notes, undefined);
  assert.deepEqual(cleared.changed.sort(), ["notes", "paths./media"]);

  assert.deepEqual(mergeProfile(current, { variables: { TZ: "Europe/Paris" } }).changed, [], "setting the same value changes nothing");
});

test("a hand-edited profile keeps its good entries and drops the rest", () => {
  const profile = parseStoredProfile(JSON.stringify({
    variables: { TZ: "Europe/Madrid", "bad name": "x", PUID: 99 },
    paths: { "/media/": "/mnt/user/Media", relative: "/mnt/user/x", "/y": "/mnt/a:b" },
    appdataRoot: "/etc",
    notes: "fine",
    extra: "ignored",
  }));
  assert.deepEqual(profile, { variables: { TZ: "Europe/Madrid" }, paths: { "/media": "/mnt/user/Media" }, notes: "fine" });
  assert.deepEqual(parseStoredProfile("not json"), {});
  assert.deepEqual(parseStoredProfile("[1,2]"), {});
});

// ── Applying it to an install ───────────────────────────────────

test("the profile fills unset variables and paths, and the caller's values win", () => {
  const config = [
    entry("Variable", "TZ", "Etc/UTC"),
    entry("Variable", "PUID", "1000"),
    entry("Variable", "PGID", "100"),
    entry("Path", "/media/", ""),
    entry("Path", "/config", "/mnt/cache/appdata/plex"),
    entry("Path", "/transcode", "/tmp"),
    entry("Port", "8096", "8096"),
  ];
  const overrides = new Map([[overrideKey(config[1]), "1234"]]);
  const profile = {
    variables: { TZ: "Europe/Madrid", PUID: "99", PGID: "100", PORT: "1" },
    paths: { "/media": "/mnt/user/Media" },
    appdataRoot: "/mnt/user/appdata",
  };
  const { overrides: out, applied } = applyProfile(config, overrides, profile, overrideKey);
  assert.equal(out.get(overrideKey(config[0])), "Europe/Madrid");
  assert.equal(out.get(overrideKey(config[1])), "1234", "the caller's PUID is kept");
  assert.equal(out.has(overrideKey(config[2])), false, "a value equal to the default is not an override");
  assert.equal(out.get(overrideKey(config[3])), "/mnt/user/Media", "a trailing slash on the target still matches");
  assert.equal(out.get(overrideKey(config[4])), "/mnt/user/appdata/plex", "an appdata default moves under appdataRoot");
  assert.equal(out.has(overrideKey(config[5])), false, "a path outside appdata is left alone");
  assert.equal(out.has(overrideKey(config[6])), false, "ports are never filled");
  assert.deepEqual(applied, [
    { field: "Variable: TZ", value: "Europe/Madrid", replaced: "Etc/UTC", from: "variables.TZ" },
    { field: "Path: /media/", value: "/mnt/user/Media", replaced: "", from: "paths./media" },
    { field: "Path: /config", value: "/mnt/user/appdata/plex", replaced: "/mnt/cache/appdata/plex", from: "appdataRoot" },
  ]);
  assert.equal(overrides.size, 1, "the caller's map is not changed");
});

test("the profile respects dropdowns and hides masked values", () => {
  const config = [
    entry("Variable", "UMASK", "022", { choices: ["022", "002"] }),
    entry("Variable", "TOKEN", "", { mask: true }),
    entry("Path", "/config", "/mnt/user/appdata/app", {}),
  ];
  const { applied } = applyProfile(config, new Map(), { variables: { UMASK: "000", TOKEN: "s3cret" }, paths: { "/config": "/mnt/user/appdata/other" } }, overrideKey);
  assert.deepEqual(applied, [
    { field: "Variable: TOKEN", value: "(hidden)", replaced: "(hidden)", from: "variables.TOKEN" },
    { field: "Path: /config", value: "/mnt/user/appdata/other", replaced: "/mnt/user/appdata/app", from: "paths./config" },
  ], "UMASK keeps its default because 000 is not one of its options; a path entry beats appdataRoot");
});

// ── Conventions in the installed containers ─────────────────────

test("detection counts conventions and suggests the most used values", () => {
  const found = detectConventions(BOXES, "Europe/Madrid");
  assert.equal(found.evidence.containers, 5);
  assert.deepEqual(found.evidence.variables.TZ, { "Europe/Madrid": 2, "Europe/Paris": 2 });
  assert.deepEqual(found.evidence.variables.PUID, { "99": 2 });
  assert.equal(found.evidence.variables.PATH, undefined, "only convention variables are counted");
  assert.deepEqual(found.evidence.appdataRoots, { "/mnt/user/appdata": 3, "/mnt/cache/appdata": 1 });
  assert.deepEqual(found.evidence.paths, { "/data": { "/mnt/user/downloads": 1 }, "/media": { "/mnt/user/Media": 2 }, "/photos": { "/mnt/user/Photos": 1 } });
  assert.deepEqual(found.evidence.networks, { bridge: 4, br0: 1 });
  assert.deepEqual(found.suggested, {
    variables: { TZ: "Europe/Madrid", PUID: "99", PGID: "100" },
    appdataRoot: "/mnt/user/appdata",
    paths: { "/media": "/mnt/user/Media" },
  }, "TZ follows Unraid's setting, and a path needs two containers");
  assert.equal(found.notices.length, 1);
  assert.match(found.notices[0], /Unraid is set to Europe\/Madrid/);
  assert.match(found.notices[0], /TZ=Europe\/Paris \(2: deluge, couch\)/);
});

test("without Unraid's timezone, TZ is suggested from the containers", () => {
  const found = detectConventions([BOXES[0], BOXES[2], BOXES[3]], null);
  assert.equal(found.suggested.variables?.TZ, "Europe/Paris");
  assert.match(found.notices[0], /Most containers use TZ=Europe\/Paris, but some differ: TZ=Europe\/Madrid \(1: jellyfin\)/);
  assert.deepEqual(detectConventions([null, 3, "x"], null).evidence.containers, 0);
});

// ── Routes ──────────────────────────────────────────────────────

test("reading the profile needs profile:read", async () => {
  await setPermissions({ "profile:update": true });
  const app = await harness(await tempFile());
  const res = await app.inject({ method: "GET", url: "/api/profile" });
  assert.equal(res.statusCode, 403);
});

test("reading an empty profile returns the suggestion and its evidence", async () => {
  await setPermissions(ALL);
  const calls: string[][] = [];
  const app = await harness(await tempFile(), { run: fakeRun(BOXES, calls) });
  const res = await app.inject({ method: "GET", url: "/api/profile" });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.deepEqual(data.profile, {});
  assert.equal(data.suggested.appdataRoot, "/mnt/user/appdata");
  assert.equal(data.evidence.serverTimeZone, "Europe/Madrid");
  assert.equal(data.notices.length, 1);
  assert.deepEqual(calls, [["docker", "ps", "-aq", "--no-trunc"], ["docker", "inspect", "id0", "id1", "id2", "id3", "id4"]]);
});

test("a docker failure still returns the profile, with a notice", async () => {
  await setPermissions(ALL);
  const file = await tempFile();
  await writeFile(file, JSON.stringify({ variables: { TZ: "Europe/Madrid" } }));
  const app = await harness(file, { run: (async () => { throw new Error("Cannot connect to the Docker daemon"); }) as unknown as ReturnType<typeof fakeRun> });
  const res = await app.inject({ method: "GET", url: "/api/profile" });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.deepEqual(data.profile, { variables: { TZ: "Europe/Madrid" } });
  assert.equal(data.evidence.containers, 0);
  assert.match(data.notices[0], /could not be read.*Docker daemon/);
});

test("changing the profile needs profile:update", async () => {
  await setPermissions({ "profile:read": true });
  const app = await harness(await tempFile());
  const res = await app.inject({ method: "POST", url: "/api/profile", payload: { notes: "x" } });
  assert.equal(res.statusCode, 403);
});

test("a dry run shows the new profile and saves nothing", async () => {
  await setPermissions(ALL);
  const file = await tempFile();
  const app = await harness(file);
  const res = await app.inject({ method: "POST", url: "/api/profile", payload: { variables: { TZ: "Europe/Madrid" }, dryRun: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().data, { dryRun: true, profile: { variables: { TZ: "Europe/Madrid" } }, changed: ["variables.TZ"] });
  await assert.rejects(readFile(file, "utf8"), /ENOENT/);
});

test("a change is saved, read back and merged with the next one", async () => {
  await setPermissions(ALL);
  const file = await tempFile();
  const app = await harness(file);
  const first = await app.inject({ method: "POST", url: "/api/profile", payload: { variables: { TZ: "Europe/Madrid", PUID: "99" }, paths: { "/media": "/mnt/user/Media" } } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.verified, true);
  assert.equal(first.json().data.profile.updatedAt, "2026-09-29T10:00:00.000Z");

  const second = await app.inject({ method: "POST", url: "/api/profile", payload: { variables: { PUID: null }, notes: "Expose web apps through Nginx Proxy Manager." } });
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json().data.changed.sort(), ["notes", "variables.PUID"]);

  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved, {
    variables: { TZ: "Europe/Madrid" },
    paths: { "/media": "/mnt/user/Media" },
    notes: "Expose web apps through Nginx Proxy Manager.",
    updatedAt: "2026-09-29T10:00:00.000Z",
  });

  const read = await app.inject({ method: "GET", url: "/api/profile" });
  assert.deepEqual(read.json().data.profile, saved);
});

test("a change that changes nothing leaves the file alone", async () => {
  await setPermissions(ALL);
  const file = await tempFile();
  const raw = `${JSON.stringify({ variables: { TZ: "Europe/Madrid" }, updatedAt: "2026-01-01T00:00:00.000Z" })}\n`;
  await writeFile(file, raw);
  const app = await harness(file);
  const res = await app.inject({ method: "POST", url: "/api/profile", payload: { variables: { TZ: "Europe/Madrid" } } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().data.changed, []);
  assert.equal(await readFile(file, "utf8"), raw);
});

test("changes made at the same time are both kept", async () => {
  await setPermissions(ALL);
  const file = await tempFile();
  const app = await harness(file);
  const results = await Promise.all([
    app.inject({ method: "POST", url: "/api/profile", payload: { variables: { TZ: "Europe/Madrid" } } }),
    app.inject({ method: "POST", url: "/api/profile", payload: { variables: { PUID: "99" } } }),
    app.inject({ method: "POST", url: "/api/profile", payload: { appdataRoot: "/mnt/user/appdata" } }),
  ]);
  for (const r of results) assert.equal(r.statusCode, 200, r.body);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.variables, { TZ: "Europe/Madrid", PUID: "99" });
  assert.equal(saved.appdataRoot, "/mnt/user/appdata");
});

test("an invalid change is refused with its reason and saves nothing", async () => {
  await setPermissions(ALL);
  const file = await tempFile();
  const app = await harness(file);
  const res = await app.inject({ method: "POST", url: "/api/profile", payload: { paths: { "/media": "/mnt/user/Media:/etc" } } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "PROFILE_INVALID_BODY");
  assert.equal(res.json().error.details.field, "paths./media");
  await assert.rejects(readFile(file, "utf8"), /ENOENT/);
});
