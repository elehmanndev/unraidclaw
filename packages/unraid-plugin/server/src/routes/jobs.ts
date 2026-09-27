// Background jobs: run one of UnraidClaw's own long operations without
// holding the caller's request open, and send an Unraid notification when it
// finishes.
//
// A job is a tool call, run later. It goes through the same tool definition
// and the same /api/ route an MCP or CLI call would, injected in process with
// the submitter's API key, so the route's own permission check, validation,
// dry-run rules and activity logging apply exactly as they would to a direct
// call. Only tools that can take minutes are accepted: image pulls, installs,
// rebuilds and redeploys. Anything else is quick enough to call directly.
//
// Jobs live in memory. A service restart forgets them, and the key a queued job
// holds is never written anywhere.

import type { FastifyInstance, FastifyRequest } from "fastify";
import Ajv from "ajv";
import { randomUUID } from "node:crypto";
import { Resource, Action } from "@unraidclaw/shared";
import type { ApiResponse, JobDetail, JobStartRequest, JobStatus, JobSummary } from "@unraidclaw/shared";
import { registerTools, isErrorResult, type ToolClient, type ToolDefinition } from "unraidclaw/tools";
import { requirePermission } from "../permissions.js";

/** Tools a job may run: the ones that pull images, install, rebuild or redeploy. */
export const JOB_TOOLS: readonly string[] = [
  "unraid_ca_install",
  "unraid_ca_update",
  "unraid_template_edit",
  "unraid_compose_action",
  "unraid_compose_edit",
  "unraid_plugin_install",
  "unraid_plugin_update",
];

/** Arguments that name what a job acts on, in the order they are looked for. */
const TARGET_KEYS = ["containerName", "name", "project", "file", "url"];

export interface JobsRuntime {
  /** Jobs running at once. The rest wait their turn. */
  maxRunning: number;
  /** Finished jobs kept for reading back. */
  keep: number;
  now(): Date;
  id(): string;
}

export function createJobsRuntime(overrides: Partial<JobsRuntime> = {}): JobsRuntime {
  return {
    maxRunning: overrides.maxRunning ?? 2,
    keep: overrides.keep ?? 50,
    now: overrides.now ?? (() => new Date()),
    id: overrides.id ?? (() => randomUUID()),
  };
}

interface Job extends JobDetail {
  /** Only while queued or running: the key the tool's requests authenticate with. */
  key?: string;
  ip: string;
  args: Record<string, unknown>;
  notify: boolean;
}

function collectTools(client: ToolClient): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  registerTools({ registerTool: (tool) => { tools.set(tool.name, tool); } }, () => client);
  return tools;
}

function summary(job: Job): JobSummary {
  const { id, tool, target, status, createdAt, startedAt, finishedAt, durationMs, notification } = job;
  return { id, tool, target, status, createdAt, startedAt, finishedAt, durationMs, notification };
}

function detail(job: Job): JobDetail {
  return { ...summary(job), ...(job.result !== undefined ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) };
}

/** The text a tool returned, as JSON when it is JSON. */
function parseResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function registerJobRoutes(app: FastifyInstance, runtime: JobsRuntime = createJobsRuntime()): void {
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let running = 0;

  // The schemas, compiled once, from the same definitions MCP exposes.
  const unavailable = async (): Promise<never> => { throw new Error("No request context"); };
  const definitions = collectTools({ get: unavailable, post: unavailable, patch: unavailable, delete: unavailable });
  const ajv = new Ajv({ coerceTypes: false, useDefaults: false, removeAdditional: false });
  const validators = new Map(
    JOB_TOOLS.filter((name) => definitions.has(name)).map((name) => {
      const params = definitions.get(name)!.parameters;
      const { server: _server, ...properties } = params.properties ?? {};
      return [name, ajv.compile({ ...params, properties, required: params.required?.filter((k) => k !== "server") ?? [], additionalProperties: false })];
    })
  );

  /** A tool client for one job: requests go to this gateway's own routes, as the submitter. */
  function jobClient(job: Job): ToolClient {
    async function send<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
      if (!path.startsWith("/api/") || path.startsWith("/api/jobs")) throw new Error("Invalid internal API path");
      const response = await app.inject({
        method,
        url: path,
        remoteAddress: job.ip,
        headers: { "x-api-key": job.key ?? "", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
      const result = response.json<ApiResponse<T>>();
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      return result.data;
    }
    return {
      get: (path, query) => send("GET", query ? `${path}?${new URLSearchParams(query)}` : path),
      post: (path, body) => send("POST", path, body),
      patch: (path, body) => send("PATCH", path, body),
      delete: (path) => send("DELETE", path),
    };
  }

  async function notify(job: Job): Promise<void> {
    if (!job.notify) {
      job.notification = "off";
      return;
    }
    const ok = job.status === "succeeded";
    const what = `${job.tool.replace(/^unraid_/, "").replace(/_/g, " ")}${job.target ? ` of ${job.target}` : ""}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/notifications",
      remoteAddress: job.ip,
      headers: { "x-api-key": job.key ?? "", "content-type": "application/json" },
      payload: JSON.stringify({
        title: "UnraidClaw",
        subject: `${ok ? "Finished" : "Failed"}: ${what}`.slice(0, 256),
        description: (ok
          ? `The background job ${job.id} finished in ${Math.round((job.durationMs ?? 0) / 1000)} s.`
          : `The background job ${job.id} failed: ${job.error ?? "unknown error"}`).slice(0, 4096),
        importance: ok ? "normal" : "warning",
      }),
    });
    job.notification = response.statusCode === 200 ? "sent" : response.statusCode === 403 ? "not permitted" : "failed";
  }

  async function run(job: Job): Promise<void> {
    job.status = "running";
    job.startedAt = runtime.now().toISOString();
    try {
      const tool = collectTools(jobClient(job)).get(job.tool)!;
      const result = await tool.execute(job.id, job.args);
      const text = result.content?.[0]?.text ?? "";
      if (isErrorResult(result)) {
        job.status = "failed";
        job.error = text.replace(/^Error:\s*/, "").slice(0, 4096);
      } else {
        job.status = "succeeded";
        job.result = parseResult(text);
      }
    } catch (err) {
      job.status = "failed";
      job.error = String((err as Error)?.message ?? err).slice(0, 4096);
    }
    job.finishedAt = runtime.now().toISOString();
    job.durationMs = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
    try {
      await notify(job);
    } catch {
      job.notification = "failed";
    }
    // The key is only needed while the job runs.
    delete job.key;
  }

  function pump(): void {
    while (running < runtime.maxRunning && queue.length > 0) {
      const job = queue.shift()!;
      running++;
      void run(job).finally(() => {
        running--;
        prune();
        pump();
      });
    }
  }

  /** Forget the oldest finished jobs beyond the ones kept. */
  function prune(): void {
    const finished = [...jobs.values()].filter((j) => j.status === "succeeded" || j.status === "failed");
    for (const old of finished.slice(0, Math.max(0, finished.length - runtime.keep))) jobs.delete(old.id);
  }

  app.post<{ Body: JobStartRequest }>("/api/jobs", {
    preHandler: requirePermission(Resource.JOBS, Action.CREATE),
    handler: async (req: FastifyRequest<{ Body: JobStartRequest }>, reply) => {
      const bad = (message: string) => reply.status(400).send({ ok: false, error: { code: "JOB_INVALID_BODY", message } });
      const body = req.body as unknown;
      if (body === null || typeof body !== "object" || Array.isArray(body)) return bad("The request body must be a JSON object.");
      const b = body as Record<string, unknown>;
      for (const key of Object.keys(b)) {
        if (!["tool", "arguments", "notify"].includes(key)) return bad(`Unknown field "${key}". Allowed: tool, arguments, notify.`);
      }
      if (typeof b.tool !== "string" || !validators.has(b.tool)) {
        return bad(`"tool" must be one of ${JOB_TOOLS.join(", ")}. Other tools are quick enough to call directly.`);
      }
      const args = b.arguments ?? {};
      if (args === null || typeof args !== "object" || Array.isArray(args)) return bad('"arguments" must be an object.');
      if (b.notify !== undefined && typeof b.notify !== "boolean") return bad('"notify" must be true or false.');
      // Checked now, so a mistyped argument is an error to the caller rather
      // than a job that fails later. Values are not echoed: they can be secret.
      if (!validators.get(b.tool)!(args)) return bad(`The arguments do not match ${b.tool}'s input schema. Nothing was queued.`);
      const key = req.headers["x-api-key"];
      if (typeof key !== "string" || key === "") {
        return reply.status(401).send({ ok: false, error: { code: "UNAUTHORIZED", message: "A job needs the caller's API key to run." } });
      }

      const a = args as Record<string, unknown>;
      const target = TARGET_KEYS.map((k) => a[k]).find((v) => typeof v === "string" && v !== "") as string | undefined;
      const job: Job = {
        id: runtime.id(),
        tool: b.tool,
        target: target ?? "",
        status: "queued" as JobStatus,
        createdAt: runtime.now().toISOString(),
        notification: "pending",
        key,
        ip: req.ip,
        args: a,
        notify: b.notify !== false,
      };
      jobs.set(job.id, job);
      queue.push(job);
      pump();
      return reply.status(202).send({ ok: true, data: summary(job) });
    },
  });

  app.get("/api/jobs", {
    preHandler: requirePermission(Resource.JOBS, Action.READ),
    handler: async (_req, reply) => {
      const list = [...jobs.values()].map(summary).reverse();
      return reply.send({ ok: true, data: { jobs: list, running, queued: queue.length } });
    },
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", {
    preHandler: requirePermission(Resource.JOBS, Action.READ),
    handler: async (req, reply) => {
      const job = jobs.get(req.params.id);
      if (!job) return reply.status(404).send({ ok: false, error: { code: "JOB_NOT_FOUND", message: `No job ${req.params.id}. Finished jobs are kept for the last ${runtime.keep}, and a service restart forgets them.` } });
      return reply.send({ ok: true, data: detail(job) });
    },
  });
}
