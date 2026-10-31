/**
 * IRISA organization resolution.
 *
 * This module deliberately accepts configuration as an argument: production
 * tenant routing must be injected by the release/build environment, never
 * inferred from arbitrary email domains or fetched from an untrusted host.
 */
import { emailDomain } from './server-discovery';

export interface OrganizationOidcConfig {
  enabled: boolean;
  issuer: string;
  organizationId?: string;
  organizationHandle?: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
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
    const key = typeof item.key === 'string' ? item.key.trim() : '';
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
      const domain = emailDomain(`user@${value.trim()}`);
      if (!domain || domain !== value.trim().toLowerCase().replace(/\.$/, '')) {
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
    const jmap = item.jmap as Record<string, unknown>;
    if (typeof oidc.enabled !== 'boolean' || typeof jmap.enabled !== 'boolean') {
      throw new Error(`Organization ${key} must explicitly enable or disable each provider`);
    }

    const issuer = oidc.enabled ? normalizedHttpsUrl(oidc.issuer) : null;
    const clientId = typeof oidc.clientId === 'string' ? oidc.clientId.trim() : '';
    const redirectUri = typeof oidc.redirectUri === 'string' ? oidc.redirectUri.trim() : '';
    if (oidc.enabled && (!issuer || !clientId || !redirectUri || !/^[a-z][a-z0-9+.-]*:\/\//i.test(redirectUri))) {
      throw new Error(`Organization ${key} has incomplete or insecure OIDC settings`);
    }
    const organizationId = typeof oidc.organizationId === 'string' ? oidc.organizationId.trim() : '';
    const organizationHandle = typeof oidc.organizationHandle === 'string' ? oidc.organizationHandle.trim() : '';
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
      if (parsed.pathname !== '/') throw new Error(`Organization ${key} JMAP entries must be origins, not paths`);
      return parsed.origin;
    });
    if (jmap.enabled && allowedOrigins.length === 0) {
      throw new Error(`Organization ${key} must allow at least one JMAP origin`);
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
        ...(scopes?.length ? { scopes } : {}),
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
  const domain = emailDomain(email);
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
    return parsed.protocol === 'https:' && organization.jmap.enabled &&
      organization.jmap.allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}
