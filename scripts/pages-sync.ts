import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "../src/lib/db";
import { runLegcoSync } from "../src/lib/legco-sync";
import {
  decryptJsonWithPasscode,
  type EncryptedSnapshotPayload,
  encryptJsonWithPasscode,
} from "../src/lib/static-crypto";
import { getWorkingHoursStatus } from "../src/lib/working-hours";

interface PersistedState {
  meetings: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  docKeys: string[];
  questionStates?: Array<{
    question_key: string;
    stage: string;
    question_type: string;
    question_no: number | null;
    meeting_date: string;
    content_hash: string | null;
  }>;
}

async function restorePreviousState(passcode: string, stateFilePath: string): Promise<void> {
  const prevUrl = process.env.PREV_STATE_URL?.trim() ?? "";
  let encPayload: EncryptedSnapshotPayload | null = null;

  try {
    const localRaw = await readFile(stateFilePath, "utf8");
    encPayload = JSON.parse(localRaw) as EncryptedSnapshotPayload;
  } catch {
    if (prevUrl) {
      try {
        const res = await fetch(`${prevUrl}?t=${Date.now()}`);
        if (res.ok) {
          encPayload = (await res.json()) as EncryptedSnapshotPayload;
        }
      } catch {
        // First deploy or unreachable Pages URL: start with fresh baseline
      }
    }
  }

  if (!encPayload) return;

  let state: PersistedState;
  try {
    state = await decryptJsonWithPasscode<PersistedState>(encPayload, passcode);
  } catch {
    console.log("pages-sync: previous state could not be decrypted with current passcode; starting fresh baseline.");
    return;
  }

  for (const m of state.meetings || []) {
    await sql(
      `insert into meetings (
        meet_id, slot_id, committee_code, committee_name_en, committee_name_tc,
        subject_en, subject_tc, start_date_time, venue_code, venue_name_en,
        venue_name_tc, meeting_type_en, meeting_type_tc, agenda_url_en, agenda_url_tc,
        home_url_en, agenda_http_status, agenda_hash, agenda_items_json, is_live,
        webcast_url, cancelled
      ) values (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19::jsonb, $20,
        $21, $22
      ) on conflict (meet_id) do nothing`,
      [
        m.meet_id,
        m.slot_id || "",
        m.committee_code || "",
        m.committee_name_en || "",
        m.committee_name_tc || "",
        m.subject_en || "",
        m.subject_tc || "",
        m.start_date_time || "",
        m.venue_code || "",
        m.venue_name_en || "",
        m.venue_name_tc || "",
        m.meeting_type_en || "",
        m.meeting_type_tc || "",
        m.agenda_url_en || "",
        m.agenda_url_tc || "",
        m.home_url_en || "",
        Number(m.agenda_http_status ?? 0),
        m.agenda_hash || null,
        JSON.stringify(m.agenda_items_json ?? []),
        Boolean(m.is_live),
        m.webcast_url || "",
        Boolean(m.cancelled),
      ],
    );
  }

  for (const ev of state.events || []) {
    await sql(
      `insert into meeting_change_events (
        meet_id, event_type, severity, title_en, title_tc,
        summary_en, summary_tc, old_value, new_value, link_url,
        committee_name_en, committee_name_tc, detected_at, fingerprint
      ) values (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13::timestamptz, $14
      ) on conflict (fingerprint) do nothing`,
      [
        ev.meet_id ?? null,
        ev.event_type,
        ev.severity || "normal",
        ev.title_en,
        ev.title_tc,
        ev.summary_en,
        ev.summary_tc,
        ev.old_value ?? null,
        ev.new_value ?? null,
        ev.link_url ?? null,
        ev.committee_name_en ?? null,
        ev.committee_name_tc ?? null,
        ev.detected_at,
        ev.fingerprint,
      ],
    );
  }

  for (const docKey of state.docKeys || []) {
    await sql(
      `insert into documents (doc_key, doc_type, source_kind, title_en, title_tc)
       values ($1, 'paper', 'restored', '', '')
       on conflict (doc_key) do nothing`,
      [docKey],
    );
  }

  for (const q of state.questionStates || []) {
    await sql(
      `insert into questions (
        question_key, stage, question_type, question_no, meeting_date,
        member_name_en, member_name_tc, subject_en, subject_tc, content_hash
      ) values ($1, $2, $3, $4, $5, '', '', '', '', $6)
      on conflict (question_key) do nothing`,
      [
        q.question_key,
        q.stage,
        q.question_type,
        q.question_no,
        q.meeting_date,
        q.content_hash,
      ],
    );
  }

  console.log(
    `pages-sync: restored ${state.meetings?.length ?? 0} meetings, ${state.docKeys?.length ?? 0} doc keys, ${state.questionStates?.length ?? 0} question states, and ${state.events?.length ?? 0} events for diffing.`,
  );
}

async function main() {
  const passcode = process.env.APP_PASSCODE?.trim() ?? "";
  if (!passcode) {
    throw new Error(
      "APP_PASSCODE environment variable is required to encrypt snapshot.enc.json for GitHub Pages.",
    );
  }

  const outDir = path.resolve("dist-pages");
  await mkdir(outDir, { recursive: true });
  const stateEncPath = path.join(outDir, "state.enc.json");

  await restorePreviousState(passcode, stateEncPath);

  const summary = await runLegcoSync("auto");

  const [meetings, events, documents, allDocKeys, questions, questionStates, syncRows] = await Promise.all([
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
              committee_name_en, committee_name_tc, detected_at, fingerprint
       from meeting_change_events
       order by detected_at desc, id desc
       limit 80`,
    ),
    sql(
      `select id, doc_key, paper_no, doc_type, source_kind,
              committee_name_en, committee_name_tc, title_en, title_tc,
              summary_en, summary_tc, url_en, url_tc, meeting_date,
              issue_date, reply_to_paper_no, related_paper_no, meet_id, published_at
       from documents
       order by published_at desc, id desc
       limit 200`,
    ),
    sql<{ doc_key: string }>("select doc_key from documents"),
    sql(
      `select id, question_key, stage, question_type, question_no, meeting_date,
              member_name_en, member_name_tc, subject_en, subject_tc,
              body_en, body_tc, agenda_url_en, agenda_url_tc,
              hansard_url_en, hansard_url_tc, reply_url_en, reply_url_tc, updated_at
       from questions
       order by case when stage = 'upcoming' then 0 else 1 end asc,
                case when stage = 'upcoming' then meeting_date end asc,
                meeting_date desc, question_no asc nulls last
       limit 160`,
    ),
    sql(
      `select question_key, stage, question_type, question_no, meeting_date, content_hash
       from questions`,
    ),
    sql(
      `select last_sync_at, last_success_at, last_mode, last_summary_json, last_error, is_syncing
       from sync_state where id = 1`,
    ),
  ]);

  const dashboardPayload = {
    meetings,
    events: events.map(({ fingerprint: _fp, ...rest }) => rest),
    unreadCount: events.length,
    documents,
    questions,
    watchlist: [],
    syncState: syncRows[0] ?? null,
    workingHours: getWorkingHoursStatus(),
    viewer: {
      name: "Teammate",
      simulated: false,
      passcodeEnabled: true,
    },
  };

  const encryptedSnapshot = await encryptJsonWithPasscode(dashboardPayload, passcode);
  const encryptedState = await encryptJsonWithPasscode(
    { meetings, events, docKeys: allDocKeys.map((r) => r.doc_key), questionStates },
    passcode,
  );

  await writeFile(
    path.join(outDir, "snapshot.enc.json"),
    JSON.stringify(encryptedSnapshot),
  );
  await writeFile(stateEncPath, JSON.stringify(encryptedState));

  console.log("pages-sync completed:", JSON.stringify(summary));
}

main().catch((err) => {
  console.error("pages-sync failed:", err);
  process.exit(1);
});
