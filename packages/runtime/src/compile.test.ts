import { describe, expect, it } from 'vitest';
import { StreamSanitizer, sanitizeOutbound, mrkdwnEscape } from './compile.js';

describe('outbound sanitization', () => {
  const known = new Set(['U0ALEX']);
  it('defuses broadcasts, strangers, canvas mentions and disguised links', () => {
    const out = sanitizeOutbound(
      'hey <!here> <@U0ALEX> <@U0BOSS> ![](@U0BOSS) <https://evil.example/login|Re-auth here> [docs](https://evil.example/x)',
      known,
    );
    expect(out).not.toContain('<!here>');
    expect(out).toContain('<@U0ALEX>');
    expect(out).not.toContain('U0BOSS');
    expect(out).toContain('Re-auth here (https://evil.example/login)');
    expect(out).toContain('docs (https://evil.example/x)');
  });
  it('holds back constructs split across stream chunks', () => {
    const s = new StreamSanitizer(known);
    let out = '';
    for (const chunk of [
      'Ping <!ch',
      'annel> and <@U0BO',
      'SS> done [x](https://e',
      'vil.example) end',
    ])
      out += s.push(chunk);
    out += s.finish();
    expect(out).not.toContain('<!channel>');
    expect(out).not.toContain('U0BOSS');
    expect(out).toContain('x (https://evil.example)');
    expect(out).toBe(s.text);
  });
  it('escapes mrkdwn in labels', () => {
    expect(mrkdwnEscape('<!channel> & <https://x|y>')).toBe(
      '&lt;!channel&gt; &amp; &lt;https://x|y&gt;',
    );
  });
});
