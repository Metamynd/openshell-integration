// M0 step 0.4 stub middleware: completes OpenShell's Describe negotiation, verifies
// the gateway JWT on every call, and denies every HTTP request. It never allows.
import grpc from '@grpc/grpc-js';
import { loadMiddlewareProto } from './proto.mjs';
import { ExtensionAuthError } from './jwt.mjs';

export const CONTRACT_CAPABILITY = 'openshell.supervisor-middleware.contract';
const PROTOCOL_MAJOR = 1;

/** @param {number} code @param {string} details */
function rpcError(code, details) {
  return Object.assign(new Error(details), { code, details });
}

/**
 * @param {object} opts
 * @param {((authorization: unknown) => import('./jwt.mjs').ExtensionClaims) | null} opts.verifyToken
 *   null only in insecure-transport mode, where OpenShell sends no token
 * @param {string} opts.audience echoed as expected_audience when tokens are verified
 * @param {number} opts.maxPayloadBytes
 * @param {(entry: Record<string, unknown>) => void} opts.log
 */
export function createStubHandlers({ verifyToken, audience, maxPayloadBytes, log }) {
  /**
   * @param {any} call
   * @param {Array<'gateway' | 'supervisor'>} allowed
   */
  function authenticate(call, allowed) {
    if (!verifyToken) return null;
    const claims = verifyToken(call.metadata.get('authorization')[0]);
    if (!allowed.includes(claims.caller_kind)) {
      throw new ExtensionAuthError('caller_not_allowed', `caller_kind ${claims.caller_kind} may not call this RPC`);
    }
    return claims;
  }

  /** @param {unknown} err */
  function authStatus(err) {
    if (err instanceof ExtensionAuthError) {
      const code = err.code === 'caller_not_allowed' ? grpc.status.PERMISSION_DENIED : grpc.status.UNAUTHENTICATED;
      return rpcError(code, err.message);
    }
    return rpcError(grpc.status.INTERNAL, 'internal error');
  }

  return {
    /** @param {any} call @param {any} callback */
    Describe(call, callback) {
      try {
        const claims = authenticate(call, ['gateway', 'supervisor']);
        const gateway = call.request.gateway ?? {};
        const major = gateway.protocol_version?.major;
        const required = gateway.required_capabilities ?? [];
        log({ rpc: 'Describe', caller: claims?.caller_kind ?? 'unauthenticated', sandbox_id: claims?.sandbox_id,
          peer: gateway.implementation_name, peer_version: gateway.implementation_version, protocol_major: major });
        if (major !== PROTOCOL_MAJOR) {
          return callback(rpcError(grpc.status.FAILED_PRECONDITION, `unsupported protocol major ${major}`));
        }
        const unmet = required.filter((/** @type {string} */ c) => c !== CONTRACT_CAPABILITY);
        if (unmet.length > 0) {
          return callback(rpcError(grpc.status.FAILED_PRECONDITION, `unsupported required capabilities: ${unmet.join(', ')}`));
        }
        callback(null, {
          name: 'metamynd/openshell-adapter-stub',
          expected_audience: verifyToken ? audience : '',
          bindings: [{
            operation: 'SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST',
            phase: 'SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS',
            max_payload_bytes: String(maxPayloadBytes),
          }],
          extension: {
            protocol_version: { major: PROTOCOL_MAJOR, minor: 0 },
            implementation_name: 'metamynd/openshell-adapter',
            implementation_version: '0.0.1-stub',
            supported_capabilities: [CONTRACT_CAPABILITY],
            required_capabilities: [CONTRACT_CAPABILITY],
          },
        });
      } catch (err) {
        log({ rpc: 'Describe', auth: err instanceof ExtensionAuthError ? err.code : 'error' });
        callback(authStatus(err));
      }
    },

    /** @param {any} call @param {any} callback */
    ValidateConfig(call, callback) {
      try {
        const claims = authenticate(call, ['gateway']);
        log({ rpc: 'ValidateConfig', caller: claims?.caller_kind ?? 'unauthenticated', middleware: call.request.middleware_name });
        callback(null, { valid: true, reason: '' });
      } catch (err) {
        log({ rpc: 'ValidateConfig', auth: err instanceof ExtensionAuthError ? err.code : 'error' });
        callback(authStatus(err));
      }
    },

    // Always a DENY decision, never a gRPC error, so the sandbox sees a stable reason_code
    // instead of OpenShell's generic middleware_failed.
    /** @param {any} call @param {any} callback */
    EvaluateHttpRequest(call, callback) {
      const ctx = call.request.context ?? {};
      const target = call.request.target ?? {};
      let reasonCode = 'stub_deny';
      let auth = 'ok';
      /** @type {string | undefined} */
      let tokenSandbox;
      try {
        const claims = authenticate(call, ['supervisor']);
        tokenSandbox = claims?.sandbox_id;
        if (claims && claims.sandbox_id !== ctx.sandbox_id) {
          reasonCode = 'stub_sandbox_mismatch';
          auth = 'sandbox_mismatch';
        }
      } catch (err) {
        reasonCode = 'stub_unauthenticated';
        auth = err instanceof ExtensionAuthError ? err.code : 'error';
      }
      log({ rpc: 'EvaluateHttpRequest', auth, request_id: ctx.request_id, sandbox_id: ctx.sandbox_id,
        token_sandbox_id: tokenSandbox, sandbox: ctx.sandbox, method: target.method, host: target.host,
        port: target.port, path: target.path, body_bytes: call.request.body?.length ?? 0, reason_code: reasonCode });
      callback(null, { decision: 'DECISION_DENY', reason: 'stub middleware denies every request', reason_code: reasonCode });
    },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.bind host:port
 * @param {{ certPem: Buffer, keyPem: Buffer } | null} opts.tls null serves plaintext
 * @param {ReturnType<typeof createStubHandlers>} opts.handlers
 * @returns {Promise<{ server: grpc.Server, port: number }>}
 */
export function startStubServer({ bind, tls, handlers }) {
  const { SupervisorMiddleware } = loadMiddlewareProto();
  const server = new grpc.Server({
    'grpc.max_receive_message_length': 5 * 1024 * 1024,
    'grpc.max_send_message_length': 5 * 1024 * 1024,
  });
  // EvaluateWebSocketSession is left unimplemented; grpc-js answers UNIMPLEMENTED.
  server.addService(SupervisorMiddleware.service, handlers);
  const creds = tls
    ? grpc.ServerCredentials.createSsl(null, [{ private_key: tls.keyPem, cert_chain: tls.certPem }], false)
    : grpc.ServerCredentials.createInsecure();
  return new Promise((resolve, reject) => {
    server.bindAsync(bind, creds, (err, port) => (err ? reject(err) : resolve({ server, port })));
  });
}
