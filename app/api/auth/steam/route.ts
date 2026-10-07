import { authUnavailable, startSteamLogin } from "@/lib/auth";

export async function GET(request: Request) {
  try { return await startSteamLogin(request); } catch { return authUnavailable(); }
}
