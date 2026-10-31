/**
 * Validate the URLs advertised in a JMAP session before authenticated blob or
 * event-source requests are made.
 *
 * JMAPClient rewrites apiUrl and HTTP/internal resource URLs to the configured
 * server origin. A separate HTTPS resource host is preserved by the client,
 * so it must be explicitly allow-listed for managed IRISA organizations.
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
    super(`JMAP session ${field} uses a URL or origin that is not allowed by the organization policy`);
    this.name = 'JMAPSessionOriginError';
    this.field = field;
  }
}

function parseHttpUrl(value: string, field: string, base?: string): URL {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new JMAPSessionOriginError(field);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new JMAPSessionOriginError(field);
  }
  return url;
}

/** resourceOrigins must be origin-only HTTPS URLs, not arbitrary endpoint URLs. */
export function validateJmapSessionOrigins(
  session: JMAPSessionUrlSet,
  serverUrl: string,
  resourceOrigins: readonly string[] = [],
): void {
  const server = parseHttpUrl(serverUrl, 'serverUrl');
  if (server.protocol !== 'https:') throw new JMAPSessionOriginError('serverUrl');
  const serverOrigin = server.origin;
  const api = parseHttpUrl(session.apiUrl, 'apiUrl', serverOrigin);
  const reportedApiOrigin = api.origin;

  const allowedResourceOrigins = new Set<string>([serverOrigin]);
  for (const resourceOrigin of resourceOrigins) {
    const parsed = parseHttpUrl(resourceOrigin, 'resourceOrigins');
    if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new JMAPSessionOriginError('resourceOrigins');
    }
    allowedResourceOrigins.add(parsed.origin);
  }

  // The client rewrites apiUrl to serverOrigin before using it, so the
  // advertised origin is not used as an authenticated request destination.
  for (const field of ['downloadUrl', 'uploadUrl', 'eventSourceUrl'] as const) {
    const value = session[field];
    if (!value) continue;
    const url = parseHttpUrl(value, field, serverOrigin);
    const hostedElsewhere = url.protocol === 'https:' && url.origin !== reportedApiOrigin;
    if (hostedElsewhere && !allowedResourceOrigins.has(url.origin)) {
      throw new JMAPSessionOriginError(field);
    }
  }
}
