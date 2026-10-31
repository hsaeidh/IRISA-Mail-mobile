import { describe, expect, it } from 'vitest';
import {
  isAllowedJmapOrigin,
  resolveOrganization,
  validateOrganizationConfig,
} from '../organization-resolver';

const config = validateOrganizationConfig({
  schemaVersion: 1,
  organizations: [
    {
      key: 'msc',
      displayName: 'MSC',
      emailDomains: ['msc.test'],
      oidc: {
        enabled: true,
        issuer: 'https://identity.test.org/t/msc',
        organizationHandle: 'MSC',
        clientId: 'mobile-public-client',
        redirectUri: 'ir.irisa.mail:/oauth/callback',
        logoutRedirectUri: 'ir.irisa.mail:/oauth/logout',
        scopes: ['openid', 'profile', 'email'],
      },
      jmap: { enabled: true, allowedOrigins: ['https://email.msc.test'] },
    },
    {
      key: 'irisa',
      displayName: 'IRISA',
      emailDomains: ['irisa.test'],
      oidc: {
        enabled: false,
        issuer: '',
        clientId: '',
        redirectUri: '',
      },
      jmap: { enabled: true, allowedOrigins: ['https://email.irisa.test'] },
    },
  ],
});

describe('organization resolver', () => {
  it('resolves a configured domain exactly', () => {
    const result = resolveOrganization('person@msc.test', config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.organization.key).toBe('msc');
      expect(result.organization.oidc.organizationHandle).toBe('MSC');
      expect(result.organization.oidc.logoutRedirectUri).toBe('ir.irisa.mail:/oauth/logout');
    }
  });

  it('normalizes case and internationalized email domains', () => {
    const result = resolveOrganization('User@MSC.TEST', config);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matchedDomain).toBe('msc.test');
  });

  it('does not match a subdomain or a lookalike suffix', () => {
    expect(resolveOrganization('user@sub.msc.test', config)).toEqual({
      ok: false,
      reason: 'unknown-domain',
    });
    expect(resolveOrganization('user@msc.test.attacker.test', config).ok).toBe(false);
  });

  it('fails closed for invalid email and unknown domains', () => {
    expect(resolveOrganization('not-an-email', config)).toEqual({ ok: false, reason: 'invalid-email' });
    expect(resolveOrganization('user@unknown.test', config)).toEqual({ ok: false, reason: 'unknown-domain' });
  });

  it('rejects duplicate domains and insecure OIDC issuers', () => {
    expect(() => validateOrganizationConfig({
      schemaVersion: 1,
      organizations: [
        { key: 'a', displayName: 'A', emailDomains: ['same.test'], oidc: { enabled: false, issuer: '', clientId: '', redirectUri: '' }, jmap: { enabled: false, allowedOrigins: [] } },
        { key: 'b', displayName: 'B', emailDomains: ['same.test'], oidc: { enabled: false, issuer: '', clientId: '', redirectUri: '' }, jmap: { enabled: false, allowedOrigins: [] } },
      ],
    })).toThrow(/assigned more than once/);

    expect(() => validateOrganizationConfig({
      schemaVersion: 1,
      organizations: [{
        key: 'bad',
        displayName: 'Bad',
        emailDomains: ['bad.test'],
        oidc: { enabled: true, issuer: 'http://identity.test', organizationHandle: 'bad', clientId: 'x', redirectUri: 'ir.irisa.mail:/oauth/callback' },
        jmap: { enabled: false, allowedOrigins: [] },
      }],
    })).toThrow(/incomplete OIDC settings/);
  });

  it('rejects client secrets in mobile organization configuration', () => {
    expect(() => validateOrganizationConfig({
      schemaVersion: 1,
      organizations: [{
        key: 'secret',
        displayName: 'Secret',
        emailDomains: ['secret.test'],
        oidc: {
          enabled: true,
          issuer: 'https://identity.test',
          organizationHandle: 'secret',
          clientId: 'public-client',
          clientSecret: 'must-never-be-shipped',
          redirectUri: 'ir.irisa.mail:/oauth/callback',
        },
        jmap: { enabled: false, allowedOrigins: [] },
      }],
    })).toThrow(/must not contain an OIDC client secret/);
  });

  it('requires an organization routing identifier for enabled OIDC', () => {
    expect(() => validateOrganizationConfig({
      schemaVersion: 1,
      organizations: [{
        key: 'bad',
        displayName: 'Bad',
        emailDomains: ['bad.test'],
        oidc: { enabled: true, issuer: 'https://identity.test', clientId: 'x', redirectUri: 'ir.irisa.mail:/oauth/callback' },
        jmap: { enabled: false, allowedOrigins: [] },
      }],
    })).toThrow(/organizationId or organizationHandle/);
  });

  it('allows only exact configured HTTPS JMAP origins', () => {
    const msc = config.organizations[0];
    expect(isAllowedJmapOrigin('https://email.msc.test/', msc)).toBe(true);
    expect(isAllowedJmapOrigin('https://email.msc.test/jmap/session', msc)).toBe(false);
    expect(isAllowedJmapOrigin('https://email.msc.test.evil.test', msc)).toBe(false);
    expect(isAllowedJmapOrigin('http://email.msc.test', msc)).toBe(false);
    expect(isAllowedJmapOrigin('https://other.msc.test', msc)).toBe(false);
  });
});
