/**
 * Validate the URLs advertised in a JMAP session before any subsequent
 * authenticated API, upload, download or event-source request is made.
 *
 * In managed IRISA organizations, the session API must remain on the exact
 * mail-server origin. Separate resource hosts are allowed only when they are
 * explicitly configured as resourceOrigins. Generic/manual accounts keep the
 * upstream behavior by not supplying a policy.
 */

export interface JMAPSessionUrlSet {
  apiUrl: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
}

export class JMAPSessionOriginError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`JMAP session ${field} uses an origin that is not allowed by the organization policy`);
    this.name = 'JMAPSessionOriginError';
    this.field = field;
  }
}

function httpsOrigin(value: string, field: string, base?: string): string {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new JMAPSessionOriginError(field);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new JMAPSessionOriginError(field);
  }
  return url.origin;
}

/**
 * resourceOrigins must be origin-only HTTPS URLs, not arbitrary endpoint URLs.
 * Relative JMAP resource URLs resolve against the configured server origin.
 */
export function validateJmapSessionOrigins(
  session: JMAPSessionUrlSet,
  serverUrl: string,
  resourceOrigins: readonly string[] = [],
): void {
  const serverOrigin = httpsOrigin(serverUrl, 'serverUrl');
  const allowedResourceOrigins = new Set<string>([serverOrigin]);
  for (const resourceOrigin of resourceOrigins) {
    const origin = httpsOrigin(resourceOrigin, 'resourceOrigins');
    let parsed: URL;
    try {
      parsed = new URL(resourceOrigin);
    } catch {
      throw new JMAPSessionOriginError('resourceOrigins');
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new JMAPSessionOriginError('resourceOrigins');
    }
    allowedResourceOrigins.add(origin);
  }

  if (httpsOrigin(session.apiUrl, 'apiUrl', serverOrigin) !== serverOrigin) {
    throw new JMAPSessionOriginError('apiUrl');
  }

  for (const field of ['downloadUrl', 'uploadUrl', 'eventSourceUrl'] as const) {
    const value = session[field];
    if (value && !allowedResourceOrigins.has(httpsOrigin(value, field, serverOrigin))) {
      throw new JMAPSessionOriginError(field);
    }
  }
}
