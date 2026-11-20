"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Bookmark,
  Calendar,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  Filter,
  Lock,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import {
  decryptJsonWithPasscode,
  type EncryptedSnapshotPayload,
} from "../lib/static-crypto";
import { getWorkingHoursStatus } from "../lib/working-hours";

const STATIC_PASSCODE_KEY = "legco_static_passcode";
const STATIC_WATCHLIST_KEY = "legco_static_watchlist";
const STATIC_ACK_KEY = "legco_static_ack_at";

type LangMode = "both" | "tc" | "en";
type MainTab = "meetings" | "documents" | "questions" | "watchlist";

interface AgendaPaperEntry {
  paperNo: string;
  description: string;
  url: string;
  isToFollow: boolean;
  isRestricted: boolean;
}

interface AgendaSubLink {
  label: string;
  url: string;
  catId: string | null;
}

interface AgendaItem {
  itemNum: string;
  title: string;
  remark: string;
  papers: AgendaPaperEntry[];
  subLinks: AgendaSubLink[];
}

interface MeetingRow {
  meet_id: string | number;
  committee_code: string | null;
  committee_name_en: string | null;
  committee_name_tc: string | null;
  subject_en: string;
  subject_tc: string;
  start_date_time: string;
  venue_code: string | null;
  venue_name_en: string | null;
  venue_name_tc: string | null;
  meeting_type_en: string | null;
  meeting_type_tc: string | null;
  agenda_url_en: string | null;
  agenda_url_tc: string | null;
  home_url_en: string | null;
  agenda_http_status: number;
  agenda_items_json: AgendaItem[];
  is_live: boolean;
  webcast_url: string | null;
  cancelled: boolean;
}

interface ChangeEventRow {
  id: number;
  meet_id: number | null;
  event_type: string;
  severity: "high" | "normal";
  title_en: string;
  title_tc: string;
  summary_en: string;
  summary_tc: string;
  old_value: string | null;
  new_value: string | null;
  link_url: string | null;
  committee_name_en: string | null;
  committee_name_tc: string | null;
  detected_at: string;
}

interface DocumentRow {
  id: number;
  doc_key: string;
  paper_no: string | null;
  doc_type: string;
  source_kind: string;
  committee_name_en: string | null;
  committee_name_tc: string | null;
  title_en: string;
  title_tc: string;
  summary_en: string | null;
  summary_tc: string | null;
  url_en: string | null;
  url_tc: string | null;
  meeting_date: string | null;
  issue_date: string | null;
  reply_to_paper_no: string | null;
  related_paper_no: string | null;
  meet_id: number | null;
  published_at: string;
}

interface QuestionRow {
  id: number;
  question_key: string;
  stage: "upcoming" | "answered";
  question_type: "oral" | "written";
  question_no: number | null;
  meeting_date: string;
  member_name_en: string;
  member_name_tc: string;
  subject_en: string;
  subject_tc: string;
  body_en: string | null;
  body_tc: string | null;
  agenda_url_en: string | null;
  agenda_url_tc: string | null;
  hansard_url_en: string | null;
  hansard_url_tc: string | null;
  reply_url_en?: string | null;
  reply_url_tc?: string | null;
}

interface WatchlistRule {
  id: number;
  rule_type: "committee" | "keyword" | "member";
  value: string;
  label: string;
  created_at: string;
}

interface WorkingHoursStatus {
  hktNowIso: string;
  hktClock: string;
  hktDayName: string;
  isWorkingHours: boolean;
  mode: "working_hours" | "off_hours";
  recommendedIntervalMs: number;
  recommendedIntervalMinutes: number;
  windowLabelEn: string;
  windowLabelTc: string;
}

interface DashboardData {
  meetings: MeetingRow[];
  events: ChangeEventRow[];
  unreadCount: number;
  documents: DocumentRow[];
  questions: QuestionRow[];
  watchlist: WatchlistRule[];
  syncState: {
    last_sync_at: string | null;
    last_success_at: string | null;
    last_mode: string | null;
    last_summary_json: Record<string, unknown>;
    last_error: string | null;
    is_syncing: boolean;
  } | null;
  workingHours: WorkingHoursStatus;
  viewer: {
    name: string;
    simulated: boolean;
    passcodeEnabled?: boolean;
  };
}

function safeLegcoHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (
      u.protocol === "https:" &&
      (u.hostname === "www.legco.gov.hk" ||
        u.hostname === "app.legco.gov.hk" ||
        u.hostname === "www.info.gov.hk")
    ) {
      return u.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function formatHktTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

const DOC_TYPE_LABELS: Record<string, { en: string; tc: string; tone: string }> = {
  submission: {
    en: "Submission",
    tc: "意見書",
    tone: "bg-amber-50 text-amber-800 border-amber-200",
  },
  reply: {
    en: "Govt Reply",
    tc: "政府回應",
    tone: "bg-emerald-50 text-emerald-800 border-emerald-200",
  },
  brief: {
    en: "LegCo Brief",
    tc: "參考資料摘要",
    tone: "bg-indigo-50 text-indigo-800 border-indigo-200",
  },
  bill: {
    en: "Bill",
    tc: "條例草案",
    tone: "bg-purple-50 text-purple-800 border-purple-200",
  },
  subleg: {
    en: "Subleg",
    tc: "附屬法例",
    tone: "bg-purple-50 text-purple-800 border-purple-200",
  },
  agenda: {
    en: "Agenda",
    tc: "議程",
    tone: "bg-sky-50 text-sky-800 border-sky-200",
  },
  minutes: {
    en: "Minutes",
    tc: "會議紀要",
    tone: "bg-slate-100 text-slate-700 border-slate-200",
  },
  hansard: {
    en: "Hansard",
    tc: "會議過程紀錄",
    tone: "bg-slate-100 text-slate-700 border-slate-200",
  },
  press: {
    en: "Press",
    tc: "新聞稿",
    tone: "bg-rose-50 text-rose-800 border-rose-200",
  },
  paper: {
    en: "Paper",
    tc: "文件",
    tone: "bg-slate-100 text-slate-700 border-slate-200",
  },
};

export function LegcoDashboard({ mode = "server" }: { mode?: "server" | "static" }) {
  const isStatic = mode === "static";
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lang, setLang] = useState<LangMode>("both");
  const [tab, setTab] = useState<MainTab>("meetings");
  const [search, setSearch] = useState("");
  const [watchlistOnly, setWatchlistOnly] = useState(false);

  const [meetingScope, setMeetingScope] = useState<"upcoming" | "all" | "agenda_live">("upcoming");
  const [expandedMeetings, setExpandedMeetings] = useState<Record<string, boolean>>({});

  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");
  const [docSourceFilter, setDocSourceFilter] = useState<string>("all");

  const [qStageFilter, setQStageFilter] = useState<"all" | "upcoming" | "answered">("all");
  const [qTypeFilter, setQTypeFilter] = useState<"all" | "oral" | "written">("all");
  const [expandedQuestions, setExpandedQuestions] = useState<Record<string, boolean>>({});

  const [newRuleType, setNewRuleType] = useState<"committee" | "keyword" | "member">("keyword");
  const [newRuleValue, setNewRuleValue] = useState("");

  const [passcodeRequired, setPasscodeRequired] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const loadStaticDashboard = useCallback(async (candidatePasscode?: string) => {
    const res = await fetch(`./snapshot.enc.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error("Encrypted LegCo snapshot not ready yet. Run or wait for the GitHub Action sync.");
    }
    const encPayload = (await res.json()) as EncryptedSnapshotPayload;
    const savedPass =
      candidatePasscode ?? window.sessionStorage.getItem(STATIC_PASSCODE_KEY) ?? "";
    if (!savedPass) {
      setPasscodeRequired(true);
      setLoading(false);
      return false;
    }

    const decrypted = await decryptJsonWithPasscode<DashboardData>(encPayload, savedPass);
    const savedRules = JSON.parse(
      window.localStorage.getItem(STATIC_WATCHLIST_KEY) || "[]",
    ) as WatchlistRule[];
    const ackIso = window.localStorage.getItem(STATIC_ACK_KEY) || "";
    const ackMs = ackIso ? Date.parse(ackIso) : 0;
    const unreadCount = decrypted.events.filter((ev) => {
      const t = Date.parse(ev.detected_at);
      return !Number.isNaN(t) && t > ackMs;
    }).length;

    window.sessionStorage.setItem(STATIC_PASSCODE_KEY, savedPass);
    setPasscodeRequired(false);
    setData({
      ...decrypted,
      watchlist: savedRules,
      unreadCount,
      workingHours: getWorkingHoursStatus(),
      viewer: {
        name: "Teammate",
        simulated: false,
        passcodeEnabled: true,
      },
    });
    setError(null);
    setLoading(false);
    return true;
  }, []);

  const fetchDashboard = useCallback(async () => {
    try {
      if (isStatic) {
        try {
          await loadStaticDashboard();
        } catch (err: unknown) {
          if (window.sessionStorage.getItem(STATIC_PASSCODE_KEY)) {
            window.sessionStorage.removeItem(STATIC_PASSCODE_KEY);
            setPasscodeRequired(true);
            setLoading(false);
            return;
          }
          throw err;
        }
        return;
      }

      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (res.status === 401) {
        const errBody = (await res.json().catch(() => ({}))) as {
          reason?: string;
          error?: string;
        };
        if (errBody.reason === "passcode_required") {
          setPasscodeRequired(true);
          setError(null);
        } else {
          setPasscodeRequired(false);
          setError(
            errBody.error ||
              "Sign-in required to view this dashboard.",
          );
        }
        setLoading(false);
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as DashboardData;
      setPasscodeRequired(false);
      setData(json);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, [isStatic, loadStaticDashboard]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcodeInput.trim()) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      if (isStatic) {
        try {
          await loadStaticDashboard(passcodeInput.trim());
          setPasscodeInput("");
        } catch {
          setUnlockError("Incorrect passcode");
        }
        return;
      }

      const res = await fetch("/api/auth/unlock", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-legco-client": "1",
        },
        body: JSON.stringify({ passcode: passcodeInput }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setUnlockError(body.error || "Incorrect passcode");
        return;
      }
      setPasscodeInput("");
      setLoading(true);
      await fetchDashboard();
    } finally {
      setUnlocking(false);
    }
  };

  const handleLock = async () => {
    if (isStatic) {
      window.sessionStorage.removeItem(STATIC_PASSCODE_KEY);
      setData(null);
      setPasscodeRequired(true);
      return;
    }

    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "x-legco-client": "1" },
    });
    setData(null);
    setPasscodeRequired(true);
  };

  useEffect(() => {
    void fetchDashboard();
  }, [fetchDashboard]);

  // Working-hours aware auto-refresh in browser (5m inside 08:00-20:00 HKT, 30m outside)
  useEffect(() => {
    const intervalMs = data?.workingHours?.recommendedIntervalMs ?? 5 * 60 * 1000;
    const id = setInterval(() => {
      void fetchDashboard();
    }, intervalMs);
    return () => clearInterval(id);
  }, [data?.workingHours?.recommendedIntervalMs, fetchDashboard]);

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      if (isStatic) {
        await fetchDashboard();
        return;
      }

      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "x-legco-client": "1" },
      });
      if (!res.ok) throw new Error(`Sync failed (${res.status})`);
      await fetchDashboard();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const handleAckEvents = async () => {
    if (isStatic) {
      window.localStorage.setItem(STATIC_ACK_KEY, new Date().toISOString());
      await fetchDashboard();
      return;
    }

    await fetch("/api/events/ack", {
      method: "POST",
      headers: { "x-legco-client": "1" },
    });
    await fetchDashboard();
  };

  const handleAddWatchRule = async (
    ruleType: "committee" | "keyword" | "member",
    value: string,
    label?: string,
  ) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return;

    if (isStatic) {
      const existing = JSON.parse(
        window.localStorage.getItem(STATIC_WATCHLIST_KEY) || "[]",
      ) as WatchlistRule[];
      const next: WatchlistRule[] = [
        {
          id: Date.now(),
          rule_type: ruleType,
          value: trimmed,
          label: (label || trimmed).slice(0, 140),
          created_at: new Date().toISOString(),
        },
        ...existing.filter((r) => !(r.rule_type === ruleType && r.value === trimmed)),
      ];
      window.localStorage.setItem(STATIC_WATCHLIST_KEY, JSON.stringify(next));
      setNewRuleValue("");
      await fetchDashboard();
      return;
    }

    await fetch("/api/watchlist", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-legco-client": "1",
      },
      body: JSON.stringify({ ruleType, value: trimmed, label: label || trimmed }),
    });
    setNewRuleValue("");
    await fetchDashboard();
  };

  const handleDeleteWatchRule = async (id: number) => {
    if (isStatic) {
      const existing = JSON.parse(
        window.localStorage.getItem(STATIC_WATCHLIST_KEY) || "[]",
      ) as WatchlistRule[];
      const next = existing.filter((r) => r.id !== id);
      window.localStorage.setItem(STATIC_WATCHLIST_KEY, JSON.stringify(next));
      await fetchDashboard();
      return;
    }

    await fetch(`/api/watchlist?id=${id}`, {
      method: "DELETE",
      headers: { "x-legco-client": "1" },
    });
    await fetchDashboard();
  };

  const matchesSearchAndWatchlist = useCallback(
    (haystack: string): boolean => {
      const lower = haystack.toLowerCase();
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!lower.includes(q)) return false;
      }
      if (watchlistOnly && data && data.watchlist.length > 0) {
        return data.watchlist.some((r) => lower.includes(r.value.toLowerCase()));
      }
      return true;
    },
    [search, watchlistOnly, data],
  );

  const hktToday = data?.workingHours?.hktNowIso.slice(0, 10) ?? "";

  const filteredMeetings = useMemo(() => {
    if (!data) return [];
    return data.meetings.filter((m) => {
      const mDate = m.start_date_time.slice(0, 10);
      if (meetingScope === "upcoming" && hktToday && mDate < hktToday) return false;
      if (meetingScope === "agenda_live" && m.agenda_http_status !== 200) return false;
      const text = `${m.subject_en} ${m.subject_tc} ${m.committee_name_en || ""} ${m.committee_name_tc || ""} ${m.venue_name_en || ""}`;
      return matchesSearchAndWatchlist(text);
    });
  }, [data, meetingScope, hktToday, matchesSearchAndWatchlist]);

  const filteredDocuments = useMemo(() => {
    if (!data) return [];
    return data.documents.filter((d) => {
      if (docTypeFilter !== "all" && d.doc_type !== docTypeFilter) return false;
      if (docSourceFilter !== "all" && d.source_kind !== docSourceFilter) return false;
      const text = `${d.paper_no || ""} ${d.title_en} ${d.title_tc} ${d.committee_name_en || ""} ${d.committee_name_tc || ""} ${d.summary_en || ""} ${d.summary_tc || ""}`;
      return matchesSearchAndWatchlist(text);
    });
  }, [data, docTypeFilter, docSourceFilter, matchesSearchAndWatchlist]);

  const filteredQuestions = useMemo(() => {
    if (!data) return [];
    return data.questions.filter((q) => {
      if (qStageFilter !== "all" && q.stage !== qStageFilter) return false;
      if (qTypeFilter !== "all" && q.question_type !== qTypeFilter) return false;
      const text = `${q.subject_en} ${q.subject_tc} ${q.member_name_en} ${q.member_name_tc} ${q.body_en || ""} ${q.body_tc || ""}`;
      return matchesSearchAndWatchlist(text);
    });
  }, [data, qStageFilter, qTypeFilter, matchesSearchAndWatchlist]);

  const filteredEvents = useMemo(() => {
    if (!data) return [];
    return data.events.filter((e) => {
      const text = `${e.title_en} ${e.title_tc} ${e.summary_en} ${e.summary_tc} ${e.committee_name_en || ""} ${e.committee_name_tc || ""}`;
      return matchesSearchAndWatchlist(text);
    });
  }, [data, matchesSearchAndWatchlist]);

  const stats = useMemo(() => {
    if (!data) {
      return { upcomingMeetings: 0, liveAgendas: 0, submissions: 0, upcomingQ: 0, answeredQ: 0 };
    }
    const upcoming = data.meetings.filter((m) => !hktToday || m.start_date_time.slice(0, 10) >= hktToday);
    const liveAgendas = upcoming.filter((m) => m.agenda_http_status === 200).length;
    const submissions = data.documents.filter(
      (d) => d.doc_type === "submission" || d.doc_type === "reply",
    ).length;
    const upcomingQ = data.questions.filter((q) => q.stage === "upcoming").length;
    const answeredQ = data.questions.filter((q) => q.stage === "answered").length;
    return {
      upcomingMeetings: upcoming.length,
      liveAgendas,
      submissions,
      upcomingQ,
      answeredQ,
    };
  }, [data, hktToday]);

  const renderBi = (en: string | null | undefined, tc: string | null | undefined) => {
    const e = (en || "").trim();
    const t = (tc || "").trim();
    if (lang === "en") return e || t;
    if (lang === "tc") return t || e;
    if (!e || e === t) return t || e;
    if (!t) return e;
    return `${t} · ${e}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-600">
        <div className="flex items-center gap-3 text-sm font-medium">
          <RefreshCw className="w-4 h-4 animate-spin text-indigo-600" />
          <span>Syncing live LegCo Open Data, agendas &amp; hidden submissions…</span>
        </div>
      </div>
    );
  }

  if (passcodeRequired) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <form
          onSubmit={handleUnlock}
          className="max-w-sm w-full bg-white border border-slate-200 rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center">
              <Lock className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-slate-900">
                LegCo Monitor · 立法會監察儀表板
              </h1>
              <p className="text-xs text-slate-500">Team access passcode required</p>
            </div>
          </div>

          {unlockError && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              {unlockError}
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="legco-passcode" className="block text-xs font-medium text-slate-700">
              Passcode · 存取密碼
            </label>
            <input
              id="legco-passcode"
              type="password"
              autoFocus
              value={passcodeInput}
              onChange={(e) => setPasscodeInput(e.target.value)}
              placeholder="Enter team passcode"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500"
            />
          </div>

          <button
            type="submit"
            disabled={unlocking || !passcodeInput.trim()}
            className="w-full py-2 px-4 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-50 transition cursor-pointer"
          >
            {unlocking ? "Verifying…" : "Unlock Dashboard · 進入儀表板"}
          </button>
        </form>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white border border-rose-200 rounded-xl p-6 text-sm text-rose-800">
          <div className="font-semibold mb-1">Unable to load LegCo Monitor</div>
          <p className="text-rose-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Pulse & Controls Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold text-sm tracking-tight">
                LC
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-semibold tracking-tight text-slate-900">
                    LegCo Monitor · 立法會監察儀表板
                  </h1>
                  {data.viewer.simulated && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                      Local Dev Preview
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-0.5">
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border font-medium ${
                      data.workingHours.isWorkingHours
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-slate-100 text-slate-600 border-slate-200"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        data.workingHours.isWorkingHours ? "bg-emerald-500 animate-pulse" : "bg-slate-400"
                      }`}
                    />
                    {lang === "tc" ? data.workingHours.windowLabelTc : data.workingHours.windowLabelEn}
                  </span>
                  <span>HKT: {data.workingHours.hktClock}</span>
                  <span>·</span>
                  <span>Last sync: {formatHktTimestamp(data.syncState?.last_success_at)}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
                {(["both", "tc", "en"] as LangMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setLang(m)}
                    className={`px-2.5 py-1 rounded-md font-medium transition ${
                      lang === m
                        ? "bg-white text-slate-900 border border-slate-200"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    {m === "both" ? "雙語" : m === "tc" ? "繁中" : "EN"}
                  </button>
                ))}
              </div>

              <button
                onClick={handleManualSync}
                disabled={syncing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-60 transition cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing…" : "Sync Now"}
              </button>

              {data.viewer.passcodeEnabled && (
                <button
                  onClick={handleLock}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 cursor-pointer"
                  title="Lock dashboard"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>Lock</span>
                </button>
              )}
            </div>
          </div>

          {/* Search, Watchlist Toggle, and Navigation Tabs */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav className="flex items-center gap-1 border border-slate-200 bg-slate-100/70 p-1 rounded-lg">
              {[
                { id: "meetings", labelEn: "Meetings & Agenda Diffs", labelTc: "會議及議程變動", icon: Calendar, count: filteredMeetings.length },
                { id: "documents", labelEn: "Documents & Submissions", labelTc: "文件及意見書", icon: FileText, count: filteredDocuments.length },
                { id: "questions", labelEn: "Questions (質詢)", labelTc: "立法會質詢", icon: MessageSquare, count: filteredQuestions.length },
                { id: "watchlist", labelEn: "Watchlist", labelTc: "監察清單", icon: Bookmark, count: data.watchlist.length },
              ].map((item) => {
                const Icon = item.icon;
                const active = tab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setTab(item.id as MainTab)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition cursor-pointer ${
                      active
                        ? "bg-white text-slate-900 border border-slate-200"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{lang === "tc" ? item.labelTc : item.labelEn}</span>
                    <span className="px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 text-[11px]">
                      {item.count}
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="flex items-center gap-2 flex-1 max-w-md justify-end">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by committee, CB(3)..., keyword, Member…"
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500"
                />
              </div>

              <button
                onClick={() => setWatchlistOnly((v) => !v)}
                disabled={data.watchlist.length === 0}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition cursor-pointer disabled:opacity-45 ${
                  watchlistOnly
                    ? "bg-indigo-50 text-indigo-700 border-indigo-300"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                }`}
                title={
                  data.watchlist.length === 0
                    ? "Add items to Watchlist first"
                    : "Filter to pinned watchlist rules"
                }
              >
                <Filter className="w-3.5 h-3.5" />
                <span>Watchlist Only</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5 space-y-5">
        {error && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-2.5 rounded-lg text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* KPI Signal Strip */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <div className="text-xs text-slate-500">Upcoming Meetings · 即將舉行會議</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-slate-900">{stats.upcomingMeetings}</span>
              <span className="text-xs text-emerald-700 font-medium">
                {stats.liveAgendas} agendas live
              </span>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Detected Updates · 偵測變動</span>
              {data.unreadCount > 0 && (
                <button
                  onClick={handleAckEvents}
                  className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  Mark read
                </button>
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-slate-900">{data.unreadCount}</span>
              <span className="text-xs text-slate-500">unread ({data.events.length} logged)</span>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <div className="text-xs text-slate-500">Documents &amp; Hidden Submissions</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-slate-900">{data.documents.length}</span>
              <span className="text-xs text-amber-700 font-medium">
                {stats.submissions} submissions &amp; replies
              </span>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-3.5">
            <div className="text-xs text-slate-500">質詢 Questions Tracker</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-slate-900">{stats.upcomingQ}</span>
              <span className="text-xs text-slate-600">
                tabled · {stats.answeredQ} Hansard answered
              </span>
            </div>
          </div>
        </section>

        {/* TAB 1: MEETINGS & AGENDA DIFFS */}
        {tab === "meetings" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Left: Upcoming Schedule & Deep Agenda Inspector */}
            <div className="lg:col-span-8 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs">
                  {(
                    [
                      ["upcoming", "Upcoming · 即將舉行"],
                      ["agenda_live", "Agenda Live · 已上載議程"],
                      ["all", "All Window · 全部"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setMeetingScope(id)}
                      className={`px-2.5 py-1 rounded-md border font-medium cursor-pointer ${
                        meetingScope === id
                          ? "bg-slate-900 text-white border-slate-900"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-slate-500">{filteredMeetings.length} meetings</span>
              </div>

              <div className="space-y-2.5">
                {filteredMeetings.map((m) => {
                  const key = String(m.meet_id);
                  const isOpen = Boolean(expandedMeetings[key]);
                  const items = Array.isArray(m.agenda_items_json) ? m.agenda_items_json : [];
                  const pendingCount = items.reduce(
                    (acc, it) => acc + it.papers.filter((p) => p.isToFollow).length,
                    0,
                  );
                  const livePdfCount = items.reduce(
                    (acc, it) => acc + it.papers.filter((p) => Boolean(p.url)).length,
                    0,
                  );
                  const hiddenDrawerCount = items.reduce(
                    (acc, it) => acc + (it.subLinks?.length ?? 0),
                    0,
                  );
                  const agendaHref = safeLegcoHref(
                    lang === "tc" ? m.agenda_url_tc || m.agenda_url_en : m.agenda_url_en || m.agenda_url_tc,
                  );

                  return (
                    <div
                      key={key}
                      className={`bg-white border rounded-xl overflow-hidden transition ${
                        m.cancelled ? "border-rose-200 opacity-75" : "border-slate-200"
                      }`}
                    >
                      <div className="p-3.5 flex flex-col gap-2">
                        <div className="flex items-start justify-between gap-3">
                          <button
                            onClick={() =>
                              setExpandedMeetings((prev) => ({ ...prev, [key]: !prev[key] }))
                            }
                            className="flex items-start gap-2 text-left flex-1 cursor-pointer"
                          >
                            {isOpen ? (
                              <ChevronDown className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                            )}
                            <div>
                              <div className="text-sm font-semibold text-slate-900 leading-snug">
                                {renderBi(m.subject_en, m.subject_tc)}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 mt-1">
                                <span className="inline-flex items-center gap-1 font-medium text-slate-700">
                                  <Clock className="w-3.5 h-3.5 text-slate-400" />
                                  {m.start_date_time.replace("T", " ").slice(0, 16)} HKT
                                </span>
                                <span>
                                  {renderBi(m.venue_name_en, m.venue_name_tc) || "Venue TBA"}
                                </span>
                                {m.meeting_type_en && (
                                  <span className="px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 text-[11px]">
                                    {lang === "tc" ? m.meeting_type_tc : m.meeting_type_en}
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {m.is_live && (
                              <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-200">
                                LIVE
                              </span>
                            )}
                            {m.agenda_http_status === 200 ? (
                              <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                                Agenda Live ({items.length})
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-500 border border-slate-200">
                                Agenda Pending
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pl-6 pt-1 border-t border-slate-100 text-xs">
                          <div className="flex flex-wrap items-center gap-2 text-slate-600">
                            {livePdfCount > 0 && (
                              <span className="px-2 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200">
                                {livePdfCount} agenda PDFs
                              </span>
                            )}
                            {pendingCount > 0 && (
                              <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                                {pendingCount} (to follow) watched
                              </span>
                            )}
                            {hiddenDrawerCount > 0 && (
                              <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                                {hiddenDrawerCount} hidden submission drawer(s)
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              onClick={() =>
                                handleAddWatchRule(
                                  "committee",
                                  m.committee_name_en || m.subject_en,
                                  renderBi(m.committee_name_en || m.subject_en, m.committee_name_tc || m.subject_tc),
                                )
                              }
                              className="text-slate-500 hover:text-indigo-600 font-medium cursor-pointer"
                            >
                              + Watch
                            </button>
                            {agendaHref && (
                              <a
                                href={agendaHref}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium"
                              >
                                <span>Agenda</span>
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Expanded Structured Agenda & Embedded Papers */}
                      {isOpen && (
                        <div className="bg-slate-50 border-t border-slate-200 px-4 py-3 space-y-2.5">
                          {items.length === 0 ? (
                            <div className="text-xs text-slate-500">
                              Agenda HTML is not yet published by LegCo (404). The collector probes
                              automatically on schedule and alerts as soon as it goes live.
                            </div>
                          ) : (
                            items.map((item, idx) => (
                              <div
                                key={`${item.itemNum}-${idx}`}
                                className="bg-white border border-slate-200 rounded-lg p-3 space-y-2"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="text-xs font-semibold text-slate-900">
                                    {item.itemNum} {item.title}
                                  </div>
                                  {item.remark && (
                                    <span className="text-[11px] text-slate-500 shrink-0">
                                      {item.remark}
                                    </span>
                                  )}
                                </div>

                                {item.subLinks && item.subLinks.length > 0 && (
                                  <div className="flex flex-wrap gap-1.5">
                                    {item.subLinks.map((sl, sIdx) => {
                                      const href = safeLegcoHref(sl.url);
                                      if (!href) return null;
                                      return (
                                        <a
                                          key={sIdx}
                                          href={href}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100"
                                        >
                                          <span>
                                            Drawer: {sl.label}
                                            {sl.catId ? ` (cat=${sl.catId})` : ""}
                                          </span>
                                          <ExternalLink className="w-2.5 h-2.5" />
                                        </a>
                                      );
                                    })}
                                  </div>
                                )}

                                {item.papers.length > 0 && (
                                  <ul className="space-y-1 border-t border-slate-100 pt-2">
                                    {item.papers.map((p, pIdx) => {
                                      const href = safeLegcoHref(p.url);
                                      return (
                                        <li
                                          key={pIdx}
                                          className="flex items-start justify-between gap-2 text-xs"
                                        >
                                          <div className="text-slate-700">
                                            {p.paperNo && (
                                              <span className="font-mono text-[11px] text-slate-500 mr-1.5">
                                                {p.paperNo}
                                              </span>
                                            )}
                                            <span>{p.description}</span>
                                          </div>
                                          <div className="shrink-0">
                                            {href ? (
                                              <a
                                                href={href}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium"
                                              >
                                                <span>PDF</span>
                                                <ExternalLink className="w-3 h-3" />
                                              </a>
                                            ) : p.isToFollow ? (
                                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                                                (to follow)
                                              </span>
                                            ) : p.isRestricted ? (
                                              <span className="text-[11px] text-slate-400">
                                                Restricted
                                              </span>
                                            ) : null}
                                          </div>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: Live Diff & Change Log */}
            <aside className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                  <Bell className="w-4 h-4 text-indigo-600" />
                  <span>Change &amp; Diff Stream</span>
                </div>
                {data.unreadCount > 0 && (
                  <button
                    onClick={handleAckEvents}
                    className="text-xs text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer"
                  >
                    Mark all read
                  </button>
                )}
              </div>

              <div className="space-y-2.5 max-h-[680px] overflow-y-auto pr-1">
                {filteredEvents.map((ev) => {
                  const href = safeLegcoHref(ev.link_url);
                  return (
                    <div
                      key={ev.id}
                      className={`p-3 rounded-lg border text-xs space-y-1 ${
                        ev.severity === "high"
                          ? "bg-amber-50/50 border-amber-200"
                          : "bg-slate-50 border-slate-200"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-700">
                          {ev.event_type}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {formatHktTimestamp(ev.detected_at)}
                        </span>
                      </div>
                      <div className="font-semibold text-slate-900">
                        {renderBi(ev.title_en, ev.title_tc)}
                      </div>
                      <div className="text-slate-600 leading-relaxed">
                        {renderBi(ev.summary_en, ev.summary_tc)}
                      </div>
                      {href && (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium pt-0.5"
                        >
                          <span>Open source</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            </aside>
          </div>
        )}

        {/* TAB 2: DOCUMENTS & HIDDEN SUBMISSIONS */}
        {tab === "documents" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {[
                  ["all", "All Documents"],
                  ["submission", "Submissions 意見書"],
                  ["reply", "Govt Replies 回應"],
                  ["paper", "Papers 文件"],
                  ["brief", "LegCo Briefs 摘要"],
                  ["bill", "Bills 法案"],
                  ["subleg", "Subleg 附屬法例"],
                  ["agenda", "Agendas 議程"],
                  ["minutes", "Minutes 紀要"],
                  ["press", "Press 新聞稿"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setDocTypeFilter(id)}
                    className={`px-2.5 py-1 rounded-md border font-medium cursor-pointer ${
                      docTypeFilter === id
                        ? "bg-slate-900 text-white border-slate-900"
                        : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <select
                value={docSourceFilter}
                onChange={(e) => setDocSourceFilter(e.target.value)}
                className="text-xs bg-white border border-slate-200 rounded-md px-2.5 py-1 text-slate-700"
              >
                <option value="all">All Sources (RSS + Agenda + /bi/data/)</option>
                <option value="bi_json">Hidden Committee JSON (/bi/data/)</option>
                <option value="agenda">Agenda-Embedded PDFs</option>
                <option value="rss">RSS Feeds</option>
              </select>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
              {filteredDocuments.map((d) => {
                const badge = DOC_TYPE_LABELS[d.doc_type] ?? DOC_TYPE_LABELS.paper;
                const urlEn = safeLegcoHref(d.url_en);
                const urlTc = safeLegcoHref(d.url_tc);

                return (
                  <div
                    key={d.id}
                    className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/70 transition"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className={`px-2 py-0.5 rounded-full border font-medium ${badge.tone}`}>
                          {lang === "tc" ? badge.tc : badge.en}
                        </span>
                        {d.paper_no && (
                          <span className="font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                            {d.paper_no}
                          </span>
                        )}
                        <span className="px-1.5 py-0.5 rounded bg-slate-50 text-slate-500 border border-slate-200">
                          {d.source_kind === "bi_json"
                            ? "Committee JSON"
                            : d.source_kind === "agenda"
                              ? "Agenda PDF"
                              : "RSS"}
                        </span>
                        {(d.committee_name_en || d.committee_name_tc) && (
                          <span className="text-slate-600 font-medium">
                            {renderBi(d.committee_name_en, d.committee_name_tc)}
                          </span>
                        )}
                      </div>

                      <div className="text-sm font-medium text-slate-900">
                        {renderBi(d.title_en, d.title_tc)}
                      </div>

                      {(d.related_paper_no || d.reply_to_paper_no || d.issue_date || d.meeting_date) && (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          {d.issue_date && <span>Issued: {d.issue_date}</span>}
                          {d.meeting_date && <span>Meeting: {d.meeting_date}</span>}
                          {d.related_paper_no && (
                            <span className="text-emerald-700 font-medium">
                              Govt Reply: {d.related_paper_no}
                            </span>
                          )}
                          {d.reply_to_paper_no && (
                            <span className="text-amber-700 font-medium">
                              Re: Submission {d.reply_to_paper_no}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0 text-xs">
                      {urlTc && (
                        <a
                          href={urlTc}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-700 hover:border-indigo-300 hover:text-indigo-700 font-medium"
                        >
                          <span>繁中</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      {urlEn && (
                        <a
                          href={urlEn}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-700 hover:border-indigo-300 hover:text-indigo-700 font-medium"
                        >
                          <span>EN</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 3: QUESTIONS (質詢 TRACKER) */}
        {tab === "questions" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs">
                {(
                  [
                    ["all", "All Stages"],
                    ["upcoming", "Upcoming / Tabled · 議程待答"],
                    ["answered", "Answered · 會議紀錄 Hansard"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setQStageFilter(id)}
                    className={`px-2.5 py-1 rounded-md border font-medium cursor-pointer ${
                      qStageFilter === id
                        ? "bg-slate-900 text-white border-slate-900"
                        : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1.5 text-xs">
                {(
                  [
                    ["all", "All Types"],
                    ["oral", "Oral 口頭"],
                    ["written", "Written 書面"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setQTypeFilter(id)}
                    className={`px-2.5 py-1 rounded-md border font-medium cursor-pointer ${
                      qTypeFilter === id
                        ? "bg-indigo-600 text-white border-indigo-600"
                        : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
              {filteredQuestions.map((q) => {
                const isOpen = Boolean(expandedQuestions[q.question_key]);
                const agendaEn = safeLegcoHref(q.agenda_url_en);
                const agendaTc = safeLegcoHref(q.agenda_url_tc);
                const hansardEn = safeLegcoHref(q.hansard_url_en);
                const hansardTc = safeLegcoHref(q.hansard_url_tc);
                const replyEn = safeLegcoHref(q.reply_url_en);
                const replyTc = safeLegcoHref(q.reply_url_tc);
                const linkEn = q.stage === "upcoming" ? agendaEn : hansardEn || replyEn || agendaEn;
                const linkTc = q.stage === "upcoming" ? agendaTc : hansardTc || replyTc || agendaTc;
                const linkLabelEn =
                  q.stage === "upcoming"
                    ? q.agenda_url_en?.includes("#q_")
                      ? "EN Agenda"
                      : "EN Questions"
                    : hansardEn
                      ? "EN Hansard"
                      : replyEn
                        ? "EN Reply"
                        : "EN Questions";
                const linkLabelTc =
                  q.stage === "upcoming"
                    ? q.agenda_url_tc?.includes("#q_")
                      ? "繁中議程"
                      : "繁中質詢"
                    : hansardTc
                      ? "繁中 Hansard"
                      : replyTc
                        ? "繁中回覆"
                        : "繁中質詢";

                return (
                  <div key={q.id} className="p-3.5 space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span
                            className={`px-2 py-0.5 rounded-full border font-medium ${
                              q.stage === "upcoming"
                                ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                                : "bg-emerald-50 text-emerald-700 border-emerald-200"
                            }`}
                          >
                            {q.stage === "upcoming"
                              ? "Upcoming Agenda"
                              : hansardEn || hansardTc
                                ? "Hansard Answered"
                                : "Govt Reply Live"}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full border font-medium ${
                              q.question_type === "oral"
                                ? "bg-amber-50 text-amber-800 border-amber-200"
                                : "bg-slate-100 text-slate-700 border-slate-200"
                            }`}
                          >
                            {q.question_type === "oral" ? "Oral 口頭" : "Written 書面"}
                            {q.question_no ? ` #${q.question_no}` : ""}
                          </span>
                          <span className="font-mono text-slate-500">{q.meeting_date}</span>
                          <span className="font-medium text-slate-700">
                            {renderBi(q.member_name_en, q.member_name_tc)}
                          </span>
                        </div>

                        <div className="text-sm font-semibold text-slate-900">
                          {renderBi(q.subject_en, q.subject_tc)}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 text-xs">
                        {(q.body_en || q.body_tc) && (
                          <button
                            onClick={() =>
                              setExpandedQuestions((prev) => ({
                                ...prev,
                                [q.question_key]: !prev[q.question_key],
                              }))
                            }
                            className="px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 font-medium cursor-pointer"
                          >
                            {isOpen ? "Hide Text" : "Read Text"}
                          </button>
                        )}
                        {linkTc && (
                          <a
                            href={linkTc}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-700 hover:border-indigo-300 font-medium"
                          >
                            <span>{linkLabelTc}</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                        {linkEn && (
                          <a
                            href={linkEn}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-700 hover:border-indigo-300 font-medium"
                          >
                            <span>{linkLabelEn}</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>

                    {isOpen && (q.body_en || q.body_tc) && (
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700 space-y-2 leading-relaxed whitespace-pre-line">
                        {q.body_tc && (lang === "both" || lang === "tc") && <p>{q.body_tc}</p>}
                        {q.body_en && (lang === "both" || lang === "en") && <p>{q.body_en}</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 4: WATCHLIST */}
        {tab === "watchlist" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Add Watchlist Rule · 新增監察條件
              </h2>
              <p className="text-xs text-slate-500">
                Track specific LegCo committees, policy keywords (e.g. &ldquo;Northern Metropolis&rdquo;,
                &ldquo;AI&rdquo;, &ldquo;房屋&rdquo;), or Members. Toggle &ldquo;Watchlist Only&rdquo; in
                the top bar to focus every view.
              </p>
              <div className="flex gap-2">
                <select
                  value={newRuleType}
                  onChange={(e) =>
                    setNewRuleType(e.target.value as "committee" | "keyword" | "member")
                  }
                  className="text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-slate-700"
                >
                  <option value="keyword">Keyword 關鍵詞</option>
                  <option value="committee">Committee 委員會</option>
                  <option value="member">Member 議員</option>
                </select>
                <input
                  value={newRuleValue}
                  onChange={(e) => setNewRuleValue(e.target.value)}
                  placeholder="Enter keyword, committee, or Member name…"
                  className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={() => handleAddWatchRule(newRuleType, newRuleValue)}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add
                </button>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Active Rules ({data.watchlist.length})
              </h2>
              {data.watchlist.length === 0 ? (
                <div className="text-xs text-slate-500 py-4">
                  No watchlist rules yet. Click &ldquo;+ Watch&rdquo; on any meeting or add a keyword
                  on the left.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.watchlist.map((rule) => (
                    <li key={rule.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                      <div>
                        <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 mr-2">
                          {rule.rule_type}
                        </span>
                        <span className="font-medium text-slate-900">{rule.label}</span>
                      </div>
                      <button
                        onClick={() => handleDeleteWatchRule(rule.id)}
                        className="text-slate-400 hover:text-rose-600 p-1 cursor-pointer"
                        title="Remove rule"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
