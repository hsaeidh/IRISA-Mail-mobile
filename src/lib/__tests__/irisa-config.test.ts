import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ raw: null as unknown }));

vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return { extra: { irisaOrganizations: runtime.raw } };
    },
  },
}));

import { getOrganizationConfig, resetOrganizationConfigCache } from '../irisa-config';

function validConfig() {
  return {
    schemaVersion: 1,
    organizations: [{
      key: 'irisa',
      displayName: 'IRISA',
      emailDomains: ['irisa.test'],
      oidc: {
        enabled: true,
        issuer: 'https://identity.example.org/oauth2/token',
        organizationHandle: 'IRISA',
        clientId: 'irisa-mobile',
        redirectUri: 'ir.irisa.mail:/oauth/callback',
        logoutRedirectUri: 'ir.irisa.mail:/oauth/logout',
      },
      jmap: { enabled: true, allowedOrigins: ['https://mail.irisa.test'] },
    }],
    fallback: { allowManualServerEntry: false },
  };
}

describe('IRISA build-time configuration', () => {
  beforeEach(() => {
    runtime.raw = null;
    resetOrganizationConfigCache();
  });

  it('returns null when a non-IRISA build has no tenant map', () => {
    expect(getOrganizationConfig()).toBeNull();
  });

  it('validates and caches the bundled tenant map', () => {
    runtime.raw = validConfig();
    const first = getOrganizationConfig();
    expect(first?.organizations[0].oidc.clientId).toBe('irisa-mobile');
    expect(getOrganizationConfig()).toBe(first);
  });

  it('fails closed when the bundled tenant map is invalid', () => {
    runtime.raw = { schemaVersion: 9, organizations: [] };
    expect(() => getOrganizationConfig()).toThrow(/Unsupported organization config schema/);
  });
});
