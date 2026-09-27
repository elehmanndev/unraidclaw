// Docker Compose stacks, the parts that need no host: grouping containers into
// stacks by their Compose labels, hiding secrets in compose files, putting
// hidden values back when an edited file comes in, and diffing two versions.

import { CaInstallError } from "./ca-template.js";

export interface StackContainer {
  id: string;
  name: string;
  service: string;
  state: string;
  status: string;
  image: string;
  running: boolean;
}

export interface StackGroup {
  project: string;
  /** Every working directory the containers' labels name, first seen first. */
  workingDirs: string[];
  /** Every compose file the containers' labels name, in label order. */
  configFiles: string[];
  containers: StackContainer[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Group `docker inspect` output into stacks by com.docker.compose.project.
 *
 * One-off containers from `docker compose run` carry the project label too,
 * but they are not part of the stack's definition and are left out.
 */
export function groupStacks(inspect: any[]): StackGroup[] {
  const byProject = new Map<string, StackGroup>();
  for (const c of inspect) {
    const labels: Record<string, string> = c?.Config?.Labels ?? {};
    const project = labels["com.docker.compose.project"];
    if (!project) continue;
    if (String(labels["com.docker.compose.oneoff"] ?? "").toLowerCase() === "true") continue;
    let group = byProject.get(project);
    if (!group) {
      group = { project, workingDirs: [], configFiles: [], containers: [] };
      byProject.set(project, group);
    }
    const wd = labels["com.docker.compose.project.working_dir"];
    if (wd && !group.workingDirs.includes(wd)) group.workingDirs.push(wd);
    for (const f of String(labels["com.docker.compose.project.config_files"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!group.configFiles.includes(f)) group.configFiles.push(f);
    }
    group.containers.push({
      id: String(c.Id ?? ""),
      name: String(c.Name ?? "").replace(/^\//, ""),
      service: labels["com.docker.compose.service"] ?? "",
      state: String(c.State?.Status ?? ""),
      status: c.State?.Running ? "running" : String(c.State?.Status ?? ""),
      image: String(c.Config?.Image ?? ""),
      running: c.State?.Running === true,
    });
  }
  return [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Secrets ─────────────────────────────────────────────────────

/** Keys whose values are hidden when a compose file is shown. */
const SECRET_KEY_RE = /(pass(word|wd|phrase)?|secret|token|api[_-]?key|apikey|private[_-]?key|credential|auth|salt|pwd|cookie)/i;

/** `KEY: value` in a mapping, the value on the same line. */
const MAP_LINE_RE = /^(\s*)(["']?)([A-Za-z0-9_.-]+)\2(\s*:\s+)(.*?)(\s*)$/;
/** `- KEY=value` in a list, optionally quoted as a whole. */
const LIST_LINE_RE = /^(\s*-\s+)(["']?)([A-Za-z0-9_.-]+)=(.*?)\2(\s*)$/;

const HIDDEN = "***";

/** A value that points somewhere else rather than holding the secret itself. */
function isReference(value: string): boolean {
  const v = value.replace(/^["']|["']$/g, "").trim();
  return v === "" || /^\$\{?[A-Za-z_][A-Za-z0-9_]*(:?[-?][^}]*)?\}?$/.test(v) || v === "|" || v === ">" || v.startsWith("#");
}

function quoteLike(original: string, value: string): string {
  const q = original.match(/^(["'])/)?.[1];
  return q && original.endsWith(q) && original.length >= 2 ? `${q}${value}${q}` : value;
}

/**
 * Hide secret values in a compose file.
 *
 * Line by line: the value of any key that looks like a secret, in mapping or
 * list form, becomes `***`, unless it only refers to a variable. Every value
 * from the stack's .env file is hidden wherever it appears as well. This is a
 * reading aid, not a guarantee: a secret under an innocent name stays visible.
 */
export function redactCompose(text: string, envValues: string[] = []): string {
  const lines = text.split("\n").map((line) => {
    const map = MAP_LINE_RE.exec(line);
    if (map && SECRET_KEY_RE.test(map[3]) && !isReference(map[5])) {
      return `${map[1]}${map[2]}${map[3]}${map[2]}${map[4]}${quoteLike(map[5], HIDDEN)}${map[6]}`;
    }
    const list = LIST_LINE_RE.exec(line);
    if (list && SECRET_KEY_RE.test(list[3]) && !isReference(list[4])) {
      return `${list[1]}${list[2]}${list[3]}=${HIDDEN}${list[2]}${list[5]}`;
    }
    return line;
  });
  let out = lines.join("\n");
  for (const v of [...envValues].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(v).join(HIDDEN);
  return out;
}

function hiddenValue(value: string): boolean {
  return value.replace(/^["']|["']$/g, "") === HIDDEN;
}

/**
 * Put back the real value wherever an edited file still says `***`.
 *
 * An agent edits what it was shown, and it was shown `***` for secrets. Sent
 * back unchanged, `***` means "keep what is there", so it is replaced with the
 * value the same key has in the current file. A `***` for a key the file does
 * not have is refused: there is nothing to keep, and writing `***` as a
 * password would lock the app out.
 */
export function restoreHidden(edited: string, current: string): string {
  const mapValues = new Map<string, string[]>();
  const listValues = new Map<string, string[]>();
  for (const line of current.split("\n")) {
    const map = MAP_LINE_RE.exec(line);
    if (map) (mapValues.get(map[3]) ?? mapValues.set(map[3], []).get(map[3])!).push(map[5]);
    const list = LIST_LINE_RE.exec(line);
    if (list) (listValues.get(list[3]) ?? listValues.set(list[3], []).get(list[3])!).push(list[4]);
  }
  const unique = (values: string[] | undefined, key: string): string => {
    const distinct = [...new Set(values ?? [])].filter((v) => !hiddenValue(v));
    if (distinct.length === 0) {
      throw new CaInstallError(`"${key}" is set to "***", but the current file has no value for it to keep. Write the real value, or remove the line.`, "COMPOSE_HIDDEN_VALUE", 400);
    }
    if (distinct.length > 1) {
      throw new CaInstallError(`"${key}" is set to "***", but the current file has ${distinct.length} different values for it, so which to keep is ambiguous. Write the value.`, "COMPOSE_HIDDEN_VALUE", 400);
    }
    return distinct[0];
  };
  return edited
    .split("\n")
    .map((line) => {
      const map = MAP_LINE_RE.exec(line);
      if (map && hiddenValue(map[5])) {
        const kept = unique(mapValues.get(map[3]), map[3]);
        return `${map[1]}${map[2]}${map[3]}${map[2]}${map[4]}${kept}${map[6]}`;
      }
      const list = LIST_LINE_RE.exec(line);
      if (list && hiddenValue(list[4])) {
        const kept = unique(listValues.get(list[3]), list[3]);
        return `${list[1]}${list[2]}${list[3]}=${kept}${list[2]}${list[5]}`;
      }
      return line;
    })
    .join("\n");
}

// ── Diff ────────────────────────────────────────────────────────

/**
 * A unified diff of two texts, with three lines of context. Compose files are
 * small, so a plain longest-common-subsequence table is fast enough.
 */
export function unifiedDiff(before: string, after: string, name: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops: Array<{ kind: " " | "-" | "+"; text: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    // On a tie, removals come before additions, as in any unified diff.
    if (i < n && j < m && a[i] === b[j]) ops.push({ kind: " ", text: a[i], ai: i++, bi: j++ });
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ kind: "-", text: a[i], ai: i++, bi: j });
    else ops.push({ kind: "+", text: b[j], ai: i, bi: j++ });
  }
  if (!ops.some((o) => o.kind !== " ")) return "";

  const out = [`--- ${name}`, `+++ ${name}`];
  const context = 3;
  // Changes closer together than two contexts share a hunk.
  const changed = ops.map((o, idx) => (o.kind === " " ? -1 : idx)).filter((idx) => idx >= 0);
  const groups: Array<[number, number]> = [];
  for (const idx of changed) {
    const last = groups[groups.length - 1];
    if (last && idx - last[1] <= context * 2) last[1] = idx;
    else groups.push([idx, idx]);
  }
  for (const [first, lastChange] of groups) {
    const hunk = ops.slice(Math.max(0, first - context), Math.min(ops.length, lastChange + context + 1));
    const aLen = hunk.filter((o) => o.kind !== "+").length;
    const bLen = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${hunk[0].ai + 1},${aLen} +${hunk[0].bi + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.kind}${o.text}`);
  }
  return out.join("\n");
}
