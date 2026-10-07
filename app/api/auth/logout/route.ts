import { authUnavailable, logout } from "@/lib/auth";

export async function POST(request: Request) {
  try { return await logout(request); } catch (error) { return error instanceof Response ? error : authUnavailable(); }
}
