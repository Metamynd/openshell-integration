// Connection tracer for the POC processes. Preload it into every process to count new TCP/TLS connections
// against requests, per origin, with the server's connection and keep-alive response headers. It answers:
// does a process reuse its connections to metamynd.ai? It covers both transports the MetaMynd packages have
// used: Node's built-in fetch (undici; handshake time too) and, since v1.72.2's keepAliveFetch, node:http/https
// (a request on a reused socket reports reusedSocket; every other one opened a connection).
//   CONN_TRACE_DIR=state/conn-trace NODE_OPTIONS="--import=$PWD/tools/lib/conn-trace.mjs" PERF_N=30 bash tools/m5-perf.sh
//   node tools/lib/conn-trace.mjs --report state/conn-trace
// Each traced process writes <dir>/conn-<pid>.json after every response. Records no URLs beyond the origin,
// no request or response bodies and no header values other than connection and keep-alive.
import dc from 'node:diagnostics_channel';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) report(process.argv[process.argv.indexOf('--report') + 1] ?? 'state/conn-trace');
else if (process.env.CONN_TRACE_DIR) trace(process.env.CONN_TRACE_DIR);

/** @param {string} dir */
function trace(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `conn-${process.pid}.json`);
  const proc = basename(process.argv[1] ?? 'node');
  /** @type {Record<string, {via: string, requests: number, connections: number, connectMs: number[], connection: string[], keepAlive: string[]}>} */
  const origins = {};
  const at = (/** @type {string} */ o, via = 'fetch') => (origins[`${via} ${o}`] ??= { via, requests: 0, connections: 0, connectMs: [], connection: [], keepAlive: [] });
  /** @type {Map<string, number[]>} origin -> start times of connects in flight (the two events do not share an object) */
  const started = new Map();
  const originOf = (/** @type {any} */ p) => `${p.protocol}//${p.hostname}${p.port ? `:${p.port}` : ''}`;
  const save = () => { try { writeFileSync(file, JSON.stringify({ pid: process.pid, proc, origins })); } catch { /* tracing must never break the process */ } };
  const note = (/** @type {string[]} */ list, /** @type {string} */ v) => { if (!list.includes(v) && list.length < 5) list.push(v); };

  dc.subscribe('undici:client:beforeConnect', (/** @type {any} */ m) => {
    const k = originOf(m.connectParams);
    started.set(k, [...(started.get(k) ?? []), performance.now()]);
  });
  dc.subscribe('undici:client:connected', (/** @type {any} */ m) => {
    const k = originOf(m.connectParams);
    const o = at(k);
    o.connections++;
    const t0 = started.get(k)?.shift();
    if (t0 !== undefined) o.connectMs.push(Math.round(performance.now() - t0));
    save();
  });
  dc.subscribe('undici:request:headers', (/** @type {any} */ m) => {
    const o = at(String(m.request.origin));
    o.requests++;
    const h = m.response.headers ?? [];
    for (let i = 0; i + 1 < h.length; i += 2) {
      const k = String(h[i]).toLowerCase();
      if (k === 'connection') note(o.connection, String(h[i + 1]));
      if (k === 'keep-alive') note(o.keepAlive, String(h[i + 1]));
    }
    save();
  });

  // node:http / node:https (keepAliveFetch in the MetaMynd packages since v1.72.2).
  dc.subscribe('http.client.response.finish', (/** @type {any} */ m) => {
    const req = m.request;
    const host = String(req.getHeader?.('host') ?? req.host ?? '');
    const o = at(`${req.protocol ?? 'http:'}//${host}`, 'node:http');
    o.requests++;
    if (!req.reusedSocket) o.connections++;
    const h = m.response?.headers ?? {};
    if (h.connection) note(o.connection, String(h.connection));
    if (h['keep-alive']) note(o.keepAlive, String(h['keep-alive']));
    save();
  });
}

/** @param {string} dir */
function report(dir) {
  const median = (/** @type {number[]} */ a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : '–');
  const rows = [];
  for (const f of readdirSync(dir).filter((n) => /^conn-\d+\.json$/.test(n))) {
    const { pid, proc, origins } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const [key, o] of Object.entries(origins)) {
      if (!o.requests && !o.connections) continue;
      const origin = key.slice(key.indexOf(' ') + 1);
      rows.push({ proc, pid, via: o.via ?? 'fetch', origin, requests: o.requests, connections: o.connections,
        reuse: o.requests ? `${Math.round(100 * (1 - o.connections / o.requests))}%` : '–',
        connectMs: median(o.connectMs), connection: o.connection.join(' | ') || '–', keepAlive: o.keepAlive.join(' | ') || '–' });
    }
  }
  if (!rows.length) { console.log(`no traced requests in ${dir}`); return; }
  console.table(rows);
  console.log('reuse = 1 - connections/requests. Near 0% means a new connection per request. connectMs (fetch only) is the median TCP+TLS handshake.');
}
