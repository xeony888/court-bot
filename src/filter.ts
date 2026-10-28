export interface WatchFilter {
  rangeMode: "ABSOLUTE" | "RELATIVE";
  dateFrom: string | null;
  dateTo: string | null;
  minDaysOut: number | null;
  maxDaysOut: number | null;
  weekdays: number[];
  timeFrom: string | null;
  timeTo: string | null;
}

export interface DateWindow {
  /** Inclusive YYYY-MM-DD bounds. */
  from: string;
  to: string;
}

/** Current calendar date in Los Angeles, YYYY-MM-DD. Court dates use this time zone. */
export function laToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Returns the inclusive date window for a watch, or null when the window is empty. */
export function dateWindow(watch: WatchFilter, today: string): DateWindow | null {
  let from: string;
  let to: string;
  if (watch.rangeMode === "ABSOLUTE") {
    if (!watch.dateFrom || !watch.dateTo) return null;
    from = watch.dateFrom > today ? watch.dateFrom : today;
    to = watch.dateTo;
  } else {
    if (watch.minDaysOut === null || watch.maxDaysOut === null) return null;
    from = addDays(today, watch.minDaysOut);
    to = addDays(today, watch.maxDaysOut);
  }
  return from <= to ? { from, to } : null;
}

/** Tests a local start time (YYYY-MM-DDTHH:MM) against the watch window and filters. */
export function slotMatches(watch: WatchFilter, window: DateWindow, startsAt: string): boolean {
  const date = startsAt.slice(0, 10);
  const time = startsAt.slice(11, 16);
  if (date < window.from || date > window.to) return false;
  if (watch.weekdays.length > 0 && !watch.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay())) return false;
  if (watch.timeFrom && time < watch.timeFrom) return false;
  if (watch.timeTo && time > watch.timeTo) return false;
  return true;
}
