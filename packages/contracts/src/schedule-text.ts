/**
 * Human schedule text → 5-field cron. Deliberately small: the plan card always echoes both the text
 * and the computed next run, so an unexpected interpretation is visible before approval.
 *
 *   weekdays 9:00 · weekdays at 9am · daily 17:00 · every day at 5:30pm · every monday 08:30
 *   mondays at 8am · hourly · cron literal "0 9 * * 1-5"
 */
const DAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const CRON_FIELD = /^(\*|\d{1,2}(-\d{1,2})?(,\d{1,2}(-\d{1,2})?)*)(\/\d{1,2})?$/;

export function isCronLiteral(text: string): boolean {
  const fields = text.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
}

function parseTime(text: string): { h: number; m: number } | undefined {
  const t = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
  if (!t) return undefined;
  let h = Number(t[1]);
  const m = t[2] ? Number(t[2]) : 0;
  const ap = t[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return undefined;
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  } else if (!t[2]) {
    return undefined; // a bare "9" is ambiguous; require 9:00 or 9am
  }
  if (h > 23 || m > 59) return undefined;
  return { h, m };
}

export type ScheduleParse = { ok: true; cron: string } | { ok: false; error: string };

export function scheduleTextToCron(input: string): ScheduleParse {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (isCronLiteral(text)) return { ok: true, cron: text };
  if (text === 'hourly' || text === 'every hour') return { ok: true, cron: '0 * * * *' };

  const m = /^(every\s+)?(day|daily|weekday|weekdays|[a-z]+?)s?\s+(?:at\s+)?(.+)$/.exec(text);
  if (!m) return { ok: false, error: `couldn't read the schedule "${input}"` };
  const when = m[2]!;
  const time = parseTime(m[3]!);
  if (!time) return { ok: false, error: `couldn't read the time in "${input}" — try 9:00 or 9am` };
  let dow: string;
  if (when === 'day' || when === 'daily') dow = '*';
  else if (when === 'weekday') dow = '1-5';
  else if (when in DAYS) dow = String(DAYS[when]);
  else return { ok: false, error: `unknown day "${when}" in "${input}"` };
  return { ok: true, cron: `${time.m} ${time.h} * * ${dow}` };
}
