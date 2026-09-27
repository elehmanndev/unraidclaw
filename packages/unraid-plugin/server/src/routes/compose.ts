// Docker Compose stacks: list, view, edit, and start, stop, restart, pull or
// redeploy them.
//
// Unraid ships no Compose, so Compose runs from a throwaway docker:cli
// container per operation, with the stack's directory mounted at the same path
// it has on the host. Relative paths in the compose file then resolve exactly
// as they did when the stack was deployed.
//
// A stack whose directory is a git checkout is deployed from its repository,
// usually by a webhook. Editing its files here would be overwritten by, or
// break, the next deploy, so such stacks can only be started, stopped and
// restarted. Their changes belong in the repository.

import type { FastifyInstance, FastifyReply } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type {
  ComposeAction,
  ComposeActionResponse,
  ComposeEditResponse,
  ComposeFileView,
  ComposeService,
  ComposeStack,
  ComposeStackDetail,
} from "@unraidclaw/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { requirePermission } from "../permissions.js";
import { CaInstallError } from "../ca-template.js";
import { groupStacks, redactCompose, restoreHidden, unifiedDiff, type StackGroup } from "../compose.js";

const execFileAsync = promisify(execFile);
const FLASH_BASE = process.env.FLASH_BASE ?? "/boot/config/plugins/unraidclaw";

/** Pinned so Compose behaves the same on every run. Matches Unraid 7.3's docker. */
export const COMPOSE_IMAGE = "docker:29.5.2-cli";

const DOCKER_TIMEOUT_MS = 60_000;
const CONFIG_TIMEOUT_MS = 2 * 60_000;
const DEPLOY_TIMEOUT_MS = 15 * 60_000;
const STOP_TIMEOUT_MS = 5 * 60_000;
const SETTLE_MS = 5_000;
const MAX_FILE_BYTES = 256 * 1024;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const ACTIONS = new Set<ComposeAction>(["start", "stop", "restart", "pull", "up"]);

export interface ComposeRuntime {
  run(file: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
  pathExists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  /** Replace a file through a rename in its own directory, so a failed write leaves the old one. */
  writeFile(path: string, content: string): Promise<void>;
  /** Write content where the Compose container can mount it. Returns its path. */
  stage(content: string): Promise<string>;
  discard(path: string): Promise<void>;
  backup(path: string, project: string, when: Date): Promise<string>;
  wait(ms: number): Promise<void>;
  settleMs: number;
  now(): Date;
  image: string;
}

export function createComposeRuntime(overrides: Partial<ComposeRuntime> = {}): ComposeRuntime {
  const backupDir = join(FLASH_BASE, "compose-backups");
  return {
    run:
      overrides.run ??
      ((file, args, timeoutMs = DOCKER_TIMEOUT_MS) => execFileAsync(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })),
    pathExists:
      overrides.pathExists ??
      (async (path) => {
        try {
          await stat(path);
          return true;
        } catch {
          return false;
        }
      }),
    readFile: overrides.readFile ?? ((path) => readFile(path, "utf8")),
    writeFile:
      overrides.writeFile ??
      (async (path, content) => {
        const staging = join(dirname(path), `.${basename(path)}.unraidclaw-tmp`);
        await writeFile(staging, content, "utf8");
        await rename(staging, path);
      }),
    stage:
      overrides.stage ??
      (async (content) => {
        const dir = await mkdtemp(join(tmpdir(), "unraidclaw-compose-"));
        const path = join(dir, "compose.yml");
        await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
        return path;
      }),
    discard: overrides.discard ?? (async (path) => rm(dirname(path), { recursive: true, force: true })),
    backup:
      overrides.backup ??
      (async (path, project, when) => {
        const dir = join(backupDir, project);
        await mkdir(dir, { recursive: true });
        const target = join(dir, `${basename(path)}.${when.toISOString().replace(/[:.]/g, "-")}`);
        await copyFile(path, target);
        return target;
      }),
    wait: overrides.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    settleMs: overrides.settleMs ?? SETTLE_MS,
    now: overrides.now ?? (() => new Date()),
    image: overrides.image ?? COMPOSE_IMAGE,
  };
}

interface Stack extends ComposeStack {
  group: StackGroup;
}

function fail(message: string, code: string, statusCode: number, details?: Record<string, unknown>): never {
  throw new CaInstallError(message, code, statusCode, details);
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof CaInstallError) {
    return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  throw err;
}

function checkFields(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    const near = allowed.find((a) => a.toLowerCase() === key.toLowerCase());
    fail(near ? `Unknown field "${key}". Did you mean "${near}"?` : `Unknown field "${key}". Allowed: ${allowed.join(", ")}.`, "COMPOSE_INVALID_BODY", 400);
  }
}

function objectBody(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("The request body must be a JSON object.", "COMPOSE_INVALID_BODY", 400);
  return raw as Record<string, unknown>;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  if (body[key] === undefined) return undefined;
  if (typeof body[key] !== "boolean") fail(`"${key}" must be true or false, not ${JSON.stringify(body[key])}.`, "COMPOSE_INVALID_BODY", 400);
  return body[key] as boolean;
}

/** `KEY=value` lines of a .env file, with surrounding quotes removed. */
function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out.set(m[1], m[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  return out;
}

/** A git remote without its credentials: host and path only. */
function cleanRemote(url: string): string {
  const u = url.trim();
  const ssh = /^[^@\s]+@([^:\s]+):(.+)$/.exec(u);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const parsed = new URL(u);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "";
  }
}

export function registerComposeRoutes(app: FastifyInstance, runtime: ComposeRuntime = createComposeRuntime()): void {
  const inFlight = new Set<string>();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  async function inspectAll(): Promise<any[]> {
    try {
      const { stdout } = await runtime.run("docker", ["ps", "-a", "--filter", "label=com.docker.compose.project", "--format", "{{.ID}}"]);
      const ids = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return [];
      return JSON.parse((await runtime.run("docker", ["inspect", ...ids])).stdout);
    } catch (err) {
      fail(`docker could not list the compose stacks: ${(err as Error).message}`, "COMPOSE_DOCKER_UNAVAILABLE", 503);
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /**
   * Work out where each stack lives on the host.
   *
   * A stack deployed from inside another container (a webhook with the Docker
   * socket) records paths as that container saw them. Any working directory
   * that exists here wins, and each compose file is looked for at the same
   * place relative to it.
   */
  async function resolveStack(group: StackGroup): Promise<Stack> {
    let workingDir: string | null = null;
    for (const wd of group.workingDirs) {
      if (await runtime.pathExists(wd)) {
        workingDir = wd;
        break;
      }
    }
    const files: string[] = [];
    if (workingDir) {
      for (const f of group.configFiles) {
        const owner = group.workingDirs.find((wd) => f.startsWith(`${wd}/`)) ?? dirname(f);
        const candidate = join(workingDir, relative(owner, f));
        if (candidate.startsWith(`${workingDir}/`) && !files.includes(candidate) && (await runtime.pathExists(candidate))) files.push(candidate);
      }
    }
    const managedBy: Stack["managedBy"] =
      !workingDir || files.length === 0 ? "unmanaged" : (await runtime.pathExists(join(workingDir, ".git"))) ? "git" : "local";
    const services: ComposeService[] = group.containers
      .map((c) => ({ service: c.service, container: c.name, state: c.state, status: c.status, image: c.image }))
      .sort((a, b) => a.service.localeCompare(b.service));
    return { project: group.project, managedBy, workingDir, files, services, group };
  }

  async function loadStacks(): Promise<Stack[]> {
    return Promise.all(groupStacks(await inspectAll()).map(resolveStack));
  }

  async function loadStack(project: string): Promise<Stack> {
    if (!PROJECT_RE.test(project)) fail(`${JSON.stringify(project)} is not a Compose project name.`, "COMPOSE_INVALID_NAME", 400);
    const stack = (await loadStacks()).find((s) => s.project === project);
    if (!stack) fail(`No compose stack named "${project}" has containers on this server.`, "COMPOSE_NOT_FOUND", 404);
    return stack;
  }

  async function envValues(stack: Stack): Promise<Map<string, string>> {
    if (!stack.workingDir) return new Map();
    const path = join(stack.workingDir, ".env");
    if (!(await runtime.pathExists(path))) return new Map();
    try {
      return parseEnvFile(await runtime.readFile(path));
    } catch {
      return new Map();
    }
  }

  /** `docker compose ...` for a stack, from the pinned image, as the host sees its files. */
  function composeArgs(stack: Stack, cmd: string[], mounts: string[] = [], globalFlags: string[] = []): string[] {
    const wd = stack.workingDir as string;
    return [
      "run", "--rm", "--pull", "missing",
      "--label", `net.unraidclaw.compose=${stack.project}`,
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${wd}:${wd}`,
      ...mounts.flatMap((m) => ["-v", m]),
      "-w", wd,
      runtime.image,
      "docker", "compose", ...globalFlags, "-p", stack.project,
      ...stack.files.flatMap((f) => ["-f", f]),
      ...cmd,
    ];
  }

  async function compose(stack: Stack, cmd: string[], secrets: string[], timeoutMs: number, mounts: string[] = [], globalFlags: string[] = []) {
    try {
      const { stdout, stderr } = await runtime.run("docker", composeArgs(stack, cmd, mounts, globalFlags), timeoutMs);
      return { ok: true as const, output: redact(`${stdout}${stderr}`, secrets) };
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      return { ok: false as const, output: redact(`${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message, secrets) };
    }
  }

  function redact(text: string, secrets: string[]): string {
    let out = text;
    for (const s of secrets) out = out.split(s).join("***");
    return out.trim();
  }

  function secretsOf(env: Map<string, string>): string[] {
    return [...env.values()].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  }

  function claim(project: string): void {
    if (inFlight.has(project)) fail(`Another change to "${project}" is already running. Wait for it to finish.`, "COMPOSE_IN_FLIGHT", 409);
    inFlight.add(project);
  }

  function publicStack(s: Stack): ComposeStack {
    const { group: _group, ...rest } = s;
    return rest;
  }

  // List every stack that has containers, with its services and state.
  app.get("/api/compose", {
    preHandler: requirePermission(Resource.COMPOSE, Action.READ),
    handler: async (_req, reply) => {
      try {
        return reply.send({ ok: true, data: { stacks: (await loadStacks()).map(publicStack) } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  });

  // One stack, with its compose files and secrets hidden.
  app.get<{ Params: { project: string } }>("/api/compose/:project", {
    preHandler: requirePermission(Resource.COMPOSE, Action.READ),
    handler: async (req, reply) => {
      try {
        const stack = await loadStack(req.params.project);
        const env = await envValues(stack);
        const values = [...env.values()];
        const composeFiles: ComposeFileView[] = [];
        for (const path of stack.files) {
          composeFiles.push({ name: basename(path), path, content: redactCompose(await runtime.readFile(path), values) });
        }
        const detail: ComposeStackDetail = { ...publicStack(stack), composeFiles, envKeys: [...env.keys()] };
        if (stack.managedBy === "git" && stack.workingDir) {
          try {
            const { stdout } = await runtime.run("git", ["-C", stack.workingDir, "config", "--get", "remote.origin.url"]);
            const remote = cleanRemote(stdout);
            if (remote) detail.gitRemote = remote;
          } catch {
            // No origin: still a git stack, just nothing to point at.
          }
        }
        return reply.send({ ok: true, data: detail });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  });

  // Start, stop, restart, pull or redeploy a stack's services.
  app.post<{ Params: { project: string } }>("/api/compose/:project/action", {
    preHandler: requirePermission(Resource.COMPOSE, Action.UPDATE),
    handler: async (req, reply) => {
      try {
        const body = objectBody(req.body ?? {});
        checkFields(body, ["action", "services", "dryRun"]);
        const action = body.action as ComposeAction;
        if (typeof action !== "string" || !ACTIONS.has(action)) fail(`"action" must be one of ${[...ACTIONS].join(", ")}.`, "COMPOSE_INVALID_BODY", 400);
        const dryRun = optionalBoolean(body, "dryRun") === true;
        let wanted: string[] | undefined;
        if (body.services !== undefined) {
          if (!Array.isArray(body.services) || body.services.some((s) => typeof s !== "string" || !SERVICE_RE.test(s))) {
            fail('"services" must be a list of service names.', "COMPOSE_INVALID_BODY", 400);
          }
          wanted = body.services as string[];
        }

        const stack = await loadStack(req.params.project);
        const known = new Set(stack.group.containers.map((c) => c.service));
        for (const s of wanted ?? []) if (!known.has(s)) fail(`"${req.params.project}" has no service "${s}". It has: ${[...known].join(", ")}.`, "COMPOSE_UNKNOWN_SERVICE", 400);
        const targets = stack.group.containers.filter((c) => !wanted || wanted.includes(c.service));

        if ((action === "pull" || action === "up") && stack.managedBy !== "local") {
          fail(
            stack.managedBy === "git"
              ? `"${stack.project}" is deployed from its git repository, so pulling and redeploying belong to that deploy. Push the change to the repository, or use start, stop or restart here.`
              : `"${stack.project}" has no compose files on this server, so it can only be started, stopped or restarted.`,
            stack.managedBy === "git" ? "COMPOSE_GIT_MANAGED" : "COMPOSE_UNMANAGED",
            409
          );
        }

        const secrets = secretsOf(await envValues(stack));
        const response: ComposeActionResponse = {
          dryRun,
          project: stack.project,
          action,
          containers: targets.map((c) => c.name),
          services: stack.services,
          warnings: [],
        };

        if (dryRun) {
          if (action === "up") {
            const plan = await compose(stack, ["up", "-d", ...(wanted ?? [])], secrets, CONFIG_TIMEOUT_MS, [], ["--dry-run"]);
            response.output = plan.output;
          }
          return reply.send({ ok: true, data: response });
        }

        claim(stack.project);
        try {
          if (action === "start" || action === "stop" || action === "restart") {
            // Plain docker, not compose: this needs no compose file, and it
            // cannot recreate anything, whichever way the stack is deployed.
            try {
              await runtime.run("docker", [action, ...targets.map((c) => c.id)], action === "start" ? DOCKER_TIMEOUT_MS : STOP_TIMEOUT_MS);
            } catch (err) {
              fail(`docker ${action} failed: ${redact((err as Error).message, secrets)}`, "COMPOSE_ACTION_FAILED", 500);
            }
          } else {
            const result = await compose(stack, action === "pull" ? ["pull", ...(wanted ?? [])] : ["up", "-d", ...(wanted ?? [])], secrets, DEPLOY_TIMEOUT_MS);
            response.output = result.output;
            if (!result.ok) fail(`docker compose ${action} failed: ${result.output}`, "COMPOSE_ACTION_FAILED", 500, { output: result.output });
          }
          if (action !== "pull") await runtime.wait(runtime.settleMs);

          const after = await loadStack(stack.project);
          response.services = after.services;
          const byName = new Map(after.group.containers.map((c) => [c.service, c]));
          for (const t of targets) {
            const now = byName.get(t.service);
            const shouldRun = action !== "stop" && action !== "pull";
            if (action === "pull") continue;
            if (!now) response.warnings.push(`${t.service} has no container after the ${action}.`);
            else if (shouldRun && !now.running) response.warnings.push(`${t.service} is ${now.state} after the ${action}. Check its logs.`);
            else if (!shouldRun && now.running) response.warnings.push(`${t.service} is still running after the stop.`);
          }
          return reply.send({ ok: true, data: response });
        } finally {
          inFlight.delete(stack.project);
        }
      } catch (err) {
        return sendError(reply, err);
      }
    },
  });

  // Replace a local stack's compose file, check it, and redeploy.
  app.post<{ Params: { project: string } }>("/api/compose/:project/edit", {
    preHandler: requirePermission(Resource.COMPOSE, Action.UPDATE),
    handler: async (req, reply) => {
      let staged: string | null = null;
      let claimed: string | null = null;
      try {
        const body = objectBody(req.body ?? {});
        checkFields(body, ["file", "content", "redeploy", "dryRun"]);
        if (typeof body.content !== "string") fail('"content" must be the whole new file, as a string.', "COMPOSE_INVALID_BODY", 400);
        const content = body.content as string;
        if (Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes("\0")) fail(`"content" must be text of at most ${MAX_FILE_BYTES} bytes.`, "COMPOSE_INVALID_BODY", 400);
        if (body.file !== undefined && typeof body.file !== "string") fail('"file" must be a file name.', "COMPOSE_INVALID_BODY", 400);
        const dryRun = optionalBoolean(body, "dryRun") === true;
        const redeploy = optionalBoolean(body, "redeploy") ?? true;

        const stack = await loadStack(req.params.project);
        if (stack.managedBy === "git") {
          fail(`"${stack.project}" is deployed from its git repository at ${stack.workingDir}. Change it there and let its deploy pick it up; an edit here would be overwritten or break the next deploy.`, "COMPOSE_GIT_MANAGED", 409);
        }
        if (stack.managedBy === "unmanaged") fail(`"${stack.project}" has no compose files on this server to edit.`, "COMPOSE_UNMANAGED", 409);

        const path = body.file === undefined ? stack.files[0] : stack.files.find((f) => basename(f) === body.file);
        if (!path) fail(`"${stack.project}" has no compose file named "${body.file}". It has: ${stack.files.map((f) => basename(f)).join(", ")}.`, "COMPOSE_FILE_NOT_FOUND", 404);

        const current = await runtime.readFile(path);
        const env = await envValues(stack);
        const values = [...env.values()];
        const secrets = secretsOf(env);
        const next = restoreHidden(content, current);

        const response: ComposeEditResponse = {
          dryRun,
          project: stack.project,
          file: basename(path),
          diff: unifiedDiff(redactCompose(current, values), redactCompose(next, values), basename(path)),
          plannedActions: [],
          redeployed: false,
          warnings: [],
        };
        if (next === current) {
          response.warnings.push("The file already has this content, so nothing was changed.");
          return reply.send({ ok: true, data: response });
        }

        // The candidate is checked in place of the real file, mounted over it,
        // so relative paths and the .env file resolve exactly as they will.
        staged = await runtime.stage(next);
        const overlay = [`${staged}:${path}:ro`];
        const check = await compose(stack, ["config", "--quiet"], secrets, CONFIG_TIMEOUT_MS, overlay);
        if (!check.ok) fail(`Compose rejects the new file: ${check.output}`, "COMPOSE_INVALID", 422, { output: check.output });
        const plan = await compose(stack, ["up", "-d"], secrets, CONFIG_TIMEOUT_MS, overlay, ["--dry-run"]);
        response.plannedActions = plan.output.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 60);

        if (dryRun) return reply.send({ ok: true, data: response });

        claim(stack.project);
        claimed = stack.project;
        const wasRunning = new Set(stack.group.containers.filter((c) => c.running).map((c) => c.service));
        response.backupPath = await runtime.backup(path, stack.project, runtime.now());
        await runtime.writeFile(path, next);
        if (!redeploy) {
          response.warnings.push("Saved without redeploying: the stack runs as before until its next up.");
          return reply.send({ ok: true, data: response });
        }

        const up = await compose(stack, ["up", "-d"], secrets, DEPLOY_TIMEOUT_MS);
        await runtime.wait(runtime.settleMs);
        const after = await loadStack(stack.project);
        const byService = new Map(after.group.containers.map((c) => [c.service, c]));
        const down = [...wasRunning].filter((s) => !byService.get(s)?.running);
        if (up.ok && down.length === 0) {
          response.redeployed = true;
          response.services = after.services;
          return reply.send({ ok: true, data: response });
        }

        // Put the old file back and deploy it again, so the stack is left as
        // it was running before the edit.
        const logs: Record<string, string> = {};
        for (const s of down.slice(0, 5)) {
          const l = await compose(stack, ["logs", "--no-color", "--tail", "40", s], secrets, CONFIG_TIMEOUT_MS);
          logs[s] = l.output;
        }
        const problems: string[] = [];
        try {
          await runtime.writeFile(path, current);
        } catch (err) {
          problems.push(`the previous file could not be written back (${(err as Error).message}); it is saved at ${response.backupPath}`);
        }
        const back = await compose(stack, ["up", "-d"], secrets, DEPLOY_TIMEOUT_MS);
        if (!back.ok) problems.push(`redeploying the previous file failed: ${back.output}`);
        const why = up.ok ? `${down.join(", ")} did not stay up` : `docker compose up failed: ${up.output}`;
        fail(
          problems.length === 0
            ? `The edited stack did not come up (${why}). The previous file was put back and redeployed. Service logs are in the error details.`
            : `The edited stack did not come up (${why}), and putting it back did not fully work: ${problems.join("; ")}.`,
          problems.length === 0 ? "COMPOSE_REDEPLOY_FAILED" : "COMPOSE_ROLLBACK_INCOMPLETE",
          500,
          { logs, output: up.output, backupPath: response.backupPath }
        );
      } catch (err) {
        return sendError(reply, err);
      } finally {
        if (staged) await runtime.discard(staged).catch(() => undefined);
        if (claimed) inFlight.delete(claimed);
      }
    },
  });
}
