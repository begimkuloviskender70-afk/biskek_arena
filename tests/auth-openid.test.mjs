import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_STATE_TTL, OPENID_NAMESPACE, PUBLIC_SITE_ORIGIN, STEAM_OPENID_ENDPOINT,
  authCookie, canonicalOrigin, hashToken, randomToken, readCookie, safeReturnPath,
  steamLoginUrl, validateSteamAssertion, verifiedSteamResponse, verifyWithSteam,
} from "../lib/steam-openid.ts";

const state = "a".repeat(64);
const now = Date.parse("2026-10-05T11:00:00Z");
const returnTo = steamLoginUrl(PUBLIC_SITE_ORIGIN, state).returnTo;
function validParams() {
  return new URLSearchParams({
    state,
    "openid.ns": OPENID_NAMESPACE,
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
    "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198012345678",
    "openid.identity": "https://steamcommunity.com/openid/id/76561198012345678",
    "openid.return_to": returnTo,
    "openid.response_nonce": "2026-10-05T11:00:00Zunique-nonce",
    "openid.assoc_handle": "association",
    "openid.signed": "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "a".repeat(28) + "=",
  });
}

test("only the pinned production origin or explicit development localhost is accepted", () => {
  assert.equal(canonicalOrigin(`${PUBLIC_SITE_ORIGIN}/api/auth/steam`), PUBLIC_SITE_ORIGIN);
  assert.equal(canonicalOrigin("http://localhost:3000/a", undefined, true), "http://localhost:3000");
  for (const url of ["https://evil.example/", "https://bishkek-arena-cs2.racing-trout-8976.chatgpt.site.evil.example/", "http://localhost:3000/"]) {
    assert.throws(() => canonicalOrigin(url));
  }
  assert.throws(() => canonicalOrigin(PUBLIC_SITE_ORIGIN, "https://evil.example"));
  assert.throws(() => canonicalOrigin(PUBLIC_SITE_ORIGIN, `${PUBLIC_SITE_ORIGIN}/bad`));
});

test("return paths cannot redirect to external origins or reserved authentication handlers", () => {
  for (const path of ["//evil.example", "https://evil.example", "/\\evil.example", "/api/auth/steam", "/signin-with-chatgpt", "/x\nLocation: https://evil.example", null]) {
    assert.equal(safeReturnPath(path), "/");
  }
  assert.equal(safeReturnPath("/?invite=ABC#team"), "/?invite=ABC#team");
});

test("Steam login request binds the state into the exact return_to", () => {
  const login = steamLoginUrl(PUBLIC_SITE_ORIGIN, state);
  const request = new URL(login.url);
  assert.equal(`${request.origin}${request.pathname}`, STEAM_OPENID_ENDPOINT);
  assert.equal(request.searchParams.get("openid.return_to"), returnTo);
  assert.equal(request.searchParams.get("openid.realm"), `${PUBLIC_SITE_ORIGIN}/`);
  assert.throws(() => steamLoginUrl(PUBLIC_SITE_ORIGIN, "bad"));
});

test("valid assertion produces a fixed-endpoint verification body, never an authenticated session itself", () => {
  const assertion = validateSteamAssertion(validParams(), returnTo, now);
  assert.equal(assertion.steamId, "76561198012345678");
  assert.equal(assertion.verificationBody.get("openid.mode"), "check_authentication");
  assert.equal(assertion.verificationBody.has("state"), false);
});

test("forged endpoints, identities, states, return URLs and missing signatures fail closed", () => {
  const bad = [
    ["openid.op_endpoint", "https://evil.example/openid"],
    ["openid.op_endpoint", "http://steamcommunity.com/openid/login"],
    ["openid.claimed_id", "https://steamcommunity.com.evil.example/openid/id/76561198012345678"],
    ["openid.identity", "https://steamcommunity.com/openid/id/76561198000000000"],
    ["openid.return_to", "https://evil.example/"],
    ["state", "b".repeat(64)],
    ["openid.sig", ""],
    ["openid.signed", "identity,return_to,response_nonce,assoc_handle"],
    ["openid.signed", "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle,identity"],
    ["openid.mode", "check_authentication"],
    ["openid.ns", "http://invalid.example"],
  ];
  for (const [key, value] of bad) {
    const params = validParams(); params.set(key, value);
    assert.throws(() => validateSteamAssertion(params, returnTo, now), undefined, key);
  }
});

test("duplicate query fields and stale or future nonces are rejected", () => {
  const duplicate = validParams(); duplicate.append("openid.identity", "https://evil.example");
  assert.throws(() => validateSteamAssertion(duplicate, returnTo, now));
  assert.throws(() => validateSteamAssertion(validParams(), returnTo, now + AUTH_STATE_TTL * 1000 + 1));
  assert.throws(() => validateSteamAssertion(validParams(), returnTo, now - 60_001));
  const invalid = validParams(); invalid.set("openid.response_nonce", "invalid");
  assert.throws(() => validateSteamAssertion(invalid, returnTo, now));
});

test("only an unambiguous affirmative Steam verification response is accepted", () => {
  assert.equal(verifiedSteamResponse(`ns:${OPENID_NAMESPACE}\nis_valid:true\n`), true);
  for (const text of ["is_valid:true", `ns:${OPENID_NAMESPACE}\nis_valid:false`, `ns:${OPENID_NAMESPACE}\nis_valid:false\nis_valid:true`, `ns:${OPENID_NAMESPACE}\nfoo:is_valid:true`, "<html>is_valid:true</html>"]) {
    assert.equal(verifiedSteamResponse(text), false);
  }
});

test("signature verification posts only to Steam, disables redirects and rejects provider denial", async (context) => {
  const assertion = validateSteamAssertion(validParams(), returnTo, now);
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, STEAM_OPENID_ENDPOINT);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(new URLSearchParams(options.body).get("openid.mode"), "check_authentication");
    return new Response(`ns:${OPENID_NAMESPACE}\nis_valid:false\n`);
  });
  await assert.rejects(verifyWithSteam(assertion));
});

test("opaque secrets use 256 random bits, hashes are irreversible identifiers, cookies are secured", async () => {
  const first = randomToken(), second = randomToken();
  assert.match(first, /^[a-f0-9]{64}$/); assert.notEqual(first, second);
  assert.notEqual(await hashToken(first), first);
  assert.equal(await hashToken(first), await hashToken(first));
  const cookie = authCookie("session", first, PUBLIC_SITE_ORIGIN, 100);
  assert.match(cookie, /^__Host-ba_session=/);
  for (const flag of ["Path=/", "HttpOnly", "SameSite=Lax", "Secure", "Max-Age=100"]) assert.ok(cookie.includes(flag));
  assert.equal(readCookie(new Request(PUBLIC_SITE_ORIGIN, { headers: { cookie: "ba_state=a; ba_state=b" } }), "ba_state"), null);
});
