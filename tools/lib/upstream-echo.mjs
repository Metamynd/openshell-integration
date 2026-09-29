// Stand-in for the purchasing API in M0 step 0.5 (spike S3). Serves HTTPS and plain HTTP on
// loopback and reports whether the request carried the expected bearer token, without ever
// echoing the token or any header value back.
//
// Env: ECHO_TOKEN (required), ECHO_TLS_CERT, ECHO_TLS_KEY, ECHO_HTTPS_PORT (8443), ECHO_HTTP_PORT (8081)
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const token = process.env.ECHO_TOKEN;
if (!token) throw new Error('ECHO_TOKEN is required');
const expected = `Bearer ${token}`;

/** @param {string} listener */
function handler(listener) {
  return (/** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res) => {
    const auth = req.headers.authorization ?? '';
    const report = {
      listener,
      method: req.method,
      path: req.url,
      auth_present: auth !== '',
      auth_is_real_token: auth === expected,
      auth_is_placeholder: auth.includes('openshell:resolve'),
      upgrade_requested: Boolean(req.headers.upgrade),
    };
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...report })}\n`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify(report)}\n`);
  };
}

const httpsPort = Number(process.env.ECHO_HTTPS_PORT ?? 8443);
const httpPort = Number(process.env.ECHO_HTTP_PORT ?? 8081);
https
  .createServer({ cert: readFileSync(process.env.ECHO_TLS_CERT ?? ''), key: readFileSync(process.env.ECHO_TLS_KEY ?? '') }, handler('https'))
  .listen(httpsPort, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ event: 'listening', listener: 'https', port: httpsPort })}\n`));
http
  .createServer(handler('http'))
  .listen(httpPort, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ event: 'listening', listener: 'http', port: httpPort })}\n`));
