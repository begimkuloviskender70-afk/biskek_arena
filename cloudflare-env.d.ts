declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    SITE_URL?: string;
    STEAM_WEB_API_KEY?: string;
    FACEIT_API_KEY?: string;
  }
}
