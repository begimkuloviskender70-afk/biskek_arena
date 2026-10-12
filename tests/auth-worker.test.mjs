import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { OPENID_NAMESPACE, PUBLIC_SITE_ORIGIN, STEAM_OPENID_ENDPOINT } from "../lib/steam-openid.ts";

// Execute the real authentication code in workerd with real D1, not Node's fetch.
// Only the external Steam HTTP server is substituted. No production data is used.
test("Worker callback rejects redirects and denial, creates a session only after Steam verification", async (t) => {
  const modules = await Promise.all(["auth", "steam-openid", "faceit"].map(async (name) => ({
    type: "ESModule", path: `${name}.mjs`,
    contents: stripTypeScriptTypes(await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"))
      .replaceAll('"./steam-openid"', '"./steam-openid.mjs"')
      .replaceAll('"./faceit"', '"./faceit.mjs"'),
  })));
  let mode = "redirect";
  let providerCalls = 0;
  const mf = new Miniflare({
    compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"],
    modules: [{ type: "ESModule", path: "worker.mjs", contents: `
      import { startSteamLogin, finishSteamLogin, getCurrentUser } from "./auth.mjs";
      export default { async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/callback")) return finishSteamLogin(request);
        if (path.endsWith("/steam")) return startSteamLogin(request);
        return Response.json(await getCurrentUser(request));
      } };
    ` }, ...modules],
    outboundService: async (request) => {
      providerCalls++;
      assert.equal(request.url, STEAM_OPENID_ENDPOINT, "credentials must never follow a redirect");
      assert.equal(request.method, "POST");
      assert.equal(new URLSearchParams(await request.text()).get("openid.mode"), "check_authentication");
      if (mode === "redirect") return new WorkerResponse(null, { status: 302, headers: { Location: "https://untrusted.invalid/" } });
      return new WorkerResponse(`ns:${OPENID_NAMESPACE}\nis_valid:${mode === "success"}\n`);
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  const migration = await readFile(new URL("../drizzle/0000_marvelous_warpath.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.prepare(statement).run();
  }
  for (mode of ["redirect", "denied", "success"]) {
    const start = await mf.dispatchFetch(`${PUBLIC_SITE_ORIGIN}/api/auth/steam`, { redirect: "manual" });
    assert.equal(start.status, 303, await start.text());
    const cookie = start.headers.get("set-cookie").split(";")[0];
    const returnTo = new URL(start.headers.get("location")).searchParams.get("openid.return_to");
    const callback = new URL(returnTo);
    const fields = {
      "openid.ns": OPENID_NAMESPACE, "openid.mode": "id_res", "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
      "openid.claimed_id": "https://steamcommunity.com/openid/id/76561198012345678",
      "openid.identity": "https://steamcommunity.com/openid/id/76561198012345678",
      "openid.return_to": returnTo, "openid.response_nonce": `${new Date().toISOString().slice(0, 19)}Z${crypto.randomUUID()}`,
      "openid.assoc_handle": "test-association", "openid.sig": "a".repeat(28) + "=",
      "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    };
    for (const [key, value] of Object.entries(fields)) callback.searchParams.set(key, value);
    const before = providerCalls;
    const response = await mf.dispatchFetch(callback, { headers: { cookie }, redirect: "manual" });
    assert.equal(providerCalls, before + 1, "workerd must send exactly one verification request");
    if (mode !== "success") {
      assert.match(response.headers.get("location"), /auth_error=steam_error$/);
      assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM users").first("n"), 0);
      assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"), 0);
    } else {
      assert.equal(response.headers.get("location"), `${PUBLIC_SITE_ORIGIN}/`);
      const session = response.headers.getSetCookie().find((value) => value.startsWith("__Host-ba_session="));
      assert.ok(session, "successful verification issues a session cookie");
      const me = await mf.dispatchFetch(`${PUBLIC_SITE_ORIGIN}/api/auth/me`, { headers: { cookie: session.split(";")[0] } });
      assert.equal((await me.json()).steam_id, "76561198012345678");
      const replay = await mf.dispatchFetch(callback, { headers: { cookie }, redirect: "manual" });
      assert.match(replay.headers.get("location"), /auth_error=steam_error$/);
      assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"), 1);
    }
  }
});
