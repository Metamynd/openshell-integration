// Loads the vendored OpenShell v0.1.2 middleware protos (see versions.lock).
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const PROTO_DIR = fileURLToPath(new URL('../../../proto/v0.1.2/', import.meta.url));

/**
 * @param {grpc.GrpcObject} root
 * @param {string} name fully qualified service name
 * @returns {grpc.ServiceClientConstructor}
 */
function service(root, name) {
  /** @type {any} */
  let node = root;
  for (const part of name.split('.')) node = node?.[part];
  if (typeof node !== 'function' || !node.service) {
    throw new Error(`service ${name} not found in vendored protos`);
  }
  return node;
}

export function loadMiddlewareProto() {
  const definition = protoLoader.loadSync('supervisor_middleware.proto', {
    includeDirs: [PROTO_DIR],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const root = grpc.loadPackageDefinition(definition);
  return {
    SupervisorMiddleware: service(root, 'openshell.middleware.v1.SupervisorMiddleware'),
    HttpResponsePreReturn: service(root, 'openshell.middleware.v1.HttpResponsePreReturn'),
  };
}
