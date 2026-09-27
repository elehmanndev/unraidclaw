// Keys for the web APIs of installed apps, saved on the App Keys tab.
//
// The file is written only by the WebGUI (php/app-keys.php), behind Unraid's
// own login and CSRF check. Nothing in the API writes it or returns a value
// from it: a request uses a key without showing it, and the listing says only
// which apps have one and how it is sent. That way an agent can use an app's
// key without anyone having to paste it into a chat.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppKeyType } from "@unraidclaw/shared";

const FLASH_BASE = process.env.FLASH_BASE ?? "/boot/config/plugins/unraidclaw";
export const APP_KEYS_FILE = join(FLASH_BASE, "app-keys.json");

export interface AppKey {
  type: AppKeyType;
  /** The header it goes in: the configured one for "header", Authorization otherwise. */
  header: string;
  value: string;
  /** Basic auth only. */
  username?: string;
}

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

function clean(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > 4096) return null;
  return /[\r\n\0]/.test(value) ? null : value;
}

/**
 * Parse the keys file. An entry that is not well formed is skipped rather than
 * failing every request: it can only have been hand-edited, and the WebGUI
 * lists it as unusable.
 */
export function parseAppKeys(raw: string): Map<string, AppKey> {
  const out = new Map<string, AppKey>();
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return out;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return out;
  for (const [name, entry] of Object.entries(doc as Record<string, unknown>)) {
    if (!NAME_RE.test(name) || entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const value = clean(e.value);
    if (value === null) continue;
    if (e.type === "header") {
      const header = typeof e.header === "string" && HEADER_NAME_RE.test(e.header) ? e.header : null;
      if (header) out.set(name, { type: "header", header, value });
    } else if (e.type === "bearer") {
      out.set(name, { type: "bearer", header: "Authorization", value });
    } else if (e.type === "basic") {
      const username = clean(e.username);
      if (username !== null && !username.includes(":")) out.set(name, { type: "basic", header: "Authorization", value, username });
    }
  }
  return out;
}

export async function readAppKeys(path = APP_KEYS_FILE): Promise<Map<string, AppKey>> {
  try {
    return parseAppKeys(await readFile(path, "utf8"));
  } catch {
    return new Map();
  }
}

/** The header value a key produces. */
export function keyHeaderValue(key: AppKey): string {
  if (key.type === "bearer") return `Bearer ${key.value}`;
  if (key.type === "basic") return `Basic ${Buffer.from(`${key.username}:${key.value}`).toString("base64")}`;
  return key.value;
}

/** Every form of the key that must never appear in a response, longest first. */
export function keySecrets(key: AppKey): string[] {
  const forms = new Set([key.value, keyHeaderValue(key)]);
  if (key.type === "basic") forms.add(Buffer.from(`${key.username}:${key.value}`).toString("base64"));
  return [...forms].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}
