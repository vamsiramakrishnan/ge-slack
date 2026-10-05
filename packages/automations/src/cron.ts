/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) evaluated in an IANA time zone.
 * Supports `*`, lists, ranges and steps — the forms `scheduleTextToCron` produces plus common
 * literals. Day-of-month and day-of-week combine with OR when both are restricted (Vixie cron).
 */
export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function field(text: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/') as [string, string | undefined];
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step "${part}"`);
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = b !== undefined ? Number(b) : stepText ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron value out of range "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && max === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron needs 5 fields');
  return {
    minutes: field(f[0]!, 0, 59),
    hours: field(f[1]!, 0, 23),
    doms: field(f[2]!, 1, 31),
    months: field(f[3]!, 1, 12),
    dows: field(f[4]!, 0, 7),
    domRestricted: f[2] !== '*',
    dowRestricted: f[4] !== '*',
  };
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dow: number;
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(date: Date, timeZone: string): Parts {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    dow: DOW[p.weekday as string] ?? 0,
  };
}

function dayMatches(spec: CronSpec, p: Parts): boolean {
  if (!spec.months.has(p.month)) return false;
  const dom = spec.doms.has(p.day);
  const dow = spec.dows.has(p.dow);
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}

/** Next fire time strictly after `from`, searching up to ~400 days. */
export function nextCronRun(expr: string, from: Date, timeZone = 'UTC'): Date | undefined {
  const spec = parseCron(expr);
  // Start at the next whole minute.
  let t = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const limit = from.getTime() + 400 * 86_400_000;
  while (t <= limit) {
    const p = partsIn(new Date(t), timeZone);
    if (!dayMatches(spec, p)) {
      // Jump to the next local midnight (approximately; re-evaluated each step, DST-safe).
      t += ((23 - p.hour) * 60 + (60 - p.minute)) * 60_000;
      continue;
    }
    if (!spec.hours.has(p.hour)) {
      t += (60 - p.minute) * 60_000;
      continue;
    }
    if (spec.minutes.has(p.minute)) return new Date(t);
    t += 60_000;
  }
  return undefined;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
