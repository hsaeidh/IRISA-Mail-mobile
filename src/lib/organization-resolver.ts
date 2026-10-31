/**
 * IRISA organization resolution.
 *
 * This module deliberately accepts configuration as an argument: production
 * tenant routing must be injected by the release/build environment, never
 * inferred from arbitrary email domains or fetched from an untrusted host.
 */
import { toAsciiDomain } from './idn';

export const IRISA_OIDC_REDIRECT_URI = 'ir.irisa.mail:/oauth/callback';
export const IRISA_OIDC_LOGOUT_REDIRECT_URI = 'ir.irisa.mail:/oauth/logout';

const EMAIL_WITH_DOMAIN_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;

export interface OrganizationOidcConfig {
  enabled: boolean;
  issuer: string;
  organizationId?: string;
  organizationHandle?: string;
  clientId: string;
  redirectUri: string;
  logoutRedirectUri?: string;
  scopes?: string[];
  legacyOrganizationSso?: boolean;
}

export interface OrganizationJmapConfig {
  enabled: boolean;
  allowedOrigins: string[];
}

export interface OrganizationProfile {
  key: string;
  displayName: string;
  emailDomains: string[];
  oidc: OrganizationOidcConfig;
  jmap: OrganizationJmapConfig;
  brandingKey?: string;
}

export interface OrganizationConfig {
  schemaVersion: 1;
  organizations: OrganizationProfile[];
  fallback?: {
    allowUnknownDomains?: false;
    allowManualServerEntry?: boolean;
  };
}

export type OrganizationResolution =
  | { ok: true; organization: OrganizationProfile; matchedDomain: string }
  | { ok: false; reason: 'invalid-email' | 'unknown-domain' };

function normalizedEmailDomain(email: string): string | null {
  const match = EMAIL_WITH_DOMAIN_RE.exec(email.trim());
  return match ? toAsciiDomain(match[1]) : null;
}

function normalizedIssuerUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      /REPLACE_WITH/i.test(raw) || /\\.(?:example|invalid)$/i.test(url.hostname)) return null;
    return raw;
  } catch {
    return null;
  }
}

function normalizedHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Validate and normalize a configuration object before it is used. */
export function validateOrganizationConfig(input: unknown): OrganizationConfig {
  if (!input || typeof input !== 'object') throw new Error('Organization config must be an object');
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.organizations)) {
    throw new Error('Unsupported organization config schema');
  }

  const seenKeys = new Set<string>();
  const seenDomains = new Set<string>();
  const organizations: OrganizationProfile[] = raw.organizations.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Organization at index ${index} must be an object`);
    const item = entry as Record<string, unknown>;
    const key = typeof item.key === 'string' ? item.key.trim().toLowerCase() : '';
    const displayName = typeof item.displayName === 'string' ? item.displayName.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(key) || !displayName) {
      throw new Error(`Organization at index ${index} has an invalid key or displayName`);
    }
    if (seenKeys.has(key)) throw new Error(`Duplicate organization key: ${key}`);
    seenKeys.add(key);

    if (!Array.isArray(item.emailDomains) || item.emailDomains.length === 0) {
      throw new Error(`Organization ${key} must define at least one email domain`);
    }
    const domains = item.emailDomains.map((value) => {
      if (typeof value !== 'string') throw new Error(`Organization ${key} has a non-string email domain`);
      const domain = normalizedEmailDomain(`user@${value.trim()}`);
      if (!domain || /REPLACE_WITH/i.test(domain) || /\.(?:example|invalid)$/i.test(domain) ||
        domain !== value.trim().toLowerCase().replace(/\.$/, '')) {
        throw new Error(`Organization ${key} has an invalid email domain: ${value}`);
      }
      if (seenDomains.has(domain)) throw new Error(`Email domain is assigned more than once: ${domain}`);
      seenDomains.add(domain);
      return domain;
    });

    if (!item.oidc || typeof item.oidc !== 'object' || !item.jmap || typeof item.jmap !== 'object') {
      throw new Error(`Organization ${key} must define oidc and jmap settings`);
    }
    const oidc = item.oidc as Record<string, unknown>;
    if ('clientSecret' in oidc || 'client_secret' in oidc) {
      throw new Error(`Organization ${key} must not contain an OIDC client secret; mobile clients are public clients`);
    }
    const jmap = item.jmap as Record<string, unknown>;
    if (typeof oidc.enabled !== 'boolean' || typeof jmap.enabled !== 'boolean') {
      throw new Error(`Organization ${key} must explicitly enable or disable each provider`);
    }

    const issuer = oidc.enabled ? normalizedIssuerUrl(oidc.issuer) : null;
    const clientId = typeof oidc.clientId === 'string' ? oidc.clientId.trim() : '';
    if (oidc.enabled && /REPLACE_WITH/i.test(clientId)) {
      throw new Error(`Organization ${key} still contains a placeholder OIDC client ID`);
    }
    const redirectUri = typeof oidc.redirectUri === 'string' ? oidc.redirectUri.trim() : '';
    const logoutRedirectUri = typeof oidc.logoutRedirectUri === 'string' ? oidc.logoutRedirectUri.trim() : '';
    if (oidc.enabled && (!issuer || !clientId || redirectUri !== IRISA_OIDC_REDIRECT_URI)) {
      throw new Error(`Organization ${key} has incomplete OIDC settings or an unregistered IRISA callback URI`);
    }
    if (oidc.enabled && logoutRedirectUri && logoutRedirectUri !== IRISA_OIDC_LOGOUT_REDIRECT_URI) {
      throw new Error(`Organization ${key} has an unregistered IRISA OIDC logout redirect URI`);
    }
    const organizationId = typeof oidc.organizationId === 'string' ? oidc.organizationId.trim() : '';
    const organizationHandle = typeof oidc.organizationHandle === 'string' ? oidc.organizationHandle.trim() : '';
    if (oidc.enabled && (/REPLACE_WITH/i.test(organizationId) || /REPLACE_WITH/i.test(organizationHandle))) {
      throw new Error(`Organization ${key} still contains a placeholder WSO2 organization identifier`);
    }
    if (oidc.enabled && !organizationId && !organizationHandle) {
      throw new Error(`Organization ${key} must define an OIDC organizationId or organizationHandle`);
    }
    const scopes = Array.isArray(oidc.scopes)
      ? oidc.scopes.filter((scope): scope is string => typeof scope === 'string' && !!scope.trim()).map((scope) => scope.trim())
      : undefined;

    if (!Array.isArray(jmap.allowedOrigins)) throw new Error(`Organization ${key} must define jmap.allowedOrigins`);
    const allowedOrigins = jmap.allowedOrigins.map((value) => {
      const origin = normalizedHttpsUrl(value);
      if (!origin) throw new Error(`Organization ${key} has an invalid JMAP origin`);
      const parsed = new URL(origin);
      if (/REPLACE_WITH/i.test(origin) || /\.(?:example|invalid)$/i.test(parsed.hostname)) {
        throw new Error(`Organization ${key} still contains a placeholder JMAP origin`);
      }
      if (parsed.pathname !== '/') throw new Error(`Organization ${key} JMAP entries must be origins, not paths`);
      return parsed.origin;
    });
    if (jmap.enabled && allowedOrigins.length === 0) {
      throw new Error(`Organization ${key} must allow at least one JMAP origin`);
    }
    if (oidc.enabled && (!jmap.enabled || allowedOrigins.length === 0)) {
      throw new Error(`Organization ${key} needs an enabled JMAP origin to use external OIDC for mail sign-in`);
    }
    if (oidc.legacyOrganizationSso !== undefined && typeof oidc.legacyOrganizationSso !== 'boolean') {
      throw new Error(`Organization ${key} legacyOrganizationSso must be a boolean`);
    }

    return {
      key,
      displayName,
      emailDomains: domains,
      oidc: {
        enabled: oidc.enabled,
        issuer: issuer ?? '',
        ...(organizationId ? { organizationId } : {}),
        ...(organizationHandle ? { organizationHandle } : {}),
        clientId,
        redirectUri,
        ...(logoutRedirectUri ? { logoutRedirectUri } : {}),
        ...(scopes?.length ? { scopes } : {}),
        ...(oidc.legacyOrganizationSso === true ? { legacyOrganizationSso: true } : {}),
      },
      jmap: { enabled: jmap.enabled, allowedOrigins },
      ...(typeof item.brandingKey === 'string' && item.brandingKey.trim()
        ? { brandingKey: item.brandingKey.trim() }
        : {}),
    };
  });

  return {
    schemaVersion: 1,
    organizations,
    fallback: { allowUnknownDomains: false, allowManualServerEntry: (raw.fallback as Record<string, unknown> | undefined)?.allowManualServerEntry === true },
  };
}

/**
 * Exact-match resolver. No suffix matching, wildcard domains, DNS discovery,
 * issuer construction, or fallback to a neighboring tenant is permitted.
 */
export function resolveOrganization(
  email: string,
  config: OrganizationConfig,
): OrganizationResolution {
  const domain = normalizedEmailDomain(email);
  if (!domain) return { ok: false, reason: 'invalid-email' };
  const organization = config.organizations.find((candidate) => candidate.emailDomains.includes(domain));
  return organization
    ? { ok: true, organization, matchedDomain: domain }
    : { ok: false, reason: 'unknown-domain' };
}

/** Check that a URL's origin is explicitly allowed for this organization. */
export function isAllowedJmapOrigin(url: string, organization: OrganizationProfile): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      parsed.pathname === '/' && !parsed.search && !parsed.hash && organization.jmap.enabled &&
      organization.jmap.allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}
