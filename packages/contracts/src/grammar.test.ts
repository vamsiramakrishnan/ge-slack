import { describe, expect, it } from 'vitest';
import { parseCommand, renderInvocation, tokenize, isSafePattern } from './grammar.js';
import { scheduleTextToCron } from './schedule-text.js';
import { parsePermalink, parseDuration } from './scope.js';

describe('tokenize', () => {
  it('keeps quoted strings, smart quotes and slack entities whole', () => {
    const t = tokenize('draft “a reply” <#C123|eng> <@U1|maya> --since 7d');
    expect(t.map((x) => x.text)).toEqual([
      'draft',
      'a reply',
      '<#C123|eng>',
      '<@U1|maya>',
      '--since',
      '7d',
    ]);
    expect(t[1]!.quoted).toBe(true);
  });
});

describe('parseCommand', () => {
  it('empty text opens the composer', () => {
    expect(parseCommand('   ')).toEqual({ kind: 'compose' });
  });

  it('parses verb, channel scope, grounds, people, flags and instruction', () => {
    const r = parseCommand(
      'summarize <#C0ENG|eng-incidents> @unit @runbooks from:<@U0MAYA> --since 7d --to <#C0DIG|digest> "focus on root causes"',
    );
    expect(r.kind).toBe('invoke');
    if (r.kind !== 'invoke') return;
    const inv = r.invocation;
    expect(inv.verb).toBe('summarize');
    expect(inv.scope).toEqual({ kind: 'channel', channel: 'C0ENG' });
    expect(inv.grounds).toEqual([{ kind: 'unit' }, { kind: 'alias', alias: 'runbooks' }]);
    expect(inv.from).toEqual(['U0MAYA']);
    expect(inv.flags).toEqual({ sinceMs: 7 * 86_400_000, to: 'C0DIG' });
    expect(inv.instruction).toBe('focus on root causes');
  });

  it('treats a leading slash and aliases as verbs', () => {
    const r = parseCommand('/tldr this thread');
    expect(r.kind === 'invoke' && r.invocation.verb).toBe('summarize');
    expect(r.kind === 'invoke' && r.invocation.scope).toEqual({ kind: 'thread' });
  });

  it('turns free text into an inferred ask', () => {
    const r = parseCommand('what did we decide about the Q3 freeze?');
    expect(r.kind).toBe('invoke');
    if (r.kind !== 'invoke') return;
    expect(r.invocation.verb).toBe('ask');
    expect(r.invocation.inferredVerb).toBe(true);
    expect(r.invocation.instruction).toBe('what did we decide about the Q3 freeze?');
  });

  it('reads a permalink as message scope', () => {
    const r = parseCommand('explain <https://acme.slack.com/archives/C0ENG/p1700000000123456>');
    expect(r.kind === 'invoke' && r.invocation.scope).toEqual({
      kind: 'message',
      channel: 'C0ENG',
      ts: '1700000000.123456',
    });
  });

  it('rejects two different scopes', () => {
    const r = parseCommand('summarize <#C0A> <#C0B>');
    expect(r.kind).toBe('error');
  });

  it('collapses grounds when @this is present and warns', () => {
    const r = parseCommand('ask @this @unit why?');
    expect(r.kind === 'invoke' && r.invocation.grounds).toEqual([{ kind: 'this' }]);
    expect(r.kind === 'invoke' && r.warnings.length).toBe(1);
  });

  it('returns control verbs with args', () => {
    expect(parseCommand('as service')).toEqual({ kind: 'control', verb: 'as', args: ['service'] });
    expect(parseCommand('whoami')).toEqual({ kind: 'control', verb: 'whoami', args: [] });
  });

  it('validates flags', () => {
    expect(parseCommand('summarize --since forever').kind).toBe('error');
    expect(parseCommand('summarize --as root').kind).toBe('error');
    expect(parseCommand('summarize --bogus').kind).toBe('error');
    const r = parseCommand('draft --tone formal --public --dry-run "an update"');
    expect(r.kind === 'invoke' && r.invocation.flags).toEqual({
      tone: 'formal',
      visibility: 'public',
      dryRun: true,
    });
  });

  it('parses schedule, reaction and keyword automations', () => {
    const s = parseCommand('automate "weekdays 9:00" summarize <#C0ENG> --to <#C0DIG>');
    expect(s.kind).toBe('automate');
    if (s.kind === 'automate') {
      expect(s.trigger).toMatchObject({ kind: 'schedule', cron: '0 9 * * 1-5' });
      expect(s.invocation.flags.to).toBe('C0DIG');
    }
    const r = parseCommand('automate on :memo: notes');
    expect(r.kind === 'automate' && r.trigger).toEqual({ kind: 'reaction', emoji: 'memo' });
    const k = parseCommand('automate on /incident|sev[12]/ ask @runbooks');
    expect(k.kind === 'automate' && k.trigger.kind).toBe('keyword');
    expect(parseCommand('automate on /(a+)+$/ ask').kind).toBe('error');
    expect(parseCommand('automate "whenever" ask').kind).toBe('error');
    expect(parseCommand('automate "daily 17:00" help').kind).toBe('error');
  });

  it('round-trips through renderInvocation', () => {
    const r = parseCommand('notes scope:thread @unit <@U0LI> --tone brief "owners only"');
    expect(r.kind).toBe('invoke');
    if (r.kind !== 'invoke') return;
    const again = parseCommand(renderInvocation(r.invocation));
    expect(again.kind === 'invoke' && again.invocation).toEqual(r.invocation);
  });
});

describe('scope helpers', () => {
  it('parses permalinks including thread_ts and rejects non-slack hosts', () => {
    expect(
      parsePermalink(
        'https://acme.slack.com/archives/C0ENG/p1700000000123456?thread_ts=1699999999.000100',
      ),
    ).toEqual({ channel: 'C0ENG', ts: '1700000000.123456', threadTs: '1699999999.000100' });
    expect(
      parsePermalink('https://evil.example.com/archives/C0ENG/p1700000000123456'),
    ).toBeUndefined();
  });
  it('caps durations at 30 days', () => {
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('52w')).toBe(30 * 86_400_000);
    expect(parseDuration('0d')).toBeUndefined();
  });
});

describe('scheduleTextToCron', () => {
  it.each([
    ['weekdays 9:00', '0 9 * * 1-5'],
    ['weekdays at 9am', '0 9 * * 1-5'],
    ['daily 17:00', '0 17 * * *'],
    ['every day at 5:30pm', '30 17 * * *'],
    ['every monday 08:30', '30 8 * * 1'],
    ['mondays at 12am', '0 0 * * 1'],
    ['hourly', '0 * * * *'],
    ['0 9 * * 1-5', '0 9 * * 1-5'],
  ])('%s → %s', (text, cron) => {
    expect(scheduleTextToCron(text)).toEqual({ ok: true, cron });
  });
  it('rejects ambiguous or unknown text', () => {
    expect(scheduleTextToCron('daily 9').ok).toBe(false);
    expect(scheduleTextToCron('someday 9:00').ok).toBe(false);
    expect(scheduleTextToCron('daily 25:00').ok).toBe(false);
  });
});

describe('isSafePattern', () => {
  it('allows words and alternation, rejects quantifier nesting', () => {
    expect(isSafePattern('incident|sev[12]')).toBe(true);
    expect(isSafePattern('(a+)+')).toBe(false);
    expect(isSafePattern('.*')).toBe(false);
  });
});
