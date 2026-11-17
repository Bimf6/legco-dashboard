import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/access-gate";
import { sql } from "@/lib/db";
import { runLegcoSync } from "@/lib/legco-sync";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await authorizeRequest(request);
  if (!auth.authorized) return auth.response;

  if (request.headers.get("x-legco-client") !== "1") {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  const rows = await sql<{ last_sync_at: string | null; is_syncing: boolean }>(
    "select last_sync_at, is_syncing from sync_state where id = 1",
  );
  const lastMs = rows[0]?.last_sync_at ? Date.parse(rows[0].last_sync_at) : 0;
  if (!rows[0]?.is_syncing && lastMs > 0 && Date.now() - lastMs < 20_000) {
    return NextResponse.json(
      { ok: true, throttled: true, message: "Synced within the last 20 seconds" },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  const summary = await runLegcoSync("manual");
  return NextResponse.json(
    { ok: true, summary },
    { headers: { "cache-control": "private, no-store" } },
  );
}
