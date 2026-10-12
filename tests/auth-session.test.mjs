import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { OPENID_NAMESPACE, PUBLIC_SITE_ORIGIN, STEAM_OPENID_ENDPOINT } from "../lib/steam-openid.ts";

// Exercise the actual auth implementation against SQLite, with only the Worker binding
// and external HTTP boundary replaced. No signing keys or real Steam credentials are used.
const testEnv = {};
globalThis.__bishkekAuthTestEnv = testEnv;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const envModule = moduleUrl("export const env = globalThis.__bishkekAuthTestEnv;");
const faceitSource = stripTypeScriptTypes(await readFile(new URL("../lib/faceit.ts", import.meta.url), "utf8"));
const faceitModule = moduleUrl(faceitSource.replace('"cloudflare:workers"', JSON.stringify(envModule)));
const authSource = stripTypeScriptTypes(await readFile(new URL("../lib/auth.ts", import.meta.url), "utf8"));
const authModule = moduleUrl(authSource
  .replace('"cloudflare:workers"', JSON.stringify(envModule))
  .replace('"./steam-openid"', JSON.stringify(new URL("../lib/steam-openid.ts", import.meta.url).href))
  .replace('"./faceit"', JSON.stringify(faceitModule)));
const { startSteamLogin, finishSteamLogin, getCurrentUser, logout, assertSameOrigin } = await import(authModule);
const { syncFaceit } = await import(faceitModule);

function database() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, steam_id TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL, avatar TEXT, faceit_id TEXT, faceit_level INTEGER, faceit_elo INTEGER, faceit_updated_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE auth_states (state_hash TEXT PRIMARY KEY, cookie_hash TEXT NOT NULL, return_to TEXT NOT NULL, redirect_to TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE openid_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  `);
  const db = {
    sql,
    prepare(query) {
      let bindings = [];
      const statement = {
        bind(...values) { bindings = values; return statement; },
        async first() { return sql.prepare(query).get(...bindings) ?? null; },
        async run() {
          const results = sql.prepare(query).all(...bindings);
          return { results, meta: { changes: sql.prepare("SELECT changes() AS value").get().value } };
        },
      };
      return statement;
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const output = [];
        for (const statement of statements) output.push(await statement.run());
        sql.exec("COMMIT"); return output;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  return db;
}

async function start(returnPath = "/") {
  const response = await startSteamLogin(new Request(`${PUBLIC_SITE_ORIGIN}/api/auth/steam?returnTo=${encodeURIComponent(returnPath)}`));
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location"));
  return {
    cookie: response.headers.get("set-cookie").split(";")[0],
    returnTo: location.searchParams.get("openid.return_to"),
  };
}

function callback(login, nonce = `${new Date().toISOString().slice(0, 19)}Znonce-${crypto.randomUUID()}`) {
  const url = new URL(login.returnTo);
  const params = {
    "openid.ns": OPENID_NAMESPACE, "openid.mode": "id_res", "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
    "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198012345678",
    "openid.identity": "https://steamcommunity.com/openid/id/76561198012345678",
    "openid.return_to": login.returnTo, "openid.response_nonce": nonce, "openid.assoc_handle": "test-association",
    "openid.signed": "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle", "openid.sig": "a".repeat(28) + "=",
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, { headers: { cookie: login.cookie } });
}

function init(context) {
  const db = database();
  testEnv.DB = db; delete testEnv.STEAM_WEB_API_KEY; delete testEnv.FACEIT_API_KEY;
  context.after(() => db.sql.close());
  context.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, STEAM_OPENID_ENDPOINT);
    return new Response(`ns:${OPENID_NAMESPACE}\nis_valid:true\n`);
  });
  return db;
}

test("a verified callback creates one account, sets an opaque session, preserves an invitation and logs out", async (context) => {
  const db = init(context);
  const login = await start("/?invite=team-token");
  const request = callback(login);
  const response = await finishSteamLogin(request);
  assert.equal(response.headers.get("location"), `${PUBLIC_SITE_ORIGIN}/?invite=team-token`);
  const sessionCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-ba_session="));
  assert.ok(sessionCookie);
  const signedIn = new Request(PUBLIC_SITE_ORIGIN, { headers: { cookie: sessionCookie.split(";")[0] } });
  const user = await getCurrentUser(signedIn);
  assert.equal(user.steam_id, "76561198012345678");
  assert.equal(user.faceit_level, null);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  const rawToken = sessionCookie.split(";")[0].split("=")[1];
  assert.notEqual(db.sql.prepare("SELECT token_hash FROM sessions").get().token_hash, rawToken);
  const replay = await finishSteamLogin(request);
  assert.match(replay.headers.get("location"), /auth_error=steam_error$/);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);
  const loggedOut = await logout(new Request(`${PUBLIC_SITE_ORIGIN}/api/auth/logout`, {
    method: "POST", headers: { origin: PUBLIC_SITE_ORIGIN, cookie: sessionCookie.split(";")[0] },
  }));
  assert.equal(loggedOut.status, 200);
  assert.equal(await getCurrentUser(signedIn), null);
});

test("a wrong browser cookie cannot consume another browser's login state", async (context) => {
  const db = init(context);
  const login = await start();
  const response = await finishSteamLogin(callback({ ...login, cookie: `__Host-ba_state=${"b".repeat(64)}` }));
  assert.match(response.headers.get("location"), /auth_error=steam_error$/);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS count FROM auth_states").get().count, 1);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
});

test("provider rejection does not create a user or consume valid pending state", async (context) => {
  const db = init(context);
  context.mock.method(globalThis, "fetch", async () => new Response(`ns:${OPENID_NAMESPACE}\nis_valid:false\n`));
  const response = await finishSteamLogin(callback(await start()));
  assert.match(response.headers.get("location"), /auth_error=steam_error$/);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS count FROM auth_states").get().count, 1);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("a previously accepted nonce cannot authenticate a different pending state", async (context) => {
  const db = init(context);
  const nonce = `${new Date().toISOString().slice(0, 19)}Zsame-nonce`;
  await finishSteamLogin(callback(await start(), nonce));
  const response = await finishSteamLogin(callback(await start(), nonce));
  assert.match(response.headers.get("location"), /auth_error=steam_error$/);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);
});

test("expired state and expired sessions cannot authenticate", async (context) => {
  const db = init(context);
  const login = await start();
  db.sql.prepare("UPDATE auth_states SET expires_at = ?").run(Date.now() - 1);
  const response = await finishSteamLogin(callback(login));
  assert.match(response.headers.get("location"), /auth_error=steam_error$/);
  const validResponse = await finishSteamLogin(callback(await start()));
  const cookie = validResponse.headers.getSetCookie().find((item) => item.startsWith("__Host-ba_session=")).split(";")[0];
  db.sql.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() - 1);
  assert.equal(await getCurrentUser(new Request(PUBLIC_SITE_ORIGIN, { headers: { cookie } })), null);
});

test("writes require the exact Origin even with a valid same-site request URL", () => {
  for (const origin of ["https://evil.example", "null", ""]) {
    assert.throws(() => assertSameOrigin(new Request(`${PUBLIC_SITE_ORIGIN}/api/auth/logout`, { method: "POST", headers: { origin } })));
  }
  assert.doesNotThrow(() => assertSameOrigin(new Request(`${PUBLIC_SITE_ORIGIN}/api/auth/logout`, { method: "POST", headers: { origin: PUBLIC_SITE_ORIGIN } })));
});

test("FACEIT refresh verifies the Steam identity and preserves prior data on API failure", async (context) => {
  const db = init(context);
  await finishSteamLogin(callback(await start()));
  const user = db.sql.prepare("SELECT * FROM users").get();
  testEnv.FACEIT_API_KEY = "test-only-key";
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).searchParams.get("game_player_id"), user.steam_id);
    assert.equal(options.redirect, "manual");
    return Response.json({ player_id: "faceit-test-user", steam_id_64: user.steam_id, games: { cs2: { game_player_id: user.steam_id, skill_level: 7, faceit_elo: 1700 } } });
  });
  await syncFaceit(db, user);
  assert.equal(db.sql.prepare("SELECT faceit_level FROM users").get().faceit_level, 7);
  context.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(syncFaceit(db, user));
  assert.equal(db.sql.prepare("SELECT faceit_elo FROM users").get().faceit_elo, 1700);
  context.mock.method(globalThis, "fetch", async () => Response.json({ player_id: "faceit-test-user", games: { cs2: { game_player_id: "76561198099999999", skill_level: 10, faceit_elo: 3000 } } }));
  await assert.rejects(syncFaceit(db, user), { code: "identity_mismatch" });
  assert.equal(db.sql.prepare("SELECT faceit_level FROM users").get().faceit_level, 7);
});
