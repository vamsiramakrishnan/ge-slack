import { describe, expect, it } from 'vitest';
import { extractFence, parseProgram, renderCmdSignature } from './cmd.js';
import { parsePlanBlock, renderConfirmedPlan } from './plan.js';

const PL = 'https://acme.slack.com/archives/C0ENG/p1700000000123456';

describe('extractFence', () => {
  it('fails closed on missing, duplicate and unclosed fences', () => {
    expect(extractFence('no fence', 'cmd')).toEqual({ ok: false, reason: 'no-fence' });
    expect(extractFence('```cmd\ndone\n```\n```cmd\ndone\n```', 'cmd')).toEqual({
      ok: false,
      reason: 'multiple-fences',
    });
    expect(extractFence('```cmd\nreply "x"', 'cmd')).toEqual({
      ok: false,
      reason: 'unclosed-fence',
    });
  });
});

describe('parseProgram', () => {
  it('parses every effect verb', () => {
    const r = parseProgram(
      [
        '```cmd',
        '# observe',
        'read channel since=7d',
        `read <${PL}>`,
        'search "cache ttl"',
        'reply "Owners: \\"maya\\"\\nNext: li"',
        `finding <${PL}> "No rollback plan" severity=high`,
        'post <#C0DIG|digest> "Weekly digest"',
        'canvas "Incident follow-ups" """',
        '# Follow-ups',
        '- [ ] cache TTL',
        '"""',
        'canvas-edit F07ABC """## Status\nDone""" section=temp:C:abc',
        'schedule <#C0LEAD> 2026-10-12T09:00:00-07:00 "Reminder"',
        'remind <@U0MAYA> 2026-10-07T17:00:00Z "Cache TTL change"',
        'bookmark "Runbook" <https://docs.acme.com/runbook>',
        `react ${PL} :white_check_mark:`,
        'done',
        '```',
      ].join('\n'),
    );
    expect('fenceError' in r).toBe(false);
    if ('fenceError' in r) return;
    expect(r.errors).toEqual([]);
    expect(r.done).toBe(true);
    const effects = r.lines.flatMap((l) => (l.verb === 'effect' ? [l.effect] : []));
    expect(effects.map((e) => e.kind)).toEqual([
      'reply',
      'reply',
      'post',
      'canvas',
      'canvas-edit',
      'schedule',
      'remind',
      'bookmark',
      'react',
    ]);
    expect(effects[0]).toEqual({
      kind: 'reply',
      target: 'scope',
      text: 'Owners: "maya"\nNext: li',
    });
    expect(effects[1]).toMatchObject({
      severity: 'high',
      target: { channel: 'C0ENG', ts: '1700000000.123456' },
    });
    expect(effects[3]).toMatchObject({ markdown: '# Follow-ups\n- [ ] cache TTL\n' });
    expect(effects[4]).toMatchObject({ sectionId: 'temp:C:abc' });
    expect(r.lines[0]).toMatchObject({ verb: 'read', target: 'channel', sinceText: '7d' });
  });

  it('reports CLI-style errors with did-you-mean', () => {
    const r = parseProgram(
      '```cmd\nrepyl "x"\nschedule <#C0A> tomorrow "x"\npost "no channel"\n```',
    );
    if ('fenceError' in r) throw new Error('fence');
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toContain('did you mean "reply"');
    expect(r.errors[1]).toContain('ISO-8601');
  });

  it('treats non-breaking and other unicode whitespace as separators (no hang)', () => {
    const r = parseProgram('```cmd\nreply\u00a0"x"\f\v\ndone\n```');
    if ('fenceError' in r) throw new Error('fence');
    expect(r.errors).toEqual([]);
    expect(r.lines[0]).toMatchObject({ verb: 'effect', effect: { kind: 'reply', text: 'x' } });
  });

  it('rejects unclosed strings', () => {
    const r = parseProgram('```cmd\nreply "unterminated\n```');
    if ('fenceError' in r) throw new Error('fence');
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('only allows https bookmarks', () => {
    const r = parseProgram('```cmd\nbookmark "x" <http://insecure.example.com>\n```');
    if ('fenceError' in r) throw new Error('fence');
    expect(r.errors).toHaveLength(1);
  });

  it('renders the per-turn signature only for offered kinds', () => {
    const sig = renderCmdSignature(['reply', 'canvas']);
    expect(sig).toContain('canvas "Title"');
    expect(sig).not.toContain('schedule');
  });
});

describe('parsePlanBlock', () => {
  it('parses a plan and renders the confirmed block', () => {
    const r = parsePlanBlock(
      'Here:\n```plan\nintent draft\nsurface slack\nscope thread\nground "Runbooks"\nstep summarize decisions\nstep post owners\nexclude anything about hiring\nconfidence high\n```',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps).toHaveLength(2);
    expect(r.needsClarification).toBe(false);
    expect(renderConfirmedPlan(r.plan)).toContain('exclude anything about hiring');
  });
  it('requires steps or clarify and a slack surface', () => {
    expect(parsePlanBlock('```plan\nintent ask\nsurface slack\n```').ok).toBe(false);
    expect(parsePlanBlock('```plan\nintent ask\nsurface word\nstep x\n```').ok).toBe(false);
    const c = parsePlanBlock('```plan\nintent draft\nsurface slack\nclarify which channel?\n```');
    expect(c.ok && c.needsClarification).toBe(true);
  });
});
