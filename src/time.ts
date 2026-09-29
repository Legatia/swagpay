const WARSAW = "Europe/Warsaw";

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: WARSAW,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: WARSAW,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Calendar date (YYYY-MM-DD) of `d` in Warsaw. */
export function warsawDate(d: Date): string {
  return dateFmt.format(d);
}

function warsawWallClockMs(d: Date): number {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** "YYYY-MM-DDTHH:MM" in Warsaw wall time -> the UTC instant. */
export function warsawLocalToUtc(local: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`Expected YYYY-MM-DDTHH:MM, got "${local}"`);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) {
    throw new Error(`Not a real date and time: "${local}"`);
  }
  // Two passes settle the offset, including on DST change days.
  let guess = asUtc;
  for (let i = 0; i < 2; i++) guess = asUtc - (warsawWallClockMs(new Date(guess)) - guess);
  return new Date(guess);
}

// Polish public holidays that fall in the pilot period (Sundays included for completeness).
const PL_HOLIDAYS = new Set([
  "2026-11-01", "2026-11-11", "2026-12-24", "2026-12-25", "2026-12-26",
  "2027-01-01", "2027-01-06", "2027-03-28", "2027-03-29", "2027-05-01", "2027-05-03",
  "2027-05-16", "2027-05-27", "2027-08-15", "2027-11-01", "2027-11-11",
  "2027-12-24", "2027-12-25", "2027-12-26",
]);

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isPolishBusinessDay(ymd: string): boolean {
  const weekday = new Date(ymdToUtcMs(ymd)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !PL_HOLIDAYS.has(ymd);
}

/** Business days strictly after today and strictly before the deadline's day, in Warsaw. */
export function businessDaysBetween(now: Date, deadline: Date): number {
  const DAY = 86_400_000;
  const start = ymdToUtcMs(warsawDate(now)) + DAY;
  const end = ymdToUtcMs(warsawDate(deadline));
  let count = 0;
  for (let t = start; t < end; t += DAY) if (isPolishBusinessDay(utcMsToYmd(t))) count++;
  return count;
}

/**
 * The first Warsaw midnight after `now` from which fewer than `requiredDays` business days remain before `deadline`;
 * the deadline itself if earlier. Looks at most 60 days ahead and returns the 60th midnight when nothing earlier qualifies.
 */
export function leadTimeCutoff(now: Date, deadline: Date, requiredDays: number): Date {
  const DAY = 86_400_000;
  const today = ymdToUtcMs(warsawDate(now));
  let midnight = now;
  for (let i = 1; i <= 60; i++) {
    midnight = warsawLocalToUtc(`${utcMsToYmd(today + i * DAY)}T00:00`);
    if (midnight.getTime() >= deadline.getTime()) return deadline;
    if (businessDaysBetween(midnight, deadline) < requiredDays) return midnight;
  }
  return midnight;
}
