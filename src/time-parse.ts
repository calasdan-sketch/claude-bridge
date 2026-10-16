// Natural-language time-phrase parser for time-aware search.
//
// parseTimePhrase() finds a time reference ANYWHERE in a string (e.g.
// "yesterday about the budget" -> yesterday's range; the keywords are the
// caller's job) and returns the [start, end) UTC range it denotes, or null
// when nothing recognizable is present.
//
// Day boundaries are computed in the user's timezone (ONEMEMORY_TIMEZONE,
// default "UTC") via Intl.DateTimeFormat -- zero dependencies. Wall-clock
// arithmetic is done on nominal date parts, then converted to true UTC
// instants by measuring the zone offset at the candidate instant and
// iterating (converges even across DST transitions; never throws).
//
// Documented choices (deviations from any "obvious" reading are deliberate):
//   - Weeks start on MONDAY ("last week" = previous Mon 00:00 -> this Mon 00:00).
//   - Dayparts: morning 05:00-12:00, afternoon 12:00-17:00, evening 17:00-22:00,
//     night 22:00-05:00 (next day). "tonight" = today 17:00 -> tomorrow 05:00
//     (evening + night combined); "last night" = yesterday 22:00 -> today 05:00.
//   - Clock times ("around 3pm", "at 14:30", "3pm yesterday") get a +/-30 min
//     window around the named time.
//   - Ambiguous numeric dates are MM/DD (never DD/MM). A bare month/day
//     without a year assumes the current year, or the previous year when that
//     date would otherwise be in the future ("most recent past occurrence").
//   - Bare month names ("in july") mean the most recent such month including
//     the current one, never a future month.
//   - "N days ago" accepts digits 1-365 plus "a"/"an" (= 1).
//   - Ranges are [start, end): start inclusive, end exclusive, as UTC Dates.
//   - Garbage / unparseable input returns null, never throws.

/** A [start, end) UTC range denoted by a time phrase. */
export interface TimeRange {
  /** Inclusive lower bound, as a UTC instant. */
  start: Date;
  /** Exclusive upper bound, as a UTC instant. */
  end: Date;
  /** Human-readable description, e.g. "yesterday (2026-10-15, America/Winnipeg)". */
  label: string;
}

export interface ParseOpts {
  /** Reference instant; defaults to new Date(). Injected in tests for determinism. */
  now?: Date;
  /** IANA timezone name; defaults to ONEMEMORY_TIMEZONE env or "UTC". */
  timeZone?: string;
}

/**
 * Validate an IANA timezone name. Invalid names log once to stderr and fall
 * back to "UTC" -- never throw, so a typo in ONEMEMORY_TIMEZONE can't break
 * search.
 */
export function resolveTimeZone(raw?: string): string {
  const tz = (raw ?? process.env.ONEMEMORY_TIMEZONE ?? "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    if (tz !== "UTC") {
      // eslint-disable-next-line no-console
      console.error(`[onememory] invalid timezone "${tz}"; falling back to UTC`);
    }
    return "UTC";
  }
}

// ---------------------------------------------------------------------------
// Timezone math (Intl only, no libraries)
// ---------------------------------------------------------------------------

interface WallParts {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
}

const partsFmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    partsFmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock components of an instant in the given zone. */
function wallParts(d: Date, tz: string): WallParts {
  const p: Record<string, number> = {};
  for (const part of partsFormatter(tz).formatToParts(d)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute };
}

/**
 * Zone offset in ms such that wallClock = utc + offset. Positive east of UTC.
 */
function zoneOffsetMs(d: Date, tz: string): number {
  const w = wallParts(d, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - d.getTime();
}

/**
 * Convert a zone wall-clock reading to the true UTC instant. Iterates the
 * offset correction so DST transitions converge instead of throwing.
 */
function wallToUtc(w: WallParts, tz: string): Date {
  let guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  for (let i = 0; i < 4; i++) {
    const next = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - zoneOffsetMs(new Date(guess), tz);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** Add n days to a nominal wall-clock date (month/year rollover handled). */
function shiftDays(w: { y: number; mo: number; d: number }, n: number): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Whole wall-clock day as a [start, end) UTC range. */
function dayRange(w: { y: number; mo: number; d: number }, tz: string, label: string): TimeRange {
  const start = wallToUtc({ ...w, h: 0, mi: 0 }, tz);
  const n = shiftDays(w, 1);
  const end = wallToUtc({ ...n, h: 0, mi: 0 }, tz);
  return { start, end, label };
}

/** Wall-clock window [h1:mi1, h2:mi2), where the end may fall on the next day. */
function windowRange(
  day: { y: number; mo: number; d: number },
  h1: number,
  mi1: number,
  h2: number,
  mi2: number,
  tz: string,
  label: string
): TimeRange {
  const start = wallToUtc({ ...day, h: h1, mi: mi1 }, tz);
  const endDay = h2 * 60 + mi2 <= h1 * 60 + mi1 ? shiftDays(day, 1) : day;
  const end = wallToUtc({ ...endDay, h: h2, mi: mi2 }, tz);
  return { start, end, label };
}

function ymd(w: { y: number; mo: number; d: number }): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${p(w.mo)}-${p(w.d)}`;
}

// ---------------------------------------------------------------------------
// Phrase matching
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};
// Longest-first so "sept" wins over "sep" before the word boundary check.
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

const DAYPARTS: Record<string, [number, number, number, number]> = {
  morning: [5, 0, 12, 0],
  afternoon: [12, 0, 17, 0],
  evening: [17, 0, 22, 0],
  night: [22, 0, 5, 0], // ends next day
};
const DAYPART_ALT = Object.keys(DAYPARTS).join("|");

/**
 * Find a natural-language time reference anywhere in `phrase` and return its
 * UTC [start, end) range. Returns null when nothing recognizable is present;
 * never throws.
 */
export function parseTimePhrase(phrase: string, opts: ParseOpts = {}): TimeRange | null {
  try {
    return parseTimePhraseInner(phrase, opts);
  } catch {
    return null; // garbage in -> null out, never an exception
  }
}

function parseTimePhraseInner(phrase: string, opts: ParseOpts): TimeRange | null {
  if (!phrase || typeof phrase !== "string") return null;
  const s = phrase.toLowerCase().trim();
  if (!s) return null;

  const tz = resolveTimeZone(opts.timeZone);
  const now = opts.now ?? new Date();
  const w = wallParts(now, tz); // wall clock "today"
  const today = { y: w.y, mo: w.mo, d: w.d };
  const tag = (name: string, day: { y: number; mo: number; d: number }) =>
    `${name} (${ymd(day)}, ${tz})`;

  // -- Dayparts with an explicit day anchor ---------------------------------
  // "this morning", "yesterday evening", "tonight", "last night"
  let m = s.match(new RegExp(`\\b(this|yesterday)\\s+(${DAYPART_ALT})\\b`));
  if (m) {
    const day = m[1] === "yesterday" ? shiftDays(today, -1) : today;
    const [h1, mi1, h2, mi2] = DAYPARTS[m[2]];
    return windowRange(day, h1, mi1, h2, mi2, tz, tag(`${m[1]} ${m[2]}`, day));
  }
  if (/\btonight\b/.test(s)) {
    // Evening + night combined: today 17:00 -> tomorrow 05:00.
    return windowRange(today, 17, 0, 5, 0, tz, tag("tonight", today));
  }
  if (/\blast\s+night\b/.test(s)) {
    const day = shiftDays(today, -1);
    return windowRange(day, 22, 0, 5, 0, tz, tag("last night", day));
  }

  // -- Clock times: "around 3pm", "at 14:30", "3pm yesterday" -----------------
  // +/-30 minute window around the named time (documented approximation).
  m = s.match(
    /\b(?:(yesterday|today)\s+)?(?:around|about|at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+(yesterday|today))?\b/
  ) || s.match(/\b(?:around|about|at)\s+(\d{1,2}):(\d{2})(?:\s+(yesterday|today))?\b/);
  if (m) {
    let hour: number, minute: number, anchor: string | undefined, ampm: string | undefined;
    if (m[4] === "am" || m[4] === "pm") {
      // 12-hour form: groups are (anchor)(hour)(minute)(ampm)(anchor)
      anchor = m[1] ?? m[5];
      hour = Number(m[2]);
      minute = Number(m[3] ?? "0");
      ampm = m[4];
      if (hour < 1 || hour > 12 || minute > 59) return null;
      hour = hour % 12 + (ampm === "pm" ? 12 : 0);
    } else {
      // 24-hour form: groups are (hour)(minute)(anchor)
      anchor = m[3];
      hour = Number(m[1]);
      minute = Number(m[2]);
      if (hour > 23 || minute > 59) return null;
    }
    const day = anchor === "yesterday" ? shiftDays(today, -1) : today;
    const centerMin = hour * 60 + minute;
    const lo = Math.max(0, centerMin - 30);
    const hi = centerMin + 30;
    return windowRange(
      day,
      Math.floor(lo / 60), lo % 60,
      Math.floor(hi / 60) % 24, hi % 60,
      tz,
      `${anchor === "yesterday" ? "yesterday " : ""}around ${hour}:${String(minute).padStart(2, "0")} (${tz})`
    );
  }

  // -- Absolute dates ---------------------------------------------------------
  // YYYY-MM-DD
  m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      // Guard against rollover (e.g. month 13 already excluded; Feb 30
      // rolls to Mar 2 -- reject by round-tripping).
      const probe = new Date(Date.UTC(y, mo - 1, d));
      if (probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d) {
        const day = { y, mo, d };
        return dayRange(day, tz, tag(ymd(day), day));
      }
    }
  }
  // MM/DD/YYYY (deliberately MM/DD, never DD/MM -- documented)
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]), y = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const day = { y, mo, d };
      return dayRange(day, tz, tag(ymd(day), day));
    }
  }
  // "Oct 14", "October 14 2025", "Oct 14th" -- year optional
  m = s.match(new RegExp(`\\b(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`));
  if (m) {
    const mo = MONTHS[m[1]] + 1;
    const d = Number(m[2]);
    if (d >= 1 && d <= 31) {
      let y = m[3] ? Number(m[3]) : w.y;
      if (!m[3]) {
        // No year: current year, or previous year if that date is in the future.
        const thisYear = new Date(Date.UTC(y, mo - 1, d));
        const todayUtc = new Date(Date.UTC(w.y, w.mo - 1, w.d));
        if (thisYear > todayUtc) y -= 1;
      }
      const day = { y, mo, d };
      return dayRange(day, tz, tag(ymd(day), day));
    }
  }
  // Bare MM/DD -- same "most recent past occurrence" rule as above
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = w.y;
      const thisYear = new Date(Date.UTC(y, mo - 1, d));
      const todayUtc = new Date(Date.UTC(w.y, w.mo - 1, w.d));
      if (thisYear > todayUtc) y -= 1;
      const day = { y, mo, d };
      return dayRange(day, tz, tag(ymd(day), day));
    }
  }

  // -- "in <month>" / "in <month> <year>" --------------------------------------
  m = s.match(new RegExp(`\\bin\\s+(${MONTH_ALT})(?:\\s+(\\d{4}))?\\b`));
  if (m) {
    const mo = MONTHS[m[1]];
    let y = m[2] ? Number(m[2]) : w.y;
    if (!m[2] && mo > w.mo - 1) y -= 1; // most recent such month, never future
    const start = wallToUtc({ y, mo: mo + 1, d: 1, h: 0, mi: 0 }, tz);
    const endMo = mo === 11 ? { y: y + 1, mo: 1 } : { y, mo: mo + 2 };
    const end = wallToUtc({ ...endMo, d: 1, h: 0, mi: 0 }, tz);
    const name = m[1][0].toUpperCase() + m[1].slice(1);
    return { start, end, label: `${name} ${y} (${tz})` };
  }

  // -- Relative weeks / months --------------------------------------------------
  if (/\blast\s+week\b/.test(s)) {
    // Monday-start weeks (documented).
    const dowMon0 = (new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay() + 6) % 7;
    const thisMon = shiftDays(today, -dowMon0);
    const lastMon = shiftDays(thisMon, -7);
    const start = wallToUtc({ ...lastMon, h: 0, mi: 0 }, tz);
    const end = wallToUtc({ ...thisMon, h: 0, mi: 0 }, tz);
    return { start, end, label: `last week (${ymd(lastMon)}..${ymd(thisMon)}, ${tz})` };
  }
  if (/\bthis\s+week\b/.test(s)) {
    const dowMon0 = (new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay() + 6) % 7;
    const thisMon = shiftDays(today, -dowMon0);
    const nextMon = shiftDays(thisMon, 7);
    const start = wallToUtc({ ...thisMon, h: 0, mi: 0 }, tz);
    const end = wallToUtc({ ...nextMon, h: 0, mi: 0 }, tz);
    return { start, end, label: `this week (${ymd(thisMon)}..${ymd(nextMon)}, ${tz})` };
  }
  if (/\blast\s+month\b/.test(s)) {
    const prev = w.mo === 1 ? { y: w.y - 1, mo: 12 } : { y: w.y, mo: w.mo - 1 };
    const start = wallToUtc({ ...prev, d: 1, h: 0, mi: 0 }, tz);
    const end = wallToUtc({ y: w.y, mo: w.mo, d: 1, h: 0, mi: 0 }, tz);
    return { start, end, label: `last month (${tz})` };
  }
  if (/\bthis\s+month\b/.test(s)) {
    const next = w.mo === 12 ? { y: w.y + 1, mo: 1 } : { y: w.y, mo: w.mo + 1 };
    const start = wallToUtc({ y: w.y, mo: w.mo, d: 1, h: 0, mi: 0 }, tz);
    const end = wallToUtc({ ...next, d: 1, h: 0, mi: 0 }, tz);
    return { start, end, label: `this month (${tz})` };
  }

  // -- Relative days: "N days ago", "a day ago", "yesterday", "today" ------------
  m = s.match(/\b(?:(\d{1,3})|a|an)\s+days?\s+ago\b/);
  if (m) {
    const n = m[1] ? Number(m[1]) : 1;
    if (n < 1 || n > 365) return null;
    const day = shiftDays(today, -n);
    return dayRange(day, tz, tag(`${n} day${n === 1 ? "" : "s"} ago`, day));
  }
  if (/\byesterday\b/.test(s)) {
    const day = shiftDays(today, -1);
    return dayRange(day, tz, tag("yesterday", day));
  }
  if (/\btoday\b/.test(s)) {
    return dayRange(today, tz, tag("today", today));
  }

  return null;
}

/**
 * Pure range filter over note records: keeps notes whose created_at falls in
 * [range.start, range.end). Exported so it is unit-testable without a DB.
 */
export function filterByTimeRange<T extends { created_at: string }>(
  notes: T[],
  range: { start: Date; end: Date }
): T[] {
  const lo = range.start.getTime();
  const hi = range.end.getTime();
  return notes.filter((n) => {
    const t = Date.parse(n.created_at);
    return Number.isFinite(t) && t >= lo && t < hi;
  });
}
