// OpenShell v0.1.2 extension negotiation shared by the stub and the adapter: validate the
// gateway's PeerMetadata and build the MiddlewareManifest (design §3.1 `describe`).

export const CONTRACT_CAPABILITY = 'openshell.supervisor-middleware.contract';
export const PROTOCOL_MAJOR = 1;

/**
 * @param {any} gateway PeerMetadata from MiddlewareDescribeRequest
 * @returns {string | null} a reason to refuse, or null when compatible
 */
export function checkGatewayMetadata(gateway) {
  const major = gateway?.protocol_version?.major;
  if (major !== PROTOCOL_MAJOR) return `unsupported protocol major ${major}`;
  const unmet = (gateway?.required_capabilities ?? []).filter((/** @type {string} */ c) => c !== CONTRACT_CAPABILITY);
  return unmet.length ? `unsupported required capabilities: ${unmet.join(', ')}` : null;
}

/**
 * @param {object} opts
 * @param {string} opts.name diagnostic service name
 * @param {string} opts.version implementation version
 * @param {string} opts.expectedAudience '' in insecure-transport mode
 * @param {number} opts.maxPayloadBytes
 * @param {boolean} [opts.responseBinding] also bind HTTP_RESPONSE/PRE_RETURN
 */
export function buildManifest({ name, version, expectedAudience, maxPayloadBytes, responseBinding = false }) {
  const bindings = [{
    operation: 'SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST',
    phase: 'SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS',
    max_payload_bytes: String(maxPayloadBytes),
  }];
  if (responseBinding) {
    bindings.push({
      operation: 'SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_RESPONSE',
      phase: 'SUPERVISOR_MIDDLEWARE_PHASE_PRE_RETURN',
      max_payload_bytes: String(maxPayloadBytes),
    });
  }
  return {
    name,
    expected_audience: expectedAudience,
    bindings,
    extension: {
      protocol_version: { major: PROTOCOL_MAJOR, minor: 0 },
      implementation_name: 'metamynd/openshell-adapter',
      implementation_version: version,
      supported_capabilities: [CONTRACT_CAPABILITY],
      required_capabilities: [CONTRACT_CAPABILITY],
    },
  };
}

/**
 * google.protobuf.Struct as delivered by proto-loader (keepCase) -> plain object.
 * @param {any} struct
 * @returns {Record<string, unknown>}
 */
export function structToObject(struct) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(struct?.fields ?? {})) out[k] = valueToJs(v);
  return out;
}

/** @param {any} v @returns {unknown} */
function valueToJs(v) {
  if (!v || typeof v !== 'object') return undefined;
  switch (v.kind) {
    case 'nullValue': return null;
    case 'numberValue': return v.numberValue;
    case 'stringValue': return v.stringValue;
    case 'boolValue': return v.boolValue;
    case 'structValue': return structToObject(v.structValue);
    case 'listValue': return (v.listValue?.values ?? []).map(valueToJs);
    default: return undefined;
  }
}
