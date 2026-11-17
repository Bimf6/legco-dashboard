import { NextResponse } from "next/server";
import { requireIdentity } from "../../../../cursor/identity";
import { sql } from "@/lib/db";
import { ensureFreshDataIfDue } from "@/lib/legco-sync";
import { getWorkingHoursStatus } from "@/lib/working-hours";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await requireIdentity(request);
  if (identity instanceof Response) return identity;

  await ensureFreshDataIfDue();

  const [meetings, events, documents, questions, watchlist, syncRows, ackRows] =
    await Promise.all([
      sql(
        `select meet_id, slot_id, committee_code, committee_name_en, committee_name_tc,
                subject_en, subject_tc, start_date_time, venue_code, venue_name_en,
                venue_name_tc, meeting_type_en, meeting_type_tc, agenda_url_en,
                agenda_url_tc, home_url_en, agenda_http_status, agenda_hash,
                agenda_items_json, is_live, webcast_url, cancelled, updated_at
         from meetings
         order by start_date_time asc`,
      ),
      sql(
        `select id, meet_id, event_type, severity, title_en, title_tc,
                summary_en, summary_tc, old_value, new_value, link_url,
                committee_name_en, committee_name_tc, detected_at
         from meeting_change_events
         order by detected_at desc, id desc
         limit 60`,
      ),
      sql(
        `select id, doc_key, paper_no, doc_type, source_kind,
                committee_name_en, committee_name_tc, title_en, title_tc,
                summary_en, summary_tc, url_en, url_tc, meeting_date,
                issue_date, reply_to_paper_no, related_paper_no, meet_id, published_at
         from documents
         order by published_at desc, id desc
         limit 180`,
      ),
      sql(
        `select id, question_key, stage, question_type, question_no, meeting_date,
                member_name_en, member_name_tc, subject_en, subject_tc,
                body_en, body_tc, agenda_url_en, agenda_url_tc,
                hansard_url_en, hansard_url_tc, updated_at
         from questions
         order by case when stage = 'upcoming' then 0 else 1 end asc,
                  meeting_date desc, question_no asc nulls last
         limit 120`,
      ),
      sql(
        `select id, rule_type, value, label, created_at
         from watchlist_rules
         where viewer_sub = $1
         order by created_at desc`,
        [identity.sub],
      ),
      sql(
        `select last_sync_at, last_success_at, last_mode, last_summary_json, last_error, is_syncing
         from sync_state where id = 1`,
      ),
      sql<{ last_ack_at: string }>(
        "select last_ack_at from viewer_ack_state where viewer_sub = $1",
        [identity.sub],
      ),
    ]);

  const lastAckAt = ackRows[0]?.last_ack_at ? Date.parse(ackRows[0].last_ack_at) : 0;
  const unreadCount = events.filter((e) => {
    const t = Date.parse(String(e.detected_at ?? ""));
    return !Number.isNaN(t) && t > lastAckAt;
  }).length;

  return NextResponse.json(
    {
      meetings,
      events,
      unreadCount,
      documents,
      questions,
      watchlist,
      syncState: syncRows[0] ?? null,
      workingHours: getWorkingHoursStatus(),
      viewer: {
        name: identity.kind === "person" ? identity.name || identity.email : identity.name,
        simulated: Boolean(identity.simulated),
      },
    },
    {
      headers: {
        "cache-control": "private, no-store",
      },
    },
  );
}
