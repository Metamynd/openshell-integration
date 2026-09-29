// Minimal client for the agentsafe-signer daemon protocol: one newline-delimited JSON
// request per connection, one JSON reply ({ ok, result } or { ok: false, error }).
import { randomUUID } from 'node:crypto';
import net from 'node:net';

/**
 * @param {string} socketPath
 * @param {string} op
 * @param {Record<string, unknown>} [params]
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
export function daemonRequest(socketPath, op, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`signer ${op} timed out on ${socketPath}`));
    }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), op, params })}\n`));
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch (err) {
        reject(err);
        return;
      }
      if (msg.ok) resolve(msg.result);
      else reject(Object.assign(new Error(`signer ${op}: ${msg.error?.message ?? msg.error?.code ?? JSON.stringify(msg.error)}`), { code: msg.error?.code }));
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
