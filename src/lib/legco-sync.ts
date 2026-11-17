import { sql } from "./db";
import { fetchLegcoJson, fetchLegcoText, normalizeLegcoUrl } from "./legco-http";
import {
  AgendaItem,
  diffAgendaItems,
  parseCommitteeAgendaHtml,
  parseCouncilQuestionsFromAgenda,
} from "./parsers/agenda-parser";
import {
  harvestCommitteeBiPapers,
  resolvePapersBaseDirFromHomeUrl,
} from "./parsers/bi-papers-harvester";
import { fetchAllLegcoRssDocuments } from "./parsers/rss-parser";
import { getHktParts, getWorkingHoursStatus, isSyncDue } from "./working-hours";

interface ODataList<T> {
  value: T[];
}

interface TMeetingRow {
  meet_id: number;
  slot_id?: string;
  subject_eng: string;
  subject_chi: string;
  agenda_url_eng?: string;
  agenda_url_chi?: string;
  start_date_time: string;
  venue_code?: string;
  venue_name_eng?: string;
  venue_name_chi?: string;
  meeting_type_eng?: string;
  meeting_type_chi?: string;
}

interface TCommitteeRow {
  committee_id: string | number;
  committee_code: string;
  name_eng: string;
  name_chi: string;
  home_url_eng?: string;
}

interface VLiveMeetingRow {
  MeetingID?: string;
  name_eng?: string;
  name_chi?: string;
  start_date_time?: string;
  webcast_url?: string;
}

interface QuestionDbRow {
  Row: string;
  MeetingDate: string;
  SubjectName: string;
  BookmarkName: string;
  MemberName: string;
  HansardFileURL: string;
}

export interface SyncSummary {
  mode: "working_hours" | "off_hours" | "manual";
  meetingsSynced: number;
  agendasProbed: number;
  biCommitteesHarvested: number;
  documentsUpserted: number;
  questionsUpserted: number;
  eventsRecorded: number;
  durationMs: number;
}

const globalForSync = globalThis as unknown as {
  __legcoSyncPromise?: Promise<SyncSummary>;
};

function addDaysIso(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function matchCommitteeForMeeting(
  subjectEn: string,
  subjectTc: string,
  committees: TCommitteeRow[],
): TCommitteeRow | null {
  const normEn = subjectEn.toLowerCase();
  const normTc = subjectTc;
  let best: TCommitteeRow | null = null;
  let bestLen = 0;

  for (const c of committees) {
    const cEn = (c.name_eng || "").toLowerCase();
    const cTc = c.name_chi || "";
    if (cEn && normEn.includes(cEn) && cEn.length > bestLen) {
      best = c;
      bestLen = cEn.length;
    } else if (cTc && normTc.includes(cTc) && cTc.length > bestLen) {
      best = c;
      bestLen = cTc.length;
    }
  }
  return best;
}

async function recordEvent(params: {
  meetId?: number | null;
  eventType: string;
  severity?: "high" | "normal";
  titleEn: string;
  titleTc: string;
  summaryEn: string;
  summaryTc: string;
  oldValue?: string | null;
  newValue?: string | null;
  linkUrl?: string | null;
  committeeNameEn?: string | null;
  committeeNameTc?: string | null;
  fingerprint: string;
}): Promise<boolean> {
  const rows = await sql<{ id: number }>(
    `insert into meeting_change_events (
      meet_id, event_type, severity, title_en, title_tc,
      summary_en, summary_tc, old_value, new_value, link_url,
      committee_name_en, committee_name_tc, fingerprint
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    on conflict (fingerprint) do nothing
    returning id`,
    [
      params.meetId ?? null,
      params.eventType,
      params.severity ?? "normal",
      params.titleEn,
      params.titleTc,
      params.summaryEn,
      params.summaryTc,
      params.oldValue ?? null,
      params.newValue ?? null,
      params.linkUrl ?? null,
      params.committeeNameEn ?? null,
      params.committeeNameTc ?? null,
      params.fingerprint,
    ],
  );
  return rows.length > 0;
}

async function upsertDocument(doc: {
  docKey: string;
  paperNo?: string;
  docType: string;
  sourceKind: string;
  committeeNameEn?: string;
  committeeNameTc?: string;
  titleEn: string;
  titleTc: string;
  summaryEn?: string;
  summaryTc?: string;
  urlEn?: string;
  urlTc?: string;
  meetingDate?: string;
  issueDate?: string;
  replyToPaperNo?: string;
  relatedPaperNo?: string;
  meetId?: number | null;
  publishedAt?: string;
}): Promise<{ inserted: boolean }> {
  const existing = await sql<{ id: number }>(
    "select id from documents where doc_key = $1",
    [doc.docKey],
  );
  const inserted = existing.length === 0;

  await sql(
    `insert into documents (
      doc_key, paper_no, doc_type, source_kind,
      committee_name_en, committee_name_tc,
      title_en, title_tc, summary_en, summary_tc,
      url_en, url_tc, meeting_date, issue_date,
      reply_to_paper_no, related_paper_no, meet_id, published_at
    ) values (
      $1, $2, $3, $4,
      $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18::timestamptz
    )
    on conflict (doc_key) do update set
      paper_no = coalesce(nullif(excluded.paper_no, ''), documents.paper_no),
      doc_type = case when documents.doc_type = 'paper' then excluded.doc_type else documents.doc_type end,
      committee_name_en = coalesce(nullif(excluded.committee_name_en, ''), documents.committee_name_en),
      committee_name_tc = coalesce(nullif(excluded.committee_name_tc, ''), documents.committee_name_tc),
      title_en = case when length(excluded.title_en) > length(documents.title_en) then excluded.title_en else documents.title_en end,
      title_tc = case when length(excluded.title_tc) > length(documents.title_tc) then excluded.title_tc else documents.title_tc end,
      summary_en = coalesce(nullif(excluded.summary_en, ''), documents.summary_en),
      summary_tc = coalesce(nullif(excluded.summary_tc, ''), documents.summary_tc),
      url_en = coalesce(nullif(excluded.url_en, ''), documents.url_en),
      url_tc = coalesce(nullif(excluded.url_tc, ''), documents.url_tc),
      meeting_date = coalesce(nullif(excluded.meeting_date, ''), documents.meeting_date),
      issue_date = coalesce(nullif(excluded.issue_date, ''), documents.issue_date),
      reply_to_paper_no = coalesce(nullif(excluded.reply_to_paper_no, ''), documents.reply_to_paper_no),
      related_paper_no = coalesce(nullif(excluded.related_paper_no, ''), documents.related_paper_no),
      meet_id = coalesce(excluded.meet_id, documents.meet_id)`,
    [
      doc.docKey,
      doc.paperNo || "",
      doc.docType,
      doc.sourceKind,
      doc.committeeNameEn || "",
      doc.committeeNameTc || "",
      doc.titleEn || doc.titleTc || "LegCo Document",
      doc.titleTc || doc.titleEn || "立法會文件",
      doc.summaryEn || "",
      doc.summaryTc || "",
      doc.urlEn || "",
      doc.urlTc || "",
      doc.meetingDate || "",
      doc.issueDate || "",
      doc.replyToPaperNo || "",
      doc.relatedPaperNo || "",
      doc.meetId ?? null,
      doc.publishedAt || new Date().toISOString(),
    ],
  );

  return { inserted };
}

export async function ensureFreshDataIfDue(): Promise<void> {
  const rows = await sql<{ last_sync_at: string | null; is_syncing: boolean }>(
    "select last_sync_at, is_syncing from sync_state where id = 1",
  );
  const state = rows[0];
  if (!state || !state.last_sync_at || isSyncDue(state.last_sync_at)) {
    // Non-blocking background refresh if data already exists; blocking on cold start
    if (!state?.last_sync_at) {
      await runLegcoSync("auto");
    } else if (!globalForSync.__legcoSyncPromise) {
      void runLegcoSync("auto").catch(() => undefined);
    }
  }
}

export async function runLegcoSync(
  trigger: "auto" | "manual" = "auto",
): Promise<SyncSummary> {
  if (globalForSync.__legcoSyncPromise) {
    return globalForSync.__legcoSyncPromise;
  }

  const run = executeSync(trigger).finally(() => {
    globalForSync.__legcoSyncPromise = undefined;
  });
  globalForSync.__legcoSyncPromise = run;
  return run;
}

async function executeSync(trigger: "auto" | "manual"): Promise<SyncSummary> {
  const startedAt = Date.now();
  const wh = getWorkingHoursStatus();
  const mode = trigger === "manual" ? "manual" : wh.mode;

  await sql(
    "update sync_state set is_syncing = true, last_sync_at = now(), last_mode = $1, last_error = null where id = 1",
    [mode],
  );

  let meetingsSynced = 0;
  let agendasProbed = 0;
  let biCommitteesHarvested = 0;
  let documentsUpserted = 0;
  let questionsUpserted = 0;
  let eventsRecorded = 0;

  try {
    const hkt = getHktParts();
    const fromIso = addDaysIso(hkt.isoDate, -10);
    const toIso = addDaysIso(hkt.isoDate, 45);
    const probeFrom = addDaysIso(hkt.isoDate, -4);
    const probeTo = addDaysIso(hkt.isoDate, 25);

    const existingMeetings = await sql<{
      meet_id: string | number;
      start_date_time: string;
      venue_name_en: string | null;
      subject_en: string;
      agenda_http_status: number;
      agenda_hash: string | null;
      agenda_items_json: AgendaItem[];
      cancelled: boolean;
    }>(
      `select meet_id, start_date_time, venue_name_en, subject_en,
              agenda_http_status, agenda_hash, agenda_items_json, cancelled
       from meetings`,
    );

    const isBootstrap = existingMeetings.length === 0;
    const existingById = new Map(existingMeetings.map((m) => [Number(m.meet_id), m]));

    // 1. Fetch ScheduleDB meetings, committees, and live meetings in parallel
    const meetingFilter = encodeURIComponent(
      `start_date_time ge datetime'${fromIso}T00:00:00' and start_date_time le datetime'${toIso}T23:59:59'`,
    );

    const [meetingsRes, committeesRes, liveRes] = await Promise.all([
      fetchLegcoJson<ODataList<TMeetingRow>>(
        `https://app.legco.gov.hk/ScheduleDB/odata/Tmeeting?$filter=${meetingFilter}&$orderby=start_date_time%20asc&$top=120&$format=json`,
      ),
      fetchLegcoJson<ODataList<TCommitteeRow>>(
        "https://app.legco.gov.hk/ScheduleDB/odata/Tcommittee?$top=180&$orderby=committee_id%20desc&$select=committee_id,committee_code,name_eng,name_chi,home_url_eng&$format=json",
      ).catch(() => ({ value: [] as TCommitteeRow[] })),
      fetchLegcoJson<ODataList<VLiveMeetingRow>>(
        "https://app.legco.gov.hk/wcod/odata/VLiveMeeting?$format=json",
      ).catch(() => ({ value: [] as VLiveMeetingRow[] })),
    ]);

    const committees = committeesRes.value || [];
    const liveMeetings = liveRes.value || [];
    const fetchedIds = new Set<number>();

    const biTargets = new Map<
      string,
      { baseDir: string; committeeEn: string; committeeTc: string; catIds: string[]; meetId?: number }
    >();

    for (const m of meetingsRes.value || []) {
      fetchedIds.add(m.meet_id);
      meetingsSynced += 1;

      const matchedComm = matchCommitteeForMeeting(m.subject_eng, m.subject_chi, committees);
      const agendaEn = normalizeLegcoUrl(m.agenda_url_eng);
      const agendaTc = normalizeLegcoUrl(m.agenda_url_chi);
      const homeUrl = normalizeLegcoUrl(matchedComm?.home_url_eng);

      const isLive = liveMeetings.some(
        (lm) =>
          (lm.name_eng && m.subject_eng.toLowerCase().includes(lm.name_eng.toLowerCase())) ||
          (lm.start_date_time && lm.start_date_time === m.start_date_time),
      );
      const liveEntry = isLive ? liveMeetings[0] : undefined;

      const prev = existingById.get(m.meet_id);
      if (prev && !isBootstrap) {
        if (prev.start_date_time !== m.start_date_time) {
          const ok = await recordEvent({
            meetId: m.meet_id,
            eventType: "TIME_CHANGED",
            severity: "high",
            titleEn: `Meeting rescheduled — ${m.subject_eng}`,
            titleTc: `會議時間更改 — ${m.subject_chi}`,
            summaryEn: `Start time changed from ${prev.start_date_time} to ${m.start_date_time}`,
            summaryTc: `會議開始時間由 ${prev.start_date_time} 改為 ${m.start_date_time}`,
            oldValue: prev.start_date_time,
            newValue: m.start_date_time,
            linkUrl: agendaEn || homeUrl || null,
            committeeNameEn: matchedComm?.name_eng || m.subject_eng,
            committeeNameTc: matchedComm?.name_chi || m.subject_chi,
            fingerprint: `time:${m.meet_id}:${prev.start_date_time}->${m.start_date_time}`,
          });
          if (ok) eventsRecorded += 1;
        }

        if ((prev.venue_name_en || "") !== (m.venue_name_eng || "")) {
          const ok = await recordEvent({
            meetId: m.meet_id,
            eventType: "VENUE_CHANGED",
            severity: "high",
            titleEn: `Venue changed — ${m.subject_eng}`,
            titleTc: `會議地點更改 — ${m.subject_chi}`,
            summaryEn: `Venue changed from ${prev.venue_name_en || "TBA"} to ${m.venue_name_eng || "TBA"}`,
            summaryTc: `地點由 ${prev.venue_name_en || "待定"} 改為 ${m.venue_name_chi || m.venue_name_eng || "待定"}`,
            oldValue: prev.venue_name_en || "",
            newValue: m.venue_name_eng || "",
            linkUrl: agendaEn || homeUrl || null,
            committeeNameEn: matchedComm?.name_eng || m.subject_eng,
            committeeNameTc: matchedComm?.name_chi || m.subject_chi,
            fingerprint: `venue:${m.meet_id}:${prev.venue_name_en}->${m.venue_name_eng}`,
          });
          if (ok) eventsRecorded += 1;
        }

        if (prev.subject_en !== m.subject_eng) {
          const ok = await recordEvent({
            meetId: m.meet_id,
            eventType: "DETAILS_UPDATED",
            severity: "normal",
            titleEn: `Meeting notice updated — ${m.subject_eng}`,
            titleTc: `會議詳情更新 — ${m.subject_chi}`,
            summaryEn: `Updated from "${prev.subject_en}" to "${m.subject_eng}"`,
            summaryTc: `會議標題/備註已更新：${m.subject_chi}`,
            oldValue: prev.subject_en,
            newValue: m.subject_eng,
            linkUrl: agendaEn || homeUrl || null,
            committeeNameEn: matchedComm?.name_eng || m.subject_eng,
            committeeNameTc: matchedComm?.name_chi || m.subject_chi,
            fingerprint: `subj:${m.meet_id}:${m.subject_eng}`,
          });
          if (ok) eventsRecorded += 1;
        }
      } else if (!prev && !isBootstrap) {
        const ok = await recordEvent({
          meetId: m.meet_id,
          eventType: "MEETING_ADDED",
          severity: "normal",
          titleEn: `New meeting scheduled — ${m.subject_eng}`,
          titleTc: `新增會議日程 — ${m.subject_chi}`,
          summaryEn: `${m.start_date_time.replace("T", " ")} · ${m.venue_name_eng || "Venue TBA"}`,
          summaryTc: `${m.start_date_time.replace("T", " ")} · ${m.venue_name_chi || "地點待定"}`,
          linkUrl: agendaEn || homeUrl || null,
          committeeNameEn: matchedComm?.name_eng || m.subject_eng,
          committeeNameTc: matchedComm?.name_chi || m.subject_chi,
          fingerprint: `added:${m.meet_id}:${m.start_date_time}`,
        });
        if (ok) eventsRecorded += 1;
      }

      await sql(
        `insert into meetings (
          meet_id, slot_id, committee_code, committee_name_en, committee_name_tc,
          subject_en, subject_tc, start_date_time, venue_code,
          venue_name_en, venue_name_tc, meeting_type_en, meeting_type_tc,
          agenda_url_en, agenda_url_tc, home_url_en, is_live, webcast_url,
          cancelled, last_seen_at, updated_at
        ) values (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15, $16, $17, $18,
          false, now(), now()
        )
        on conflict (meet_id) do update set
          slot_id = excluded.slot_id,
          committee_code = coalesce(nullif(excluded.committee_code, ''), meetings.committee_code),
          committee_name_en = coalesce(nullif(excluded.committee_name_en, ''), meetings.committee_name_en),
          committee_name_tc = coalesce(nullif(excluded.committee_name_tc, ''), meetings.committee_name_tc),
          subject_en = excluded.subject_en,
          subject_tc = excluded.subject_tc,
          start_date_time = excluded.start_date_time,
          venue_code = excluded.venue_code,
          venue_name_en = excluded.venue_name_en,
          venue_name_tc = excluded.venue_name_tc,
          meeting_type_en = excluded.meeting_type_en,
          meeting_type_tc = excluded.meeting_type_tc,
          agenda_url_en = excluded.agenda_url_en,
          agenda_url_tc = excluded.agenda_url_tc,
          home_url_en = coalesce(nullif(excluded.home_url_en, ''), meetings.home_url_en),
          is_live = excluded.is_live,
          webcast_url = excluded.webcast_url,
          cancelled = false,
          last_seen_at = now(),
          updated_at = now()`,
        [
          m.meet_id,
          m.slot_id || "",
          matchedComm?.committee_code || "",
          matchedComm?.name_eng || m.subject_eng,
          matchedComm?.name_chi || m.subject_chi,
          m.subject_eng,
          m.subject_chi,
          m.start_date_time,
          m.venue_code || "",
          m.venue_name_eng || "",
          m.venue_name_chi || "",
          m.meeting_type_eng || "",
          m.meeting_type_chi || "",
          agendaEn,
          agendaTc,
          homeUrl,
          isLive,
          liveEntry?.webcast_url || "",
        ],
      );

      // Register committee /bi/data target if resolvable
      if (homeUrl) {
        const baseDir = resolvePapersBaseDirFromHomeUrl(homeUrl, matchedComm?.committee_code);
        if (baseDir && !biTargets.has(baseDir)) {
          biTargets.set(baseDir, {
            baseDir,
            committeeEn: matchedComm?.name_eng || m.subject_eng,
            committeeTc: matchedComm?.name_chi || m.subject_chi,
            catIds: ["d"],
            meetId: m.meet_id,
          });
        }
      }
    }

    // Detect meetings removed from upcoming ScheduleDB window
    if (!isBootstrap) {
      for (const prev of existingMeetings) {
        const id = Number(prev.meet_id);
        const dateOnly = prev.start_date_time.slice(0, 10);
        if (
          !prev.cancelled &&
          !fetchedIds.has(id) &&
          dateOnly >= fromIso &&
          dateOnly <= toIso
        ) {
          await sql("update meetings set cancelled = true, updated_at = now() where meet_id = $1", [
            id,
          ]);
          const ok = await recordEvent({
            meetId: id,
            eventType: "MEETING_REMOVED",
            severity: "high",
            titleEn: `Meeting removed from schedule — ${prev.subject_en}`,
            titleTc: `會議已從日程表移除 — ${prev.subject_en}`,
            summaryEn: `Previously scheduled for ${prev.start_date_time.replace("T", " ")}`,
            summaryTc: `原定時間：${prev.start_date_time.replace("T", " ")}`,
            oldValue: prev.start_date_time,
            committeeNameEn: prev.subject_en,
            fingerprint: `removed:${id}:${prev.start_date_time}`,
          });
          if (ok) eventsRecorded += 1;
        }
      }
    }

    // 2. Probe Agendas (for meetings within probeFrom..probeTo)
    const meetingsToProbe = (meetingsRes.value || [])
      .filter((m) => {
        const d = m.start_date_time.slice(0, 10);
        return m.agenda_url_eng && d >= probeFrom && d <= probeTo;
      })
      .slice(0, 26);

    const probedCouncilDates = new Set<string>();

    await Promise.all(
      meetingsToProbe.map(async (m) => {
        const agendaEn = normalizeLegcoUrl(m.agenda_url_eng);
        const agendaTc = normalizeLegcoUrl(m.agenda_url_chi);
        if (!agendaEn) return;

        try {
          const res = await fetchLegcoText(agendaEn, 12000);
          agendasProbed += 1;

          const parsed = parseCommitteeAgendaHtml(res.body);
          const status = parsed.isNotFound ? 404 : res.status;
          const prev = existingById.get(m.meet_id);

          if (!parsed.isNotFound && parsed.hash) {
            if (!isBootstrap && prev && prev.agenda_http_status !== 200) {
              const ok = await recordEvent({
                meetId: m.meet_id,
                eventType: "AGENDA_PUBLISHED",
                severity: "high",
                titleEn: `Agenda now live — ${m.subject_eng}`,
                titleTc: `會議議程已上載 — ${m.subject_chi}`,
                summaryEn: `${parsed.items.length} agenda item(s) and ${parsed.discoveredPdfs.length} paper link(s) detected`,
                summaryTc: `已偵測 ${parsed.items.length} 個議程項目及 ${parsed.discoveredPdfs.length} 份文件連結`,
                linkUrl: agendaEn,
                committeeNameEn: m.subject_eng,
                committeeNameTc: m.subject_chi,
                fingerprint: `agenda_live:${m.meet_id}:${parsed.hash}`,
              });
              if (ok) eventsRecorded += 1;
            } else if (
              !isBootstrap &&
              prev &&
              prev.agenda_hash &&
              prev.agenda_hash !== parsed.hash
            ) {
              const prevItems = Array.isArray(prev.agenda_items_json)
                ? prev.agenda_items_json
                : [];
              const diffs = diffAgendaItems(
                prevItems,
                parsed.items,
                m.subject_eng,
                m.subject_chi,
                agendaEn,
              );

              if (diffs.length > 0) {
                for (const diff of diffs) {
                  const ok = await recordEvent({
                    meetId: m.meet_id,
                    eventType: diff.eventType,
                    severity: diff.severity,
                    titleEn: diff.titleEn,
                    titleTc: diff.titleTc,
                    summaryEn: diff.summaryEn,
                    summaryTc: diff.summaryTc,
                    linkUrl: diff.linkUrl || agendaEn,
                    committeeNameEn: m.subject_eng,
                    committeeNameTc: m.subject_chi,
                    fingerprint: `agenda_diff:${m.meet_id}:${diff.eventType}:${parsed.hash}`,
                  });
                  if (ok) eventsRecorded += 1;
                }
              } else {
                const ok = await recordEvent({
                  meetId: m.meet_id,
                  eventType: "AGENDA_REVISED",
                  severity: "normal",
                  titleEn: `Agenda updated — ${m.subject_eng}`,
                  titleTc: `議程內容有變動 — ${m.subject_chi}`,
                  summaryEn: `Structured content changed on ${m.start_date_time.slice(0, 10)} agenda`,
                  summaryTc: `${m.start_date_time.slice(0, 10)} 會議議程內容已修訂`,
                  linkUrl: agendaEn,
                  committeeNameEn: m.subject_eng,
                  committeeNameTc: m.subject_chi,
                  fingerprint: `agenda_rev:${m.meet_id}:${parsed.hash}`,
                });
                if (ok) eventsRecorded += 1;
              }
            }

            await sql(
              `update meetings
               set agenda_http_status = $1, agenda_hash = $2, agenda_items_json = $3::jsonb, updated_at = now()
               where meet_id = $4`,
              [status, parsed.hash, JSON.stringify(parsed.items), m.meet_id],
            );

            // Ingest PDFs embedded inside the agenda
            for (const pdf of parsed.discoveredPdfs) {
              const docKey = pdf.paperNo
                ? `paper:${pdf.paperNo}`
                : `url:${pdf.url.toLowerCase()}`;
              const isReply = /Administration['’]s\s+response|當局就意見書?所作回應|政府當局.*回應/i.test(pdf.description);
              const isSub =
                /Submission|Deputation|意見書/i.test(pdf.description) &&
                !/follow-up actions|跟進行動/i.test(pdf.description) &&
                !isReply;

              const { inserted } = await upsertDocument({
                docKey,
                paperNo: pdf.paperNo,
                docType: isReply ? "reply" : isSub ? "submission" : "paper",
                sourceKind: "agenda",
                committeeNameEn: m.subject_eng,
                committeeNameTc: m.subject_chi,
                titleEn: pdf.description || pdf.paperNo,
                titleTc: pdf.description || pdf.paperNo,
                urlEn: pdf.url.includes("/english/") ? pdf.url : "",
                urlTc: pdf.url.includes("/chinese/") ? pdf.url : "",
                meetingDate: m.start_date_time.slice(0, 10),
                meetId: m.meet_id,
              });
              if (inserted) documentsUpserted += 1;
            }

            // Collect #papers-and-reports&cat=... pointers (hidden submissions)
            for (const portalLink of parsed.papersPortalLinks) {
              const baseDir = resolvePapersBaseDirFromHomeUrl(portalLink.url);
              if (baseDir) {
                const existingTarget = biTargets.get(baseDir);
                const catId = portalLink.catId || "d";
                if (existingTarget) {
                  if (!existingTarget.catIds.includes(catId)) {
                    existingTarget.catIds.unshift(catId);
                  }
                } else {
                  biTargets.set(baseDir, {
                    baseDir,
                    committeeEn: m.subject_eng,
                    committeeTc: m.subject_chi,
                    catIds: [catId],
                    meetId: m.meet_id,
                  });
                }
              }
            }

            // Extract Upcoming Council Meeting Questions (質詢)
            if (agendaEn.includes("/counmtg/agenda/cm")) {
              const dateMatch = agendaEn.match(/cm(\d{4})(\d{2})(\d{2})\.htm/i);
              const cmDate = dateMatch
                ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
                : m.start_date_time.slice(0, 10);

              if (!probedCouncilDates.has(cmDate)) {
                probedCouncilDates.add(cmDate);
                const enQuestions = parseCouncilQuestionsFromAgenda(res.body);
                let tcQuestions: ReturnType<typeof parseCouncilQuestionsFromAgenda> = [];

                if (agendaTc) {
                  try {
                    const tcRes = await fetchLegcoText(agendaTc, 12000);
                    tcQuestions = parseCouncilQuestionsFromAgenda(tcRes.body);
                  } catch {
                    // Fallback to EN-only if TC fetch fails
                  }
                }

                const tcByNo = new Map(tcQuestions.map((q) => [q.questionNo, q]));
                for (const eq of enQuestions) {
                  const tq = tcByNo.get(eq.questionNo);
                  const qKey = `${cmDate}:Q${eq.questionNo}`;
                  await sql(
                    `insert into questions (
                      question_key, stage, question_type, question_no, meeting_date,
                      member_name_en, member_name_tc, subject_en, subject_tc,
                      body_en, body_tc, agenda_url_en, agenda_url_tc, content_hash, updated_at
                    ) values (
                      $1, 'upcoming', $2, $3, $4,
                      $5, $6, $7, $8,
                      $9, $10, $11, $12, $13, now()
                    )
                    on conflict (question_key) do update set
                      member_name_en = excluded.member_name_en,
                      member_name_tc = excluded.member_name_tc,
                      subject_en = excluded.subject_en,
                      subject_tc = excluded.subject_tc,
                      body_en = excluded.body_en,
                      body_tc = excluded.body_tc,
                      agenda_url_en = excluded.agenda_url_en,
                      agenda_url_tc = excluded.agenda_url_tc,
                      content_hash = excluded.content_hash,
                      updated_at = now()`,
                    [
                      qKey,
                      eq.questionType,
                      eq.questionNo,
                      cmDate,
                      eq.memberName,
                      tq?.memberName || eq.memberName,
                      eq.subject,
                      tq?.subject || eq.subject,
                      eq.body,
                      tq?.body || "",
                      `${agendaEn}#q_${eq.questionNo}`,
                      agendaTc ? `${agendaTc}#q_${eq.questionNo}` : "",
                      eq.contentHash,
                    ],
                  );
                  questionsUpserted += 1;
                }
              }
            }
          } else {
            await sql("update meetings set agenda_http_status = $1 where meet_id = $2", [
              status,
              m.meet_id,
            ]);
          }
        } catch {
          // Non-fatal single agenda failure
        }
      }),
    );

    // 3. Harvest Committee /bi/data/ JSON (Hidden Submissions + Government Replies + Papers)
    const prioritizedTargets = Array.from(biTargets.values()).slice(0, 12);
    await Promise.all(
      prioritizedTargets.map(async (target) => {
        const docs = await harvestCommitteeBiPapers(target.baseDir, target.catIds, 4);
        if (docs.length > 0) biCommitteesHarvested += 1;

        for (const d of docs) {
          const docKey = d.paperNo
            ? `paper:${d.paperNo}`
            : `bi:${(d.urlEn || d.urlTc).toLowerCase()}`;
          const { inserted } = await upsertDocument({
            docKey,
            paperNo: d.paperNo,
            docType: d.docType,
            sourceKind: "bi_json",
            committeeNameEn: target.committeeEn,
            committeeNameTc: target.committeeTc,
            titleEn: d.titleEn,
            titleTc: d.titleTc,
            summaryEn: d.categoryEn,
            summaryTc: d.categoryTc,
            urlEn: d.urlEn,
            urlTc: d.urlTc,
            meetingDate: d.meetingDate,
            issueDate: d.issueDate,
            replyToPaperNo: d.replyToPaperNo,
            relatedPaperNo: d.relatedPaperNo,
            meetId: target.meetId ?? null,
            publishedAt: d.issueDate ? `${d.issueDate}T09:00:00+08:00` : new Date().toISOString(),
          });
          if (inserted) {
            documentsUpserted += 1;
            if (!isBootstrap && d.docType === "submission") {
              const ok = await recordEvent({
                meetId: target.meetId ?? null,
                eventType: "SUBMISSION_ADDED",
                severity: "high",
                titleEn: `New submission — ${target.committeeEn}`,
                titleTc: `新收意見書 — ${target.committeeTc}`,
                summaryEn: `${d.paperNo ? `${d.paperNo} · ` : ""}${d.titleEn}`,
                summaryTc: `${d.paperNo ? `${d.paperNo} · ` : ""}${d.titleTc}`,
                linkUrl: d.urlEn || d.urlTc || null,
                committeeNameEn: target.committeeEn,
                committeeNameTc: target.committeeTc,
                fingerprint: `sub:${docKey}`,
              });
              if (ok) eventsRecorded += 1;
            }
          }
        }
      }),
    );

    // 4. Fetch RSS Feeds (EN + TC paired)
    const rssDocs = await fetchAllLegcoRssDocuments();
    for (const r of rssDocs) {
      const { inserted } = await upsertDocument({
        docKey: r.docKey,
        paperNo: r.paperNo,
        docType: r.docType,
        sourceKind: "rss",
        committeeNameEn: r.committeeNameEn,
        committeeNameTc: r.committeeNameTc,
        titleEn: r.titleEn,
        titleTc: r.titleTc,
        summaryEn: r.summaryEn,
        summaryTc: r.summaryTc,
        urlEn: r.urlEn,
        urlTc: r.urlTc,
        publishedAt: r.publishedAt,
      });
      if (inserted) documentsUpserted += 1;

      if (r.isRevisionNotice) {
        const ok = await recordEvent({
          eventType: "PRESS_NOTICE",
          severity: "high",
          titleEn: r.titleEn,
          titleTc: r.titleTc,
          summaryEn: r.summaryEn || r.titleEn,
          summaryTc: r.summaryTc || r.titleTc,
          linkUrl: r.urlEn || r.urlTc || null,
          committeeNameEn: r.committeeNameEn,
          committeeNameTc: r.committeeNameTc,
          fingerprint: `rss_notice:${r.docKey}`,
        });
        if (ok) eventsRecorded += 1;
      }
    }

    // 5. Fetch QuestionsDB (Stage 2: Answered Oral & Written 質詢 with Hansard links)
    const [oralEn, oralChi, writtenEn, writtenChi] = await Promise.all([
      fetchLegcoJson<ODataList<QuestionDbRow>>(
        "https://app.legco.gov.hk/QuestionsDB/odata/ViewOralQuestionsEng?$top=30&$orderby=MeetingDate%20desc&$format=json",
      ).catch(() => ({ value: [] as QuestionDbRow[] })),
      fetchLegcoJson<ODataList<QuestionDbRow>>(
        "https://app.legco.gov.hk/QuestionsDB/odata/ViewOralQuestionsChi?$top=30&$orderby=MeetingDate%20desc&$format=json",
      ).catch(() => ({ value: [] as QuestionDbRow[] })),
      fetchLegcoJson<ODataList<QuestionDbRow>>(
        "https://app.legco.gov.hk/QuestionsDB/odata/ViewWrittenQuestionsEng?$top=35&$orderby=MeetingDate%20desc&$format=json",
      ).catch(() => ({ value: [] as QuestionDbRow[] })),
      fetchLegcoJson<ODataList<QuestionDbRow>>(
        "https://app.legco.gov.hk/QuestionsDB/odata/ViewWrittenQuestionsChi?$top=35&$orderby=MeetingDate%20desc&$format=json",
      ).catch(() => ({ value: [] as QuestionDbRow[] })),
    ]);

    const pairQuestions = async (
      enList: QuestionDbRow[],
      chiList: QuestionDbRow[],
      qType: "oral" | "written",
    ) => {
      const chiByDateBookmark = new Map<string, QuestionDbRow>();
      for (const c of chiList) {
        chiByDateBookmark.set(`${c.MeetingDate.slice(0, 10)}|${c.BookmarkName}`, c);
      }

      for (const e of enList) {
        const mDate = e.MeetingDate.slice(0, 10);
        const chi = chiByDateBookmark.get(`${mDate}|${e.BookmarkName}`);
        const qKey = `db:${qType}:${mDate}:${e.BookmarkName}`;
        const numMatch = e.BookmarkName.match(/(\d+)$/);
        const qNo = numMatch ? Number(numMatch[1]) : null;

        await sql(
          `insert into questions (
            question_key, stage, question_type, question_no, meeting_date,
            member_name_en, member_name_tc, subject_en, subject_tc,
            hansard_url_en, hansard_url_tc, updated_at
          ) values (
            $1, 'answered', $2, $3, $4,
            $5, $6, $7, $8,
            $9, $10, now()
          )
          on conflict (question_key) do update set
            member_name_en = excluded.member_name_en,
            member_name_tc = excluded.member_name_tc,
            subject_en = excluded.subject_en,
            subject_tc = excluded.subject_tc,
            hansard_url_en = excluded.hansard_url_en,
            hansard_url_tc = excluded.hansard_url_tc,
            updated_at = now()`,
          [
            qKey,
            qType,
            qNo,
            mDate,
            e.MemberName,
            chi?.MemberName || e.MemberName,
            e.SubjectName,
            chi?.SubjectName || e.SubjectName,
            normalizeLegcoUrl(e.HansardFileURL),
            normalizeLegcoUrl(chi?.HansardFileURL || ""),
          ],
        );
        questionsUpserted += 1;
      }
    };

    await pairQuestions(oralEn.value || [], oralChi.value || [], "oral");
    await pairQuestions(writtenEn.value || [], writtenChi.value || [], "written");

    if (isBootstrap) {
      const ok = await recordEvent({
        eventType: "BASELINE_SYNCED",
        severity: "normal",
        titleEn: "Initial LegCo live snapshot synced",
        titleTc: "已同步立法會最新實時基準數據",
        summaryEn: `Indexed ${meetingsSynced} meetings, ${agendasProbed} agendas, ${documentsUpserted} documents & submissions, and ${questionsUpserted} 質詢 records`,
        summaryTc: `已索引 ${meetingsSynced} 場會議、${agendasProbed} 份議程、${documentsUpserted} 份文件及意見書，以及 ${questionsUpserted} 項質詢`,
        fingerprint: `bootstrap:${hkt.isoDate}`,
      });
      if (ok) eventsRecorded += 1;
    }

    const summary: SyncSummary = {
      mode,
      meetingsSynced,
      agendasProbed,
      biCommitteesHarvested,
      documentsUpserted,
      questionsUpserted,
      eventsRecorded,
      durationMs: Date.now() - startedAt,
    };

    await sql(
      `update sync_state
       set is_syncing = false, last_success_at = now(), last_summary_json = $1::jsonb, last_error = null
       where id = 1`,
      [JSON.stringify(summary)],
    );

    return summary;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await sql(
      "update sync_state set is_syncing = false, last_error = $1 where id = 1",
      [msg.slice(0, 500)],
    );
    throw err;
  }
}
