#!/usr/bin/env node
// Guard: openclaw.plugin.json contracts.tools must list exactly the tool names
// registered in src/. OpenClaw 2026.6.x only exposes tools to the LLM agent if
// they are declared in contracts.tools; a drift here silently hides tools
// (see issue #15). Run in CI / prepublish.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const registered = new Set();
for (const file of walk(join(root, 'src')).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bunraid_[a-z0-9_]+/g)) registered.add(m[0]);
}

const manifest = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8'));
const declared = new Set(manifest.contracts?.tools ?? []);

const missing = [...registered].filter((n) => !declared.has(n)).sort();
const extra = [...declared].filter((n) => !registered.has(n)).sort();

if (missing.length || extra.length) {
  console.error('contracts.tools is out of sync with registered tools:');
  if (missing.length) console.error('  registered but NOT declared:', missing.join(', '));
  if (extra.length) console.error('  declared but NOT registered:', extra.join(', '));
  console.error(`\nFix openclaw.plugin.json contracts.tools (${registered.size} tools registered, ${declared.size} declared).`);
  process.exit(1);
}
console.log(`contracts.tools OK: ${declared.size} tools declared and registered.`);

// Guard: the SecretRef branch of an apiKey schema must not enumerate sources.
// OpenClaw validates the source itself and adds new ones over time (store came
// in 2026.9); a list here rejects a ref the gateway would resolve (issue #19).
const props = manifest.configSchema?.properties ?? {};
const apiKeySchemas = {
  apiKey: props.apiKey,
  'servers[].apiKey': props.servers?.items?.properties?.apiKey,
};
for (const [path, schema] of Object.entries(apiKeySchemas)) {
  const ref = schema?.anyOf?.find((s) => s.type === 'object');
  const source = ref?.properties?.source;
  if (!source || source.type !== 'string' || 'enum' in source || 'const' in source) {
    console.error(`configSchema ${path}: the SecretRef source must be a plain string with no enum, so OpenClaw decides which sources exist.`);
    process.exit(1);
  }
}
console.log('configSchema OK: apiKey SecretRef sources are not restricted.');
