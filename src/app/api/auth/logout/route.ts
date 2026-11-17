import { NextResponse } from "next/server";
import { PASSCODE_COOKIE_NAME } from "@/lib/access-gate";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (request.headers.get("x-legco-client") !== "1") {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  const res = NextResponse.json(
    { ok: true },
    { headers: { "cache-control": "private, no-store" } },
  );
  res.cookies.set(PASSCODE_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
