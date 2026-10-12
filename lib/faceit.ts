import { env } from "cloudflare:workers";
import type { User } from "./types";

export class FaceitError extends Error {
  readonly code: "not_configured" | "unavailable" | "identity_mismatch" | "invalid_response";
  constructor(code: "not_configured" | "unavailable" | "identity_mismatch" | "invalid_response") {
    super(code);
    this.name = "FaceitError";
    this.code = code;
  }
}

type FaceitPlayer = {
  player_id?: unknown;
  steam_id_64?: unknown;
  games?: { cs2?: { game_player_id?: unknown; skill_level?: unknown; faceit_elo?: unknown } };
};

/** Public data lookup by the authenticated Steam identity, not a user-provided FACEIT nickname. */
export async function syncFaceit(db: D1Database, user: User): Promise<void> {
  const key = (env as Cloudflare.Env).FACEIT_API_KEY;
  if (!key) throw new FaceitError("not_configured");
  // Login and manual refresh share this cooldown. An unavailable API never overwrites cached data.
  if (user.faceit_updated_at && Date.now() - user.faceit_updated_at < 15 * 60 * 1000) return;
  const endpoint = new URL("https://open.faceit.com/data/v4/players");
  endpoint.search = new URLSearchParams({ game: "cs2", game_player_id: user.steam_id }).toString();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(6_000),
    });
  } catch { throw new FaceitError("unavailable"); }
  if (response.status === 404) {
    await db.prepare("UPDATE users SET faceit_id = NULL, faceit_level = NULL, faceit_elo = NULL, faceit_updated_at = ? WHERE id = ?")
      .bind(Date.now(), user.id).run();
    return;
  }
  if (!response.ok) throw new FaceitError("unavailable");
  let player: FaceitPlayer;
  try { player = await response.json() as FaceitPlayer; } catch { throw new FaceitError("invalid_response"); }
  const game = player?.games?.cs2;
  if (!game || game.game_player_id !== user.steam_id ||
      (player.steam_id_64 && player.steam_id_64 !== user.steam_id)) throw new FaceitError("identity_mismatch");
  if (typeof player.player_id !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(player.player_id) ||
      typeof game.skill_level !== "number" || !Number.isInteger(game.skill_level) || game.skill_level < 1 || game.skill_level > 10 ||
      typeof game.faceit_elo !== "number" || !Number.isInteger(game.faceit_elo) || game.faceit_elo < 0 || game.faceit_elo > 100_000) {
    throw new FaceitError("invalid_response");
  }
  await db.prepare("UPDATE users SET faceit_id = ?, faceit_level = ?, faceit_elo = ?, faceit_updated_at = ? WHERE id = ?")
    .bind(player.player_id, game.skill_level, game.faceit_elo, Date.now(), user.id).run();
}
