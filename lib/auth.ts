import { env } from "cloudflare:workers";
import type { User } from "./types";
import {
  AUTH_STATE_TTL, SESSION_TTL, SteamAuthError, authCookie, canonicalOrigin, cookieName,
  hashToken, randomToken, readCookie, safeReturnPath, steamLoginUrl, validateSteamAssertion, verifyWithSteam,
} from "./steam-openid";
import { syncFaceit } from "./faceit";

const NO_CACHE = { "Cache-Control": "no-store, private", Pragma: "no-cache", "Referrer-Policy": "no-referrer" };

export function getAuthOrigin(request: Request): string {
  return canonicalOrigin(request.url, (env as Cloudflare.Env).SITE_URL, process.env.NODE_ENV === "development");
}

function authDb(): D1Database {
  if (!env.DB) throw new SteamAuthError("database_unavailable");
  return env.DB;
}

export function assertSameOrigin(request: Request): void {
  let origin: string;
  try { origin = getAuthOrigin(request); } catch {
    throw Response.json({ error: "Запрос отправлен с неподдерживаемого адреса." }, { status: 403, headers: NO_CACHE });
  }
  if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw Response.json({ error: "Запрос отклонён. Откройте сайт заново и повторите действие." }, { status: 403, headers: NO_CACHE });
  }
}

export async function getCurrentUser(request: Request): Promise<User | null> {
  const origin = getAuthOrigin(request);
  const token = readCookie(request, cookieName("session", origin));
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return authDb().prepare("SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1")
    .bind(await hashToken(token), Date.now()).first<User>();
}

function redirect(url: string, cookies: string[] = []): Response {
  const headers = new Headers({ ...NO_CACHE, Location: url });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export async function startSteamLogin(request: Request): Promise<Response> {
  const origin = getAuthOrigin(request);
  const db = authDb();
  const state = randomToken();
  const verifier = randomToken();
  const login = steamLoginUrl(origin, state);
  const returnPath = safeReturnPath(new URL(request.url).searchParams.get("returnTo"));
  const now = Date.now();
  const [stateHash, cookieHash] = await Promise.all([hashToken(state), hashToken(verifier)]);
  await db.batch([
    db.prepare("DELETE FROM auth_states WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM openid_nonces WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("INSERT INTO auth_states (state_hash, cookie_hash, return_to, redirect_to, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(stateHash, cookieHash, login.returnTo, returnPath, now + AUTH_STATE_TTL * 1000),
  ]);
  return redirect(login.url, [authCookie("state", verifier, origin, AUTH_STATE_TTL)]);
}

type AuthState = { state_hash: string; cookie_hash: string; return_to: string; redirect_to: string; expires_at: number };

async function enrichSteamProfile(db: D1Database, user: User): Promise<void> {
  const key = (env as Cloudflare.Env).STEAM_WEB_API_KEY;
  if (!key) return;
  const endpoint = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
  endpoint.search = new URLSearchParams({ key, steamids: user.steam_id }).toString();
  const response = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(6_000) });
  if (!response.ok) return;
  const data = await response.json() as { response?: { players?: { steamid?: string; personaname?: string; avatarfull?: string }[] } };
  const profile = data.response?.players?.find((player) => player.steamid === user.steam_id);
  if (!profile) return;
  const nickname = typeof profile.personaname === "string" ? profile.personaname.trim().slice(0, 48) : "";
  let avatar: string | null = null;
  if (typeof profile.avatarfull === "string") {
    try {
      const url = new URL(profile.avatarfull);
      if (url.protocol === "https:" && (url.hostname.endsWith(".steamstatic.com") || url.hostname.endsWith(".steamcdn-a.akamaihd.net")) &&
          !url.username && !url.password) avatar = url.toString();
    } catch { /* Keep the local initials avatar if Steam sends an unexpected URL. */ }
  }
  if (nickname) await db.prepare("UPDATE users SET nickname = CASE WHEN nickname = ? THEN ? ELSE nickname END, avatar = COALESCE(?, avatar) WHERE id = ?")
    .bind(`Игрок ${user.steam_id.slice(-6)}`, nickname, avatar, user.id).run();
}

export async function finishSteamLogin(request: Request): Promise<Response> {
  const origin = getAuthOrigin(request);
  const clearState = authCookie("state", "", origin, 0);
  const params = new URL(request.url).searchParams;
  try {
    if (request.url.length > 16_384) throw new SteamAuthError("invalid_assertion");
    const state = params.get("state") || "";
    const verifier = readCookie(request, cookieName("state", origin)) || "";
    if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(verifier)) throw new SteamAuthError("invalid_state");
    const db = authDb();
    const [stateHash, cookieHash] = await Promise.all([hashToken(state), hashToken(verifier)]);
    const pending = await db.prepare("SELECT * FROM auth_states WHERE state_hash = ? AND cookie_hash = ? AND expires_at > ?")
      .bind(stateHash, cookieHash, Date.now()).first<AuthState>();
    if (!pending) throw new SteamAuthError("expired_state");
    if (params.get("openid.mode") === "cancel") {
      await db.prepare("DELETE FROM auth_states WHERE state_hash = ? AND cookie_hash = ?").bind(stateHash, cookieHash).run();
      return redirect(`${origin}/?auth_error=cancelled`, [clearState]);
    }
    const expectedReturnTo = steamLoginUrl(origin, state).returnTo;
    if (pending.return_to !== expectedReturnTo) throw new SteamAuthError("invalid_return_to");
    const assertion = validateSteamAssertion(params, expectedReturnTo);
    await verifyWithSteam(assertion);
    const now = Date.now();
    // Both changes run transactionally. Only one concurrent callback can consume the
    // browser-bound state, and a nonce must have been inserted exactly once.
    const consumed = await db.batch([
      db.prepare("INSERT OR IGNORE INTO openid_nonces (nonce, expires_at) VALUES (?, ?)")
        .bind(await hashToken(assertion.nonce), now + AUTH_STATE_TTL * 1000 + 60_000),
      db.prepare("DELETE FROM auth_states WHERE state_hash = ? AND cookie_hash = ? AND expires_at > ? RETURNING state_hash")
        .bind(stateHash, cookieHash, now),
    ]);
    if (consumed[0].meta.changes !== 1 || consumed[1].results.length !== 1) throw new SteamAuthError("replayed_assertion");
    await db.prepare("INSERT INTO users (id, steam_id, nickname, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(steam_id) DO NOTHING")
      .bind(crypto.randomUUID(), assertion.steamId, `Игрок ${assertion.steamId.slice(-6)}`, now).run();
    const user = await db.prepare("SELECT * FROM users WHERE steam_id = ?").bind(assertion.steamId).first<User>();
    if (!user) throw new SteamAuthError("account_unavailable");
    // Profile services are optional: authentication succeeds even if either service fails.
    await Promise.allSettled([enrichSteamProfile(db, user), syncFaceit(db, user)]);
    const token = randomToken();
    const previous = readCookie(request, cookieName("session", origin));
    const statements = [db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await hashToken(token), user.id, Date.now() + SESSION_TTL * 1000)];
    if (previous && /^[a-f0-9]{64}$/.test(previous)) statements.push(db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(previous)));
    await db.batch(statements);
    return redirect(`${origin}${safeReturnPath(pending.redirect_to)}`, [clearState, authCookie("session", token, origin, SESSION_TTL)]);
  } catch (error) {
    // Never echo provider parameters, database errors, signatures or credentials.
    // Keep a bounded reason in Worker logs so production callback failures can be diagnosed.
    const code = error instanceof SteamAuthError ? error.code : "unexpected";
    console.error("steam_auth_callback_failed", code);
    return redirect(`${origin}/?auth_error=steam_error`, [clearState]);
  }
}

export async function logout(request: Request): Promise<Response> {
  assertSameOrigin(request);
  const origin = getAuthOrigin(request);
  const token = readCookie(request, cookieName("session", origin));
  if (token && /^[a-f0-9]{64}$/.test(token)) await authDb().prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
  return Response.json({ ok: true }, { headers: { ...NO_CACHE, "Set-Cookie": authCookie("session", "", origin, 0) } });
}

export function authUnavailable(): Response {
  return Response.json({ error: "Вход временно недоступен. Повторите попытку позже." }, { status: 503, headers: NO_CACHE });
}
