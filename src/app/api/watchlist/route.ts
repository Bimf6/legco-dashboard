import { NextResponse } from "next/server";
import { requireIdentity } from "../../../../cursor/identity";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

const ALLOWED_TYPES = new Set(["committee", "keyword", "member"]);

export async function POST(request: Request) {
  const identity = await requireIdentity(request);
  if (identity instanceof Response) return identity;

  if (request.headers.get("x-legco-client") !== "1") {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    ruleType?: unknown;
    value?: unknown;
    label?: unknown;
  } | null;

  const ruleType = typeof body?.ruleType === "string" ? body.ruleType.trim() : "";
  const value = typeof body?.value === "string" ? body.value.trim() : "";
  const label = typeof body?.label === "string" ? body.label.trim() : value;

  if (!ALLOWED_TYPES.has(ruleType) || value.length < 2 || value.length > 120) {
    return NextResponse.json({ error: "Invalid watchlist rule" }, { status: 400 });
  }

  const rows = await sql(
    `insert into watchlist_rules (viewer_sub, rule_type, value, label)
     values ($1, $2, $3, $4)
     on conflict (viewer_sub, rule_type, value) do update set label = excluded.label
     returning id, rule_type, value, label, created_at`,
    [identity.sub, ruleType, value, label.slice(0, 140)],
  );

  return NextResponse.json(
    { rule: rows[0] },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export async function DELETE(request: Request) {
  const identity = await requireIdentity(request);
  if (identity instanceof Response) return identity;

  if (request.headers.get("x-legco-client") !== "1") {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const id = Number(searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid rule id" }, { status: 400 });
  }

  await sql("delete from watchlist_rules where id = $1 and viewer_sub = $2", [
    id,
    identity.sub,
  ]);

  return NextResponse.json({ ok: true }, { headers: { "cache-control": "private, no-store" } });
}
