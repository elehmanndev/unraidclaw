// Calling the web API of an installed container.
//
// Most of what people change on a server happens inside an app rather than in
// its container: a model in a router, a proxy host, an album, a user. These
// routes let an agent do that through the app's own API. The target is always
// an installed container, found from docker inspect, so a caller names the app
// and never supplies a host: the request cannot be pointed anywhere else on the
// network. A key saved on the App Keys tab is added on the way out and redacted
// from everything that comes back.

import type { FastifyInstance, FastifyReply } from "fastify";
import { Resource, Action, isPermitted } from "@unraidclaw/shared";
import type { AppRequest, AppRequestMethod, AppRequestResponse, AppTarget } from "@unraidclaw/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import https from "node:https";
import { requirePermission } from "../permissions.js";
import { getPermissions } from "../config.js";
import { CA_NAME_RE } from "../ca-template.js";
import { redactSecrets } from "../ca-saved-template.js";
import { keyHeaderValue, keySecrets, readAppKeys, type AppKey } from "../app-keys.js";

const execFileAsync = promisify(execFile);

declare module "fastify" {
  interface FastifyRequest {
    /** Logged with the request: the method and path sent to the app. */
    activityDetail?: string;
  }
}

const DOCKER_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
/** Bodies larger than this are cut off: enough for any API answer an agent can read. */
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

const METHODS = new Set<AppRequestMethod>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set<AppRequestMethod>(["GET", "HEAD"]);
const BODY_FIELDS = ["method", "path", "query", "headers", "body", "port", "https", "timeoutMs", "dryRun"];

/** Headers the transport owns. A caller setting them would break or smuggle the request. */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer",
  "proxy-authorization", "proxy-connection",
]);
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** Response headers worth showing. Set-Cookie is left out: it is a session secret. */
const SHOWN_HEADERS = ["content-type", "content-length", "location", "etag", "last-modified", "retry-after", "www-authenticate"];

export interface AppsRuntime {
  run(file: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
  readKeys(): Promise<Map<string, AppKey>>;
}

export function createAppsRuntime(overrides: Partial<AppsRuntime> = {}): AppsRuntime {
  return {
    run:
      overrides.run ??
      ((file, args, timeoutMs = DOCKER_TIMEOUT_MS) => execFileAsync(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })),
    readKeys: overrides.readKeys ?? (() => readAppKeys()),
  };
}

class AppError extends Error {
  constructor(message: string, public code: string, public statusCode: number, public details?: Record<string, unknown>) {
    super(message);
  }
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  throw err;
}

function invalid(message: string): never {
  throw new AppError(message, "APP_INVALID_BODY", 400);
}

function hasControl(s: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(s);
}

/** Read a request body by hand, as the other mutating bodies are. */
export function parseAppRequest(raw: unknown): AppRequest & { method: AppRequestMethod } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid("The request body must be a JSON object.");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (BODY_FIELDS.includes(key)) continue;
    const near = BODY_FIELDS.find((f) => f.toLowerCase() === key.toLowerCase());
    invalid(near ? `Unknown field "${key}". Did you mean "${near}"?` : `Unknown field "${key}". Allowed: ${BODY_FIELDS.join(", ")}.`);
  }

  const method = (body.method ?? "GET") as AppRequestMethod;
  if (typeof method !== "string" || !METHODS.has(method)) invalid(`"method" must be one of ${[...METHODS].join(", ")}.`);

  if (typeof body.path !== "string" || !body.path.startsWith("/") || body.path.startsWith("//")) {
    invalid('"path" must be a path on the app starting with a single "/", such as "/api/server/version".');
  }
  if (body.path.length > 4096 || hasControl(body.path) || /[\s#]/.test(body.path)) {
    invalid('"path" must not contain spaces, "#" or control characters. Percent-encode them.');
  }

  const out: AppRequest & { method: AppRequestMethod } = { method, path: body.path };

  if (body.query !== undefined) {
    if (body.query === null || typeof body.query !== "object" || Array.isArray(body.query)) invalid('"query" must be an object.');
    for (const [k, v] of Object.entries(body.query as Record<string, unknown>)) {
      if (!["string", "number", "boolean"].includes(typeof v)) invalid(`"query.${k}" must be a string, number or boolean.`);
    }
    out.query = body.query as Record<string, string | number | boolean>;
  }

  if (body.headers !== undefined) {
    if (body.headers === null || typeof body.headers !== "object" || Array.isArray(body.headers)) invalid('"headers" must be an object.');
    const entries = Object.entries(body.headers as Record<string, unknown>);
    if (entries.length > 30) invalid('"headers" may have at most 30 entries.');
    for (const [k, v] of entries) {
      if (!HEADER_NAME_RE.test(k)) invalid(`"${k}" is not a valid header name.`);
      if (RESERVED_HEADERS.has(k.toLowerCase())) invalid(`The "${k}" header is set by the connection itself and cannot be sent.`);
      if (typeof v !== "string" || v.length > 8192 || hasControl(v)) invalid(`Header "${k}" must be a string without control characters.`);
    }
    out.headers = body.headers as Record<string, string>;
  }

  if (body.body !== undefined) {
    if (READ_METHODS.has(method)) invalid(`A ${method} request cannot have a body.`);
    out.body = body.body;
  }

  if (body.port !== undefined) {
    if (typeof body.port !== "number" || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) invalid('"port" must be a port number.');
    out.port = body.port;
  }
  if (body.https !== undefined) {
    if (typeof body.https !== "boolean") invalid('"https" must be true or false.');
    out.https = body.https;
  }
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== "number" || !Number.isInteger(body.timeoutMs) || body.timeoutMs < 1000 || body.timeoutMs > MAX_TIMEOUT_MS) {
      invalid(`"timeoutMs" must be between 1000 and ${MAX_TIMEOUT_MS}.`);
    }
    out.timeoutMs = body.timeoutMs;
  }
  if (body.dryRun !== undefined) {
    if (typeof body.dryRun !== "boolean") invalid(`"dryRun" must be true or false, not ${JSON.stringify(body.dryRun)}.`);
    out.dryRun = body.dryRun;
  }
  return out;
}

// ── Finding the app ─────────────────────────────────────────────

interface Resolved {
  name: string;
  running: boolean;
  /** Docker network mode: bridge, host, a custom network such as br0, container:... */
  network: string;
  /** Address the server can reach the container at, or null with the reason. */
  host: string | null;
  unreachable?: string;
  /** Container-side TCP ports it exposes. */
  ports: number[];
  /** Port and scheme from the Docker tab's WebUI link, when it has one. */
  webuiPort: number | null;
  webuiHttps: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function resolveContainer(inspect: any): Resolved {
  const name = String(inspect?.Name ?? "").replace(/^\//, "");
  const running = inspect?.State?.Running === true;
  const ports = Object.keys(inspect?.Config?.ExposedPorts ?? {})
    .filter((p) => p.endsWith("/tcp"))
    .map((p) => Number(p.split("/")[0]))
    .filter((p) => Number.isInteger(p) && p > 0)
    .sort((a, b) => a - b);

  const webui = String(inspect?.Config?.Labels?.["net.unraid.docker.webui"] ?? "");
  const m = /\[PORT:(\d{1,5})\]/.exec(webui);
  const webuiPort = m ? Number(m[1]) : null;
  const webuiHttps = /^https:/i.test(webui);

  const mode = String(inspect?.HostConfig?.NetworkMode ?? "");
  const networks: Record<string, any> = inspect?.NetworkSettings?.Networks ?? {};
  let host: string | null = null;
  let unreachable: string | undefined;
  if (mode === "host") {
    host = "127.0.0.1";
  } else if (mode.startsWith("container:")) {
    unreachable = "It shares the network of another container. Send the request to that container instead.";
  } else if (mode === "none") {
    unreachable = "It has no network.";
  } else {
    const ip = networks[mode]?.IPAddress || Object.values(networks).map((n) => n?.IPAddress).find((a) => a);
    if (ip) host = String(ip);
    else unreachable = "docker reports no IP address for it.";
  }
  return { name, running, network: mode, host, unreachable, ports, webuiPort, webuiHttps };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function choosePort(r: Resolved, requested?: number): number {
  if (requested !== undefined) return requested;
  if (r.webuiPort !== null) return r.webuiPort;
  if (r.ports.length === 1) return r.ports[0];
  throw new AppError(
    r.ports.length === 0
      ? `"${r.name}" exposes no TCP port and has no WebUI link, so pass "port".`
      : `"${r.name}" exposes several ports (${r.ports.join(", ")}) and has no WebUI link. Pass "port" to pick one.`,
    "APP_PORT_AMBIGUOUS",
    400,
    { ports: r.ports }
  );
}

// ── Sending ─────────────────────────────────────────────────────

interface Sent {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

function send(url: URL, method: string, headers: Record<string, string>, body: Buffer | null, timeoutMs: number): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method,
        headers: body ? { ...headers, "content-length": String(body.length) } : headers,
        timeout: timeoutMs,
        agent: false,
        // Apps on a home server almost all use self-signed certificates, and
        // the connection never leaves this machine or its docker networks.
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          if (size + chunk.length > MAX_RESPONSE_BYTES) {
            chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size));
            size = MAX_RESPONSE_BYTES;
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: res.headers, body: Buffer.concat(chunks), truncated });
        };
        res.on("end", finish);
        res.on("error", (err) => (truncated ? finish() : reject(err)));
      }
    );
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const TEXT_TYPE_RE = /^(text\/|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|javascript|x-www-form-urlencoded|yaml|x-yaml))/i;

export function registerAppRoutes(app: FastifyInstance, runtime: AppsRuntime = createAppsRuntime()): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  async function inspect(names: string[]): Promise<any[]> {
    try {
      const { stdout } = await runtime.run("docker", ["inspect", "--type", "container", ...names]);
      return JSON.parse(stdout);
    } catch (err) {
      const e = err as Error & { stderr?: string };
      if (/no such (container|object)/i.test(`${e.stderr ?? ""} ${e.message}`)) {
        throw new AppError(`No container named "${names[0]}" exists on this server. Call unraid_docker_list to find it.`, "APP_NOT_FOUND", 404);
      }
      throw new AppError(`docker could not be asked about the container: ${e.message}`, "APP_DOCKER_UNAVAILABLE", 503);
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Which apps can be called, where requests go, and which have a key saved.
  app.get("/api/apps", {
    preHandler: requirePermission(Resource.APPS, Action.READ),
    handler: async (_req, reply) => {
      try {
        const { stdout } = await runtime.run("docker", ["ps", "-a", "--format", "{{.Names}}"]);
        const names = stdout.split("\n").map((n) => n.trim()).filter((n) => CA_NAME_RE.test(n));
        const keys = await runtime.readKeys();
        const targets: AppTarget[] = [];
        for (const raw of names.length > 0 ? await inspect(names) : []) {
          const r = resolveContainer(raw);
          let baseUrl: string | null = null;
          if (r.host) {
            try {
              baseUrl = `${r.webuiHttps ? "https" : "http"}://${r.host}:${choosePort(r)}`;
            } catch {
              baseUrl = null;
            }
          }
          const key = keys.get(r.name);
          targets.push({ name: r.name, running: r.running, baseUrl, ports: r.ports, key: key ? { type: key.type, header: key.header } : null });
        }
        targets.sort((a, b) => a.name.localeCompare(b.name));
        return reply.send({ ok: true, data: { apps: targets } });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  });

  // Send one request to an installed app's own API.
  app.post<{ Params: { name: string } }>("/api/apps/:name/request", {
    preHandler: requirePermission(Resource.APPS, Action.READ),
    handler: async (req, reply) => {
      try {
        const name = req.params.name;
        if (!CA_NAME_RE.test(name)) throw new AppError(`${JSON.stringify(name)} is not a valid container name.`, "APP_INVALID_NAME", 400);
        const body = parseAppRequest(req.body);

        // apps:read lets a caller look; anything that can change the app
        // needs apps:update, dry run included, as with every other mutation.
        if (!READ_METHODS.has(body.method) && !isPermitted(getPermissions(), Resource.APPS, Action.UPDATE)) {
          return reply.code(403).send({ ok: false, error: { code: "FORBIDDEN", message: `Permission denied: ${Resource.APPS}:${Action.UPDATE}` } });
        }

        const [raw] = await inspect([name]);
        const target = resolveContainer(raw);
        if (target.name !== name) throw new AppError(`docker reports the container as "${target.name}", not "${name}".`, "APP_MISMATCH", 409);
        if (!target.running) throw new AppError(`"${name}" is not running, so its API cannot answer. Start it first.`, "APP_NOT_RUNNING", 409);
        if (!target.host) throw new AppError(`"${name}" cannot be reached from the server: ${target.unreachable}`, "APP_UNREACHABLE", 409);
        const port = choosePort(target, body.port);
        const scheme = (body.https ?? target.webuiHttps) ? "https" : "http";

        const url = new URL(`${scheme}://${target.host}:${port}${body.path}`);
        // Belt and braces: whatever the path held, the request goes to the container.
        if (url.hostname !== target.host && `[${url.hostname}]` !== target.host) {
          throw new AppError('"path" must not change the host.', "APP_INVALID_BODY", 400);
        }
        for (const [k, v] of Object.entries(body.query ?? {})) url.searchParams.append(k, String(v));

        const key = (await runtime.readKeys()).get(name) ?? null;
        const secrets = key ? keySecrets(key) : [];
        // The activity log shows what was done inside the app, not only that
        // an app was called. The key never travels in the path, but a query
        // string can carry other secrets, so it is redacted and kept short.
        req.activityDetail = `${body.dryRun ? "dry run " : ""}${body.method} ${redactSecrets(secrets, body.path).slice(0, 200)}`;
        const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.9, */*;q=0.5", ...(body.headers ?? {}) };
        if (key) {
          for (const h of Object.keys(headers)) {
            if (h.toLowerCase() === key.header.toLowerCase()) {
              throw new AppError(`"${h}" carries the key saved for "${name}" and cannot be set by the caller.`, "APP_INVALID_BODY", 400);
            }
          }
          headers[key.header] = keyHeaderValue(key);
        }

        let payload: Buffer | null = null;
        if (body.body !== undefined) {
          const isString = typeof body.body === "string";
          payload = Buffer.from(isString ? (body.body as string) : JSON.stringify(body.body), "utf8");
          if (payload.length > MAX_BODY_BYTES) throw new AppError(`The body is ${payload.length} bytes, over the ${MAX_BODY_BYTES} byte limit.`, "APP_INVALID_BODY", 400);
          if (!isString && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
        }

        const shownHeaders = Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k, key && k === key.header ? "***" : redactSecrets(secrets, v)])
        );
        const base: AppRequestResponse = {
          dryRun: body.dryRun === true,
          name,
          method: body.method,
          url: redactSecrets(secrets, url.toString()),
          key: key ? { type: key.type, header: key.header } : null,
          requestHeaders: shownHeaders,
        };
        if (body.dryRun) {
          const preview = payload ? redactSecrets(secrets, payload.toString("utf8").slice(0, 2048)) : undefined;
          return reply.send({ ok: true, data: { ...base, ...(preview !== undefined ? { text: preview } : {}) } });
        }

        const started = Date.now();
        let sent: Sent;
        try {
          sent = await send(url, body.method, headers, payload, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        } catch (err) {
          const why = redactSecrets(secrets, (err as Error).message);
          // Unraid blocks the host from talking to containers on a macvlan or
          // ipvlan network such as br0 unless the Docker settings allow it,
          // which looks exactly like a dead app from here.
          const customNetwork = !["bridge", "host", "default"].includes(target.network);
          const hint = customNetwork && /EHOSTUNREACH|ETIMEDOUT|no answer/.test(why)
            ? ` "${name}" is on the ${target.network} network: if that is br0 or another macvlan network, the server can only reach it with Host access to custom networks enabled in Settings, Docker.`
            : "";
          throw new AppError(`Could not reach "${name}" at ${base.url}: ${why}.${hint}`, "APP_UNREACHABLE", 502);
        }

        const headersOut: Record<string, string> = {};
        for (const h of SHOWN_HEADERS) {
          const v = sent.headers[h];
          if (v !== undefined) headersOut[h] = redactSecrets(secrets, Array.isArray(v) ? v.join(", ") : String(v));
        }
        const contentType = String(sent.headers["content-type"] ?? "");
        const response: AppRequestResponse = {
          ...base,
          status: sent.status,
          statusText: sent.statusText,
          headers: headersOut,
          durationMs: Date.now() - started,
          ...(sent.truncated ? { truncated: true } : {}),
        };
        if (sent.body.length > 0) {
          if (contentType === "" || TEXT_TYPE_RE.test(contentType)) {
            const text = redactSecrets(secrets, sent.body.toString("utf8"));
            let parsed: unknown;
            let isJson = false;
            if (/json/i.test(contentType) && !sent.truncated) {
              try {
                parsed = JSON.parse(text);
                isJson = true;
              } catch {
                isJson = false;
              }
            }
            if (isJson) response.json = parsed;
            else response.text = text;
          } else {
            response.binaryBytes = sent.body.length;
          }
        }
        return reply.send({ ok: true, data: response });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  });
}
