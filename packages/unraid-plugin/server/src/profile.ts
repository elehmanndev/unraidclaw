// The owner's setup profile: the values a new app install fills in.
//
// It lives on flash as profile.json next to the other UnraidClaw settings, and
// only POST /api/profile writes it. An install reads it and fills a template
// field from it when the caller left that field unset, and lists each field it
// filled in the plan, so a dry run shows exactly what the profile changed.
// The notes are for an agent to read; nothing applies them.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CaConfigEntry,
  ProfileApplied,
  SetupProfile,
  SetupProfileEvidence,
  SetupProfileUpdate,
  SetupProfileView,
  ValueCounts,
} from "@unraidclaw/shared";

const FLASH_BASE = process.env.FLASH_BASE ?? "/boot/config/plugins/unraidclaw";
export const PROFILE_FILE = join(FLASH_BASE, "profile.json");

export class ProfileError extends Error {
  constructor(message: string, public code = "PROFILE_INVALID_BODY", public statusCode = 400, public details?: Record<string, unknown>) {
    super(message);
  }
}

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
// Notes are prose, so they keep line breaks and tabs.
const NOTES_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/;
const MAX_ENTRIES = 50;
const MAX_VALUE = 1024;
const MAX_NOTES = 8000;
const UPDATE_FIELDS = ["variables", "paths", "appdataRoot", "notes", "dryRun"] as const;

/** Variables most installs share, which the evidence counts across containers. */
export const CONVENTION_VARIABLES = ["TZ", "PUID", "PGID", "UMASK"] as const;

/** Template defaults under any pool's appdata folder, such as /mnt/cache/appdata/plex. */
const APPDATA_DEFAULT_RE = /^\/mnt\/[^/]+\/appdata(?=\/|$)/;

/** Container paths compare without a trailing slash: "/config/" and "/config" are one mount. */
export function normalizeTarget(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

function checkVariableValue(key: string, value: string): string | null {
  if (!VAR_NAME_RE.test(key)) return `"${key}" is not a valid variable name.`;
  if (value.length > MAX_VALUE) return `The value for "${key}" is longer than ${MAX_VALUE} characters.`;
  if (CONTROL_RE.test(value)) return `The value for "${key}" contains a control character.`;
  return null;
}

function checkHostPath(label: string, value: string): string | null {
  if (!value.startsWith("/") || normalizeTarget(value) === "/") return `${label} must be an absolute folder other than /, got ${JSON.stringify(value)}.`;
  if (value.includes(":")) return `${label} must not contain a colon.`;
  if (value.length > MAX_VALUE || CONTROL_RE.test(value)) return `${label} is too long or contains a control character.`;
  return null;
}

function checkPathEntry(target: string, value: string): string | null {
  if (!target.startsWith("/") || target.includes(":") || target.length > MAX_VALUE || CONTROL_RE.test(target)) {
    return `"${target}" must be the absolute path inside the container, such as "/media", with no colon.`;
  }
  return checkHostPath(`The host folder for "${target}"`, value);
}

function checkAppdataRoot(value: string): string | null {
  if (!/^\/mnt\/[^/]+/.test(value)) return `"appdataRoot" must be a folder under /mnt, such as /mnt/user/appdata, got ${JSON.stringify(value)}.`;
  return checkHostPath('"appdataRoot"', value);
}

function checkNotes(value: string): string | null {
  if (value.length > MAX_NOTES) return `"notes" is longer than ${MAX_NOTES} characters.`;
  if (NOTES_CONTROL_RE.test(value)) return '"notes" contains a control character.';
  return null;
}

/**
 * Read a saved profile. Only the API writes the file, so anything malformed
 * was edited by hand; such entries are dropped rather than failing installs.
 */
export function parseStoredProfile(raw: string): SetupProfile {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return {};
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return {};
  const d = doc as Record<string, unknown>;
  const out: SetupProfile = {};
  const readMap = (value: unknown, check: (k: string, v: string) => string | null, clean: (s: string) => string) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
      if (typeof v === "string" && check(k, v) === null) map[clean(k)] = clean(v);
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };
  // Variable values are taken as written; paths lose a trailing slash.
  const variables = readMap(d.variables, checkVariableValue, (x) => x);
  if (variables) out.variables = variables;
  const paths = readMap(d.paths, checkPathEntry, normalizeTarget);
  if (paths) out.paths = paths;
  if (typeof d.appdataRoot === "string" && checkAppdataRoot(d.appdataRoot) === null) out.appdataRoot = normalizeTarget(d.appdataRoot);
  if (typeof d.notes === "string" && d.notes !== "" && checkNotes(d.notes) === null) out.notes = d.notes;
  if (typeof d.updatedAt === "string" && !Number.isNaN(Date.parse(d.updatedAt))) out.updatedAt = d.updatedAt;
  return out;
}

/**
 * Check a profile change by hand, for the same reason install bodies are: a
 * mistyped field must be refused, not dropped, and dryRun must be a boolean.
 */
export function parseProfileUpdate(raw: unknown): SetupProfileUpdate {
  const fail = (message: string, details?: Record<string, unknown>): never => {
    throw new ProfileError(message, "PROFILE_INVALID_BODY", 400, details);
  };
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("The request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if ((UPDATE_FIELDS as readonly string[]).includes(key)) continue;
    const near = UPDATE_FIELDS.find((f) => f.toLowerCase() === key.toLowerCase());
    fail(
      near ? `Unknown field "${key}". Did you mean "${near}"?` : `Unknown field "${key}". Allowed fields are: ${UPDATE_FIELDS.join(", ")}.`,
      { field: key, allowed: [...UPDATE_FIELDS] }
    );
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    fail(`"dryRun" must be true or false, not ${JSON.stringify(body.dryRun)}.`, { field: "dryRun" });
  }
  const out: SetupProfileUpdate = {};
  for (const field of ["variables", "paths"] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null) {
      out[field] = null;
      continue;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      fail(`"${field}" must be an object of strings, or null to clear it.`, { field });
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_ENTRIES) fail(`"${field}" can hold at most ${MAX_ENTRIES} entries.`, { field });
    const map: Record<string, string | null> = {};
    for (const [k, v] of entries) {
      if (v === null) {
        map[field === "paths" ? normalizeTarget(k) : k] = null;
        continue;
      }
      if (typeof v !== "string") fail(`"${field}.${k}" must be a string, or null to remove it, not ${JSON.stringify(v)}.`, { field: `${field}.${k}` });
      const problem = field === "variables" ? checkVariableValue(k, v as string) : checkPathEntry(k, v as string);
      if (problem) fail(problem, { field: `${field}.${k}` });
      map[field === "paths" ? normalizeTarget(k) : k] = field === "paths" ? normalizeTarget(v as string) : (v as string);
    }
    out[field] = map;
  }
  if (body.appdataRoot !== undefined) {
    if (body.appdataRoot === null || body.appdataRoot === "") out.appdataRoot = null;
    else if (typeof body.appdataRoot !== "string") fail('"appdataRoot" must be a string, or null to clear it.', { field: "appdataRoot" });
    else {
      const problem = checkAppdataRoot(body.appdataRoot);
      if (problem) fail(problem, { field: "appdataRoot" });
      out.appdataRoot = normalizeTarget(body.appdataRoot);
    }
  }
  if (body.notes !== undefined) {
    if (body.notes === null || body.notes === "") out.notes = null;
    else if (typeof body.notes !== "string") fail('"notes" must be a string, or null to clear it.', { field: "notes" });
    else {
      const notes = body.notes.replace(/\r\n?/g, "\n");
      const problem = checkNotes(notes);
      if (problem) fail(problem, { field: "notes" });
      out.notes = notes;
    }
  }
  if (Object.keys(out).length === 0) {
    fail('Nothing to change. Pass at least one of "variables", "paths", "appdataRoot" or "notes".');
  }
  if (body.dryRun !== undefined) out.dryRun = body.dryRun as boolean;
  return out;
}

/** Apply a change. Returns the new profile and the fields that changed, such as "variables.TZ". */
export function mergeProfile(current: SetupProfile, update: SetupProfileUpdate): { profile: SetupProfile; changed: string[] } {
  const next: SetupProfile = {};
  const changed: string[] = [];
  for (const field of ["variables", "paths"] as const) {
    const before = current[field] ?? {};
    const change = update[field];
    let after: Record<string, string>;
    if (change === undefined) after = { ...before };
    else if (change === null) after = {};
    else {
      after = { ...before };
      for (const [k, v] of Object.entries(change)) {
        if (v === null) delete after[k];
        else after[k] = v;
      }
    }
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[k] !== after[k]) changed.push(`${field}.${k}`);
    }
    if (Object.keys(after).length > MAX_ENTRIES) {
      throw new ProfileError(`"${field}" can hold at most ${MAX_ENTRIES} entries.`, "PROFILE_INVALID_BODY", 400, { field });
    }
    if (Object.keys(after).length > 0) next[field] = after;
  }
  for (const field of ["appdataRoot", "notes"] as const) {
    const change = update[field];
    const after = change === undefined ? current[field] : change === null ? undefined : change;
    if (after !== current[field]) changed.push(field);
    if (after !== undefined) next[field] = after;
  }
  if (current.updatedAt) next.updatedAt = current.updatedAt;
  return { profile: next, changed };
}

export async function readProfile(file = PROFILE_FILE): Promise<SetupProfile> {
  try {
    return parseStoredProfile(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

export async function writeProfile(profile: SetupProfile, file = PROFILE_FILE): Promise<void> {
  // A rename over the old file, so a failed write leaves the previous profile.
  await mkdir(dirname(file), { recursive: true });
  const staging = `${file}.unraidclaw-tmp`;
  await writeFile(staging, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(staging, file);
}

/**
 * Fill template fields the caller left unset from the profile.
 *
 * `overrides` is keyed the way resolveOverrides keys it, and a field already in
 * it is the caller's choice and is never touched. A variable is matched by its
 * name, a path by its container-side target; a path with no profile entry whose
 * default sits in some pool's appdata folder is moved under appdataRoot. A
 * dropdown keeps its default when the profile value is not one of its options.
 */
export function applyProfile(
  config: CaConfigEntry[],
  overrides: Map<string, string>,
  profile: SetupProfile,
  keyOf: (entry: CaConfigEntry) => string
): { overrides: Map<string, string>; applied: ProfileApplied[] } {
  const out = new Map(overrides);
  const applied: ProfileApplied[] = [];
  for (const entry of config) {
    const key = keyOf(entry);
    if (out.has(key)) continue;
    let value: string | undefined;
    let from = "";
    if (entry.type === "Variable" && entry.target !== "") {
      const v = profile.variables?.[entry.target];
      if (v !== undefined && (!entry.choices || entry.choices.includes(v))) {
        value = v;
        from = `variables.${entry.target}`;
      }
    } else if (entry.type === "Path" && entry.target !== "") {
      const target = normalizeTarget(entry.target);
      const p = profile.paths?.[target];
      if (p !== undefined) {
        value = p;
        from = `paths.${target}`;
      } else if (profile.appdataRoot && APPDATA_DEFAULT_RE.test(entry.default)) {
        value = entry.default.replace(APPDATA_DEFAULT_RE, profile.appdataRoot);
        from = "appdataRoot";
      }
    }
    if (value === undefined || value === entry.default) continue;
    out.set(key, value);
    applied.push({
      field: entry.name || entry.target,
      value: entry.mask ? "(hidden)" : value,
      replaced: entry.mask ? "(hidden)" : entry.default,
      from,
    });
  }
  return { overrides: out, applied };
}

// ── Conventions found in the installed containers ──────────────

/** The parts of `docker inspect` the evidence reads. */
interface InspectRecord {
  Name?: string;
  Config?: { Env?: string[] | null };
  HostConfig?: { NetworkMode?: string };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string }> | null;
}

function bump(counts: ValueCounts, value: string): void {
  counts[value] = (counts[value] ?? 0) + 1;
}

function sorted(counts: ValueCounts): ValueCounts {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function top(counts: ValueCounts | undefined): [string, number] | undefined {
  return counts ? Object.entries(sorted(counts))[0] : undefined;
}

/**
 * Count the conventions in the containers already installed, and suggest a
 * profile from the most used values. A path is suggested only when at least
 * two containers mount the same host folder at it, so one app's choice is not
 * taken for a habit.
 */
export function detectConventions(
  inspects: unknown[],
  serverTimeZone: string | null
): Pick<SetupProfileView, "suggested" | "evidence" | "notices"> {
  const variables: Record<string, ValueCounts> = {};
  const holders: Record<string, Record<string, string[]>> = {};
  const appdataRoots: ValueCounts = {};
  const paths: Record<string, ValueCounts> = {};
  const networks: ValueCounts = {};
  let containers = 0;

  for (const item of inspects) {
    if (item === null || typeof item !== "object") continue;
    const c = item as InspectRecord;
    containers++;
    const name = String(c.Name ?? "").replace(/^\//, "");
    for (const line of c.Config?.Env ?? []) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      if (!(CONVENTION_VARIABLES as readonly string[]).includes(key)) continue;
      const value = line.slice(eq + 1);
      bump((variables[key] ??= {}), value);
      ((holders[key] ??= {})[value] ??= []).push(name);
    }
    const network = c.HostConfig?.NetworkMode;
    if (network) bump(networks, network);
    const roots = new Set<string>();
    const mounted: Record<string, string> = {};
    for (const m of c.Mounts ?? []) {
      if (m.Type !== "bind" || !m.Source || !m.Destination) continue;
      const root = /^(\/mnt\/[^/]+\/appdata)(?=\/|$)/.exec(m.Source);
      if (root) roots.add(root[1]);
      else if (m.Source.startsWith("/mnt/")) mounted[normalizeTarget(m.Destination)] = normalizeTarget(m.Source);
    }
    for (const r of roots) bump(appdataRoots, r);
    for (const [dest, src] of Object.entries(mounted)) bump((paths[dest] ??= {}), src);
  }

  const suggested: SetupProfile = {};
  const vars: Record<string, string> = {};
  for (const key of CONVENTION_VARIABLES) {
    // Unraid gives every container the timezone from its own settings, so
    // that is the one to suggest even where old containers disagree.
    const value = key === "TZ" && serverTimeZone ? serverTimeZone : top(variables[key])?.[0];
    if (value !== undefined) vars[key] = value;
  }
  if (Object.keys(vars).length > 0) suggested.variables = vars;
  const root = top(appdataRoots);
  if (root) suggested.appdataRoot = root[0];
  const sharedPaths: Record<string, string> = {};
  for (const [dest, counts] of Object.entries(paths).sort((a, b) => a[0].localeCompare(b[0]))) {
    const best = top(counts);
    if (best && best[1] >= 2) sharedPaths[dest] = best[0];
  }
  if (Object.keys(sharedPaths).length > 0) suggested.paths = sharedPaths;

  const notices: string[] = [];
  for (const key of CONVENTION_VARIABLES) {
    const counts = variables[key];
    if (!counts || Object.keys(counts).length < 2) continue;
    const expected = key === "TZ" && serverTimeZone ? serverTimeZone : top(counts)![0];
    const odd = Object.entries(sorted(counts)).filter(([v]) => v !== expected);
    const list = odd
      .map(([v, n]) => {
        const names = holders[key][v];
        const shown = names.slice(0, 10).join(", ") + (names.length > 10 ? `, and ${names.length - 10} more` : "");
        return `${key}=${v} (${n}: ${shown})`;
      })
      .join("; ");
    notices.push(
      key === "TZ" && serverTimeZone
        ? `Unraid is set to ${serverTimeZone}, but some containers use another timezone: ${list}. Unraid sets TZ when it creates a container, so these were probably created before the timezone changed; rebuilding one picks up the current setting unless its template sets TZ itself.`
        : `Most containers use ${key}=${expected}, but some differ: ${list}.`
    );
  }

  const evidence: SetupProfileEvidence = {
    containers,
    variables: Object.fromEntries(Object.entries(variables).map(([k, v]) => [k, sorted(v)])),
    appdataRoots: sorted(appdataRoots),
    paths: Object.fromEntries(Object.entries(paths).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, sorted(v)])),
    networks: sorted(networks),
    serverTimeZone,
  };
  return { suggested, evidence, notices };
}
