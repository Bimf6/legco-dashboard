import { NextResponse } from "next/server";
import {
  createAccessCookieToken,
  isPasscodeConfigured,
  PASSCODE_COOKIE_NAME,
  verifyPasscodeCandidate,
} from "@/lib/access-gate";

export const dynamic = "force-dynamic";

const globalForRate = globalThis as unknown as {
  __legcoUnlockAttempts?: Map<string, { count: number; resetAt: number }>;
};

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000;

function getClientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0]?.trim() || "local";
}

export async function POST(request: Request) {
  if (request.headers.get("x-legco-client") !== "1") {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  if (!isPasscodeConfigured()) {
    return NextResponse.json(
      { error: "APP_PASSCODE is not configured on the server" },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }

  const attemptsMap = (globalForRate.__legcoUnlockAttempts ??= new Map());
  const ip = getClientIp(request);
  const now = Date.now();
  const record = attemptsMap.get(ip);

  if (record && record.resetAt > now && record.count >= MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: "Too many incorrect attempts. Try again in a few minutes." },
      { status: 429, headers: { "cache-control": "private, no-store" } },
    );
  }

  const body = (await request.json().catch(() => null)) as { passcode?: unknown } | null;
  const candidate = typeof body?.passcode === "string" ? body.passcode.trim() : "";

  if (!verifyPasscodeCandidate(candidate)) {
    const nextCount = record && record.resetAt > now ? record.count + 1 : 1;
    attemptsMap.set(ip, { count: nextCount, resetAt: now + WINDOW_MS });
    return NextResponse.json(
      { error: "Incorrect passcode" },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }

  attemptsMap.delete(ip);
  const token = createAccessCookieToken();
  if (!token) {
    return NextResponse.json({ error: "Failed to issue session" }, { status: 500 });
  }

  const isHttps =
    request.url.startsWith("https://") ||
    request.headers.get("x-forwarded-proto") === "https";

  const res = NextResponse.json(
    { ok: true },
    { headers: { "cache-control": "private, no-store" } },
  );
  res.cookies.set(PASSCODE_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps,
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
