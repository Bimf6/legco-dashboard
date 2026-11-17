export interface WorkingHoursStatus {
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

const WORKING_START_HOUR = 8;
const WORKING_END_HOUR = 20;
const WORKING_INTERVAL_MS = 5 * 60 * 1000;
const OFF_HOURS_INTERVAL_MS = 30 * 60 * 1000;

export function getHktParts(date = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  isSunday: boolean;
  isoDate: string;
  clock: string;
} {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  const weekday = get("weekday");

  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    isSunday: weekday === "Sun",
    isoDate: `${year}-${pad(month)}-${pad(day)}`,
    clock: `${pad(hour)}:${pad(minute)}:${pad(second)}`,
  };
}

export function getWorkingHoursStatus(date = new Date()): WorkingHoursStatus {
  const hkt = getHktParts(date);
  const inTimeWindow = hkt.hour >= WORKING_START_HOUR && hkt.hour < WORKING_END_HOUR;
  const isWorkingHours = inTimeWindow && !hkt.isSunday;
  const mode = isWorkingHours ? "working_hours" : "off_hours";
  const recommendedIntervalMs = isWorkingHours
    ? WORKING_INTERVAL_MS
    : OFF_HOURS_INTERVAL_MS;

  return {
    hktNowIso: `${hkt.isoDate}T${hkt.clock}+08:00`,
    hktClock: `${hkt.isoDate} ${hkt.clock} HKT (${hkt.weekday})`,
    hktDayName: hkt.weekday,
    isWorkingHours,
    mode,
    recommendedIntervalMs,
    recommendedIntervalMinutes: recommendedIntervalMs / 60000,
    windowLabelEn: isWorkingHours
      ? "Active Window (08:00–20:00 HKT · 5m cadence)"
      : "Off-Hours Window (20:00–08:00 HKT / Sun · 30m cadence)",
    windowLabelTc: isWorkingHours
      ? "辦公時間監察 (08:00–20:00 HKT · 每5分鐘)"
      : "非辦公時間 (20:00–08:00 HKT / 週日 · 每30分鐘)",
  };
}

export function isSyncDue(
  lastSyncAt: Date | string | null | undefined,
  now = new Date(),
): boolean {
  if (!lastSyncAt) return true;
  const lastMs = typeof lastSyncAt === "string" ? Date.parse(lastSyncAt) : lastSyncAt.getTime();
  if (Number.isNaN(lastMs)) return true;
  const { recommendedIntervalMs } = getWorkingHoursStatus(now);
  return now.getTime() - lastMs >= recommendedIntervalMs;
}
