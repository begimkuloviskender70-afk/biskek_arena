import { authUnavailable, finishSteamLogin } from "@/lib/auth";

export async function GET(request: Request) {
  try { return await finishSteamLogin(request); } catch { return authUnavailable(); }
}
