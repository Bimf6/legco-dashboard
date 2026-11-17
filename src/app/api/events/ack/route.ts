import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/access-gate";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return auth.response;

  if (request.headers.get("x-legco-client") !== "1") {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  await sql(
    `insert into viewer_ack_state (viewer_sub, last_ack_at)
     values ($1, now())
     on conflict (viewer_sub) do update set last_ack_at = now()`,
    [auth.viewerSub],
  );

  return NextResponse.json(
    { ok: true },
    { headers: { "cache-control": "private, no-store" } },
  );
}
