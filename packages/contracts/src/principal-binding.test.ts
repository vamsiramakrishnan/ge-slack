import { describe, expect, it } from 'vitest';
import { principalBinding, principalId, principalLabel, type Principal } from './principal.js';

const user: Extract<Principal, { kind: 'user' }> = {
  kind: 'user',
  teamId: 'T1',
  slackUserId: 'U0ALEX',
  provider: 'oidc',
  subject: 'immutable-subject',
  email: 'alex@example.com',
};
const service: Extract<Principal, { kind: 'service' }> = {
  kind: 'service',
  serviceAccount: 'licensed@project.iam.gserviceaccount.com',
  onBehalfOf: { teamId: 'T1', slackUserId: 'U0ALEX' },
};

describe('immutable principal binding', () => {
  it('distinguishes re-links to another subject/provider even when the email is unchanged', () => {
    expect(principalBinding({ ...user, subject: 'different-subject' })).not.toBe(
      principalBinding(user),
    );
    expect(principalBinding({ ...user, provider: 'google' })).not.toBe(principalBinding(user));
    expect(principalBinding({ ...user, teamId: 'T2' })).not.toBe(principalBinding(user));
    expect(principalBinding({ ...user, slackUserId: 'U0OTHER' })).not.toBe(principalBinding(user));
  });

  it('keeps mutable display email separate and canonicalizes input property order', () => {
    const sameIdentity = {
      email: 'renamed@example.com',
      subject: user.subject,
      provider: user.provider,
      slackUserId: user.slackUserId,
      teamId: user.teamId,
      kind: 'user' as const,
    };
    expect(principalBinding(sameIdentity)).toBe(principalBinding(user));
    expect(principalBinding(user)).not.toContain(user.email);
    expect(principalId(user)).toBe('user:alex@example.com');
    expect(principalLabel(user)).toBe('alex@example.com');
  });

  it('binds the service account and its initiating workspace/person independently', () => {
    expect(
      principalBinding({ ...service, serviceAccount: 'other@project.iam.gserviceaccount.com' }),
    ).not.toBe(principalBinding(service));
    expect(
      principalBinding({ ...service, onBehalfOf: { teamId: 'T2', slackUserId: 'U0ALEX' } }),
    ).not.toBe(principalBinding(service));
    expect(
      principalBinding({ ...service, onBehalfOf: { teamId: 'T1', slackUserId: 'U0OTHER' } }),
    ).not.toBe(principalBinding(service));
    expect(principalBinding({ kind: 'service', serviceAccount: service.serviceAccount })).not.toBe(
      principalBinding(service),
    );
  });

  it('does not alias identifier separators or quoted data into another binding', () => {
    expect(principalBinding({ ...user, teamId: 'T1:U0ALEX', slackUserId: 'U0SECOND' })).not.toBe(
      principalBinding({ ...user, teamId: 'T1', slackUserId: 'U0ALEX:U0SECOND' }),
    );
    const unusual = { ...user, subject: 'sub", "another-field\\n' };
    expect(JSON.parse(principalBinding(unusual))).toEqual([
      'principal-binding-v1',
      'user',
      user.teamId,
      user.slackUserId,
      user.provider,
      unusual.subject,
    ]);
  });
});
