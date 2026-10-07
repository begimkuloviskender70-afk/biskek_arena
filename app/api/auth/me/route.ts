import { authUnavailable, getCurrentUser } from "@/lib/auth";

export async function GET(request: Request) {
  try {
    return Response.json({ user: await getCurrentUser(request) }, { headers: { "Cache-Control": "no-store, private" } });
  } catch { return authUnavailable(); }
}
