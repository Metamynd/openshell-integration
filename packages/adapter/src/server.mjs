// gRPC server for OpenShell supervisor middleware handlers (TLS in deployment; plaintext in tests).
import grpc from '@grpc/grpc-js';
import { loadMiddlewareProto } from './proto.mjs';

/**
 * @param {object} opts
 * @param {string} opts.bind host:port
 * @param {{ certPem: Buffer, keyPem: Buffer } | null} opts.tls
 * @param {object} opts.handlers SupervisorMiddleware handlers (unimplemented RPCs answer UNIMPLEMENTED)
 * @returns {Promise<{ server: grpc.Server, port: number }>}
 */
export function startMiddlewareServer({ bind, tls, handlers }) {
  const { SupervisorMiddleware } = loadMiddlewareProto();
  // OpenShell sends bodies up to 4 MiB plus headers and context.
  const server = new grpc.Server({ 'grpc.max_receive_message_length': 5 * 1024 * 1024, 'grpc.max_send_message_length': 5 * 1024 * 1024 });
  server.addService(SupervisorMiddleware.service, /** @type {any} */ (handlers));
  const creds = tls
    ? grpc.ServerCredentials.createSsl(null, [{ private_key: tls.keyPem, cert_chain: tls.certPem }], false)
    : grpc.ServerCredentials.createInsecure();
  return new Promise((resolve, reject) => {
    server.bindAsync(bind, creds, (err, port) => (err ? reject(err) : resolve({ server, port })));
  });
}
