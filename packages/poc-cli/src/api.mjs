// Small client for the hosted MetaMynd API (https://metamynd.ai/api/v1 by default).
export class ApiError extends Error {
  /** @param {string} message @param {number} status @param {unknown} body */
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** @param {string} [base] */
export function createApi(base = process.env.MM_API ?? 'https://metamynd.ai/api/v1') {
  const root = base.replace(/\/$/, '');
  /** @type {string | undefined} */
  let token;

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {{ allow?: number[] }} [opts] non-2xx statuses to return rather than throw
   */
  async function call(method, path, body, opts = {}) {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok && !(opts.allow ?? []).includes(res.status)) {
      throw new ApiError(`${method} ${path} -> ${res.status}: ${json?.message ?? json?.data?.reasonCode ?? 'error'}`, res.status, json);
    }
    return { status: res.status, json };
  }

  return {
    base: root,
    /** @param {string} username @param {string} password */
    async login(username, password) {
      const { json } = await call('POST', '/auth/login', { username, password });
      token = json?.data?.accessToken;
      if (!token) throw new ApiError('login returned no accessToken', 200, json);
    },
    call,
  };
}
