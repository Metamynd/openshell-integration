// Pin the MetaMynd SDKs to their latest npm versions in every workspace, and record them in versions.lock.
//   node tools/bump-metamynd.mjs [--tag vX.Y.Z] [--wait <seconds>]
// --tag    the AgentSafe release that triggered the bump (recorded as versions.lock metamynd.service.release)
// --wait   poll npm for up to this long until a version differs from the pins: an AgentSafe tag announces itself
//          as soon as its npm publish job finishes, and the registry can lag a little behind that
// Edits package.json files and versions.lock only; run `npm install` afterwards to update the lockfile.
// Prints a summary, and in GitHub Actions writes changed=true|false and summary=… to $GITHUB_OUTPUT.
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PACKAGES = ['@metamynd/agentsafe-guard', '@metamynd/agentsafe-mcp-guard', '@metamynd/agentsafe-http-gateway', '@metamynd/agentsafe-signer'];

const args = process.argv.slice(2);
const opt = (/** @type {string} */ name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const tag = opt('--tag');
if (tag !== undefined && !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`--tag must look like v1.2.3, got ${tag}`);
const waitS = Number(opt('--wait') ?? 0);

const workspaces = readdirSync('packages').map((d) => join('packages', d, 'package.json'));
/** @returns {Record<string, string[]>} package -> every distinct version pinned across the workspaces */
function currentPins() {
  /** @type {Record<string, string[]>} */
  const pins = {};
  for (const f of workspaces) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    for (const name of PACKAGES) {
      const v = pkg.dependencies?.[name];
      if (v && !(pins[name] ??= []).includes(v)) pins[name].push(v);
    }
  }
  return pins;
}
/** @returns {Promise<Record<string, string>>} package -> the version npm's `latest` tag points at */
async function latest() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of PACKAGES) {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, { headers: { accept: 'application/json' } });
    const version = res.ok ? (await res.json())?.version : undefined;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`could not read the latest version of ${name} (HTTP ${res.status})`);
    out[name] = version;
  }
  return out;
}

const pins = currentPins();
let want = await latest();
// A package needs bumping when any workspace pins it at something other than the latest.
const stale = (/** @type {string} */ n) => (pins[n] ?? []).some((v) => v !== want[n]);
const differs = () => PACKAGES.some(stale);
for (let waited = 0; !differs() && waited < waitS; waited += 30) {
  console.log(`npm still serves the pinned versions; checking again in 30 s (${waited}/${waitS} s)`);
  await new Promise((r) => setTimeout(r, 30_000));
  want = await latest();
}

const changes = PACKAGES.filter(stale);
for (const f of workspaces) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  let next = text;
  // Edit the text in place, so each file keeps its own formatting (one-line or pretty-printed).
  for (const n of changes) next = next.replace(new RegExp(`("${n.replace('/', '\\/')}"\\s*:\\s*)"[^"]+"`), `$1"${want[n]}"`);
  if (next !== text) writeFileSync(f, next);
}

if (changes.length || tag) {
  const lock = JSON.parse(readFileSync('versions.lock', 'utf8'));
  for (const n of PACKAGES) if (lock.metamynd?.packages?.[n]) lock.metamynd.packages[n] = want[n].replace(/\.\d+$/, '.x');
  if (tag) lock.metamynd.service.release = tag;
  writeFileSync('versions.lock', `${JSON.stringify(lock, null, 2)}\n`);
}

const summary = changes.map((n) => `${n.replace('@metamynd/', '')} ${pins[n].filter((v) => v !== want[n]).join('/')} → ${want[n]}`).join(', ');
console.log(changes.length ? `bumped: ${summary}` : `already on the latest: ${PACKAGES.map((n) => `${n.replace('@metamynd/', '')} ${want[n]}`).join(', ')}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\nsummary=${summary}\n`);
