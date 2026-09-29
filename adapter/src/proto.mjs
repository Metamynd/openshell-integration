// Loads the vendored OpenShell v0.1.2 middleware protos (see versions.lock.json).
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const PROTO_DIR = fileURLToPath(new URL('../proto/openshell/', import.meta.url));

export function loadMiddlewareProto() {
  const definition = protoLoader.loadSync('supervisor_middleware.proto', {
    includeDirs: [PROTO_DIR],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(definition);
  return {
    SupervisorMiddleware: pkg.openshell.middleware.v1.SupervisorMiddleware,
    HttpResponsePreReturn: pkg.openshell.middleware.v1.HttpResponsePreReturn,
    extension: pkg.openshell.extension.v1,
  };
}
