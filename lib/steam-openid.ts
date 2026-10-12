/** Pure protocol helpers. No user identity is trusted until Steam verifies the signature. */
export const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
export const OPENID_NAMESPACE = "http://specs.openid.net/auth/2.0";
export const PUBLIC_SITE_ORIGIN = "https://bishkek-arena-cs2.beautips5kg.chatgpt.site";
export const AUTH_STATE_TTL = 10 * 60;
export const SESSION_TTL = 14 * 24 * 60 * 60;

export class SteamAuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "SteamAuthError";
    this.code = code;
  }
}

export function canonicalOrigin(requestUrl: string, configuredOrigin?: string, development = false): string {
  const request = new URL(requestUrl);
  // localhost is usable only in explicit development, never via forwarded headers.
  if (!configuredOrigin && development && request.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(request.hostname)) return request.origin;
  const origin = configuredOrigin || PUBLIC_SITE_ORIGIN;
  let configured: URL;
  try { configured = new URL(origin); } catch { throw new SteamAuthError("site_configuration"); }
  if (configured.origin !== PUBLIC_SITE_ORIGIN || configured.pathname !== "/" ||
      configured.search || configured.hash || configured.username || configured.password) {
    throw new SteamAuthError("site_configuration");
  }
  if (request.origin !== configured.origin) throw new SteamAuthError("invalid_origin");
  return configured.origin;
}

export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const url = new URL(value, PUBLIC_SITE_ORIGIN);
    if (url.origin !== PUBLIC_SITE_ORIGIN || url.pathname.startsWith("/api/") ||
        ["/signin-with-chatgpt", "/signout-with-chatgpt", "/callback"].includes(url.pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/"; }
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readCookie(request: Request, name: string): string | null {
  const matches = (request.headers.get("cookie") || "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  // Ambiguous cookies are rejected, not resolved using attacker-controlled ordering.
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

export function cookieName(kind: "session" | "state", origin: string): string {
  return `${origin.startsWith("https:") ? "__Host-" : ""}ba_${kind}`;
}

export function authCookie(kind: "session" | "state", value: string, origin: string, maxAge: number): string {
  return `${cookieName(kind, origin)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
}

export function steamLoginUrl(origin: string, state: string): { url: string; returnTo: string } {
  if (!/^[a-f0-9]{64}$/.test(state)) throw new SteamAuthError("invalid_state");
  const returnTo = `${origin}/api/auth/steam/callback?state=${state}`;
  const url = new URL(STEAM_OPENID_ENDPOINT);
  url.search = new URLSearchParams({
    "openid.ns": OPENID_NAMESPACE,
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": `${origin}/`,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  }).toString();
  return { url: url.toString(), returnTo };
}

export type ValidatedSteamAssertion = {
  steamId: string;
  nonce: string;
  verificationBody: URLSearchParams;
};

export function validateSteamAssertion(
  params: URLSearchParams,
  expectedReturnTo: string,
  now = Date.now(),
): ValidatedSteamAssertion {
  for (const name of params.keys()) {
    if (params.getAll(name).length !== 1) throw new SteamAuthError("duplicate_parameter");
  }
  if (params.get("openid.ns") !== OPENID_NAMESPACE || params.get("openid.mode") !== "id_res") {
    throw new SteamAuthError("invalid_assertion");
  }
  if (params.get("openid.op_endpoint") !== STEAM_OPENID_ENDPOINT) throw new SteamAuthError("invalid_provider");
  if (params.get("openid.return_to") !== expectedReturnTo) throw new SteamAuthError("invalid_return_to");
  const expected = new URL(expectedReturnTo);
  if (params.get("state") !== expected.searchParams.get("state") || !/^[a-f0-9]{64}$/.test(params.get("state") || "")) {
    throw new SteamAuthError("invalid_state");
  }
  const claimedId = params.get("openid.claimed_id") || "";
  const match = /^https:\/\/steamcommunity\.com\/openid\/id\/([0-9]{17})$/.exec(claimedId);
  if (!match || params.get("openid.identity") !== claimedId) throw new SteamAuthError("invalid_identity");
  const signature = params.get("openid.sig") || "";
  if (!/^[A-Za-z0-9+/]{16,1024}={0,2}$/.test(signature)) throw new SteamAuthError("missing_signature");
  const fields = (params.get("openid.signed") || "").split(",");
  if (new Set(fields).size !== fields.length || fields.some((field) => !/^[a-z0-9_.]+$/.test(field))) {
    throw new SteamAuthError("invalid_signed_fields");
  }
  for (const field of ["op_endpoint", "claimed_id", "identity", "return_to", "response_nonce", "assoc_handle"]) {
    if (!fields.includes(field) || !params.get(`openid.${field}`)) throw new SteamAuthError("unsigned_field");
  }
  const nonce = params.get("openid.response_nonce") || "";
  const timestamp = nonce.slice(0, 20);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp) || nonce.length <= 20 || nonce.length > 255) {
    throw new SteamAuthError("invalid_nonce");
  }
  const nonceTime = Date.parse(timestamp);
  if (!Number.isFinite(nonceTime) || now - nonceTime > AUTH_STATE_TTL * 1000 || nonceTime - now > 60_000) {
    throw new SteamAuthError("expired_nonce");
  }
  const verificationBody = new URLSearchParams();
  for (const [key, value] of params) if (key.startsWith("openid.")) verificationBody.set(key, value);
  verificationBody.set("openid.mode", "check_authentication");
  return { steamId: match[1], nonce, verificationBody };
}

export function verifiedSteamResponse(body: string): boolean {
  if (body.length > 8192) return false;
  const result = new Map<string, string>();
  for (const line of body.trim().split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) return false;
    const key = line.slice(0, separator);
    if (result.has(key)) return false;
    result.set(key, line.slice(separator + 1));
  }
  return result.get("is_valid") === "true" && result.get("ns") === OPENID_NAMESPACE;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyWithSteam(assertion: ValidatedSteamAssertion): Promise<void> {
  const response = await fetchWithTimeout(STEAM_OPENID_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: assertion.verificationBody.toString(),
    // workerd rejects redirect:"error" before sending the request. Do not follow
    // redirects: the response.ok check below rejects every 3xx response instead.
    redirect: "manual",
  }, 10_000);
  if (!response.ok || !verifiedSteamResponse(await response.text())) throw new SteamAuthError("verification_failed");
}
