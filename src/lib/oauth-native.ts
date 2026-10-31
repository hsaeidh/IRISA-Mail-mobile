// Direct OAuth 2.0 / OIDC authorization-code + PKCE login against the mail
// server's own authorization server (Stalwart's built-in OAuth, Keycloak,
// Authentik…), for deployments where no Bulwark webmail lives at the JMAP
// origin and the browser hand-off therefore has nothing to open.
//
// Mirrors the webmail's client-side PKCE flow (`lib/oauth/discovery.ts`,
// `lib/oauth/pkce.ts`, login page `handleOAuthLogin`): discover the metadata
// document, open the authorization endpoint in the system browser with a
// S256 challenge, receive the code on `bulwarkmobile://auth/callback`, and
// exchange it at the token endpoint. The resulting bundle is the same shape
// the hand-off produces, so `connectWithOAuth` and the refresh path apply.

import * as WebBrowser from 'expo-web-browser';
import { fetchWithoutForeignRedirect, followedOnlyAllowedRedirects, mayFollowRedirect, secureFetch } from './client-cert';
import { HANDOFF_REDIRECT_URI, HandoffError, HandoffCancelledError, type OAuthTokens } from './oauth';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  resolveLoginClient,
  DEFAULT_CLIENT_ID,
  MOBILE_CLIENT_ID,
  REGISTERED_LOGOUT_REDIRECT_URI,
  REGISTERED_REDIRECT_URI,
} from './totp-login';
import { randomHex } from './random';
import { NetworkError } from '../api/jmap-client';

export interface OAuthMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  end_session_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  prompt_values_supported?: string[];
  jwks_uri?: string;
  id_token_signing_alg_values_supported?: string[];
}

const DISCOVERY_TIMEOUT_MS = 8_000;

const OIDC_METADATA_TIMEOUT_MS = 8_000;

function isHttpsEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Strict OIDC discovery for a configured issuer (for example WSO2 IS's
 * https://id.example/oauth2/token issuer). Unlike mail-server discovery this
 * never accepts a redirect, issuer substitution, or endpoints on another
 * origin.
 */
export async function discoverConfiguredOidcMetadata(issuer: string): Promise<OAuthMetadata> {
  if (!isHttpsEndpoint(issuer)) throw new HandoffError('The configured OIDC issuer must use HTTPS');
  const normalizedIssuer = issuer.replace(/\/+$/, '');
  const metadataUrl = `${normalizedIssuer}/.well-known/openid-configuration`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OIDC_METADATA_TIMEOUT_MS);
  try {
    const response = await secureFetch(metadataUrl, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
      timeoutMs: OIDC_METADATA_TIMEOUT_MS,
    });
    if (!response.ok || response.url !== metadataUrl || response.redirected) {
      throw new HandoffError('Could not securely load the configured OIDC metadata');
    }
    const data = (await response.json()) as Partial<OAuthMetadata>;
    if (data.issuer !== normalizedIssuer) throw new HandoffError('OIDC metadata issuer does not match the configured issuer');
    const endpoints = [data.authorization_endpoint, data.token_endpoint, data.jwks_uri];
    if (!endpoints.every(isHttpsEndpoint)) {
      throw new HandoffError('OIDC metadata must provide HTTPS authorization, token and JWKS endpoints');
    }
    const issuerOrigin = new URL(normalizedIssuer).origin;
    if (endpoints.some((endpoint) => new URL(endpoint as string).origin !== issuerOrigin)) {
      throw new HandoffError('OIDC endpoints must be hosted on the configured issuer origin');
    }
    if (data.id_token_signing_alg_values_supported?.length &&
      !data.id_token_signing_alg_values_supported.includes('RS256')) {
      throw new HandoffError('The configured OIDC provider does not advertise RS256 ID-token signing');
    }
    return data as OAuthMetadata;
  } catch (err) {
    if (err instanceof HandoffError) throw err;
    throw new HandoffError(`OIDC discovery failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

function decodeJwtPart<T>(part: string): T {
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const bytes = Buffer.from(padded, 'base64');
  return JSON.parse(bytes.toString('utf8')) as T;
}

interface OidcIdTokenClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
}

interface OidcJwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  key_ops?: string[];
}

async function verifyConfiguredIdToken(
  idToken: string,
  metadata: OAuthMetadata,
  clientId: string,
  expectedNonce: string,
): Promise<void> {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !metadata.jwks_uri) throw new HandoffError('Invalid OIDC ID token');
  const header = decodeJwtPart<{ alg?: string; kid?: string; typ?: string }>(parts[0]);
  const claims = decodeJwtPart<OidcIdTokenClaims>(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) {
    throw new HandoffError('OIDC ID token must use a keyed RS256 signature');
  }
  const jwksResponse = await secureFetch(metadata.jwks_uri, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    timeoutMs: OIDC_METADATA_TIMEOUT_MS,
  });
  if (!jwksResponse.ok || jwksResponse.url !== metadata.jwks_uri || jwksResponse.redirected) {
    throw new HandoffError('Could not securely load OIDC signing keys');
  }
  const jwks = (await jwksResponse.json()) as { keys?: OidcJwk[] };
  const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.kty === 'RSA' &&
    (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256') &&
    (!key.key_ops || key.key_ops.includes('verify')) && !!key.n && !!key.e);
  if (!jwk) throw new HandoffError('No matching RSA signing key was published by the OIDC provider');

  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoApi?.subtle) throw new HandoffError('Secure cryptographic verification is unavailable on this device');
  const key = await cryptoApi.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signature = new Uint8Array(Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - parts[2].length % 4) % 4), 'base64'));
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await cryptoApi.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signed);
  if (!valid) throw new HandoffError('OIDC ID-token signature verification failed');

  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== metadata.issuer || !claims.sub ||
    !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId) ||
    typeof claims.exp !== 'number' || claims.exp <= now - 30 ||
    typeof claims.iat !== 'number' || claims.iat > now + 300 ||
    (typeof claims.nbf === 'number' && claims.nbf > now + 30) ||
    claims.nonce !== expectedNonce) {
    throw new HandoffError('OIDC ID-token claims validation failed');
  }
}

function withTimeout(ms: number): { signal?: AbortSignal; done: () => void } {
  if (typeof AbortController === 'undefined') return { done: () => undefined };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function sameHost(a: string, b: string): boolean {
  const host = (u: string) => (/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(u)?.[1] ?? '').toLowerCase().replace(/:\d+$/, '');
  const ha = host(a);
  const hb = host(b);
  return !!ha && !!hb && (ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`));
}

/**
 * RFC 8414 / OIDC discovery on the mail server origin. Returns null when the
 * server advertises no authorization server (plain Stalwart without OAuth,
 * or a non-Stalwart JMAP server). The document decides where registration,
 * the sign-in page and the code exchange go, so one reached through a
 * redirect to another host doesn't count.
 */
export async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthMetadata | null> {
  const base = serverUrl.replace(/\/+$/, '');
  const urls = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  for (const url of urls) {
    const t = withTimeout(DISCOVERY_TIMEOUT_MS);
    try {
      const res = await fetchWithoutForeignRedirect(url, { headers: { Accept: 'application/json' }, signal: t.signal });
      if (!res.ok) continue;
      // Where no fetch could be told not to follow (see client-cert), the
      // answer's url says whether it came from elsewhere.
      if (res.url && !followedOnlyAllowedRedirects(res) && !mayFollowRedirect(url, res.url)) continue;
      const data = (await res.json()) as Partial<OAuthMetadata>;
      if (
        typeof data.authorization_endpoint === 'string' &&
        typeof data.token_endpoint === 'string' &&
        /^https?:\/\//i.test(data.authorization_endpoint) &&
        /^https?:\/\//i.test(data.token_endpoint)
      ) {
        return data as OAuthMetadata;
      }
    } catch {
      // try the next document
    } finally {
      t.done();
    }
  }
  return null;
}

/**
 * Is a Bulwark webmail serving the given origin? The hand-off opens
 * `${origin}/login?mobile_redirect_uri=…`, which only works when it is.
 */
export async function probeWebmail(serverUrl: string): Promise<boolean> {
  const base = serverUrl.replace(/\/+$/, '');
  const t = withTimeout(DISCOVERY_TIMEOUT_MS);
  try {
    const res = await secureFetch(`${base}/api/config`, { headers: { Accept: 'application/json' }, signal: t.signal });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') ?? '';
    if (!/json/i.test(type)) return false;
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return !!data && typeof data === 'object';
  } catch {
    return false;
  } finally {
    t.done();
  }
}

function parseCallbackParams(url: string): URLSearchParams {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const query = q >= 0 ? url.slice(q + 1, h > q ? h : undefined) : '';
  const params = new URLSearchParams(query);
  if (h >= 0) {
    for (const [k, v] of new URLSearchParams(url.slice(h + 1))) {
      if (!params.has(k)) params.set(k, v);
    }
  }
  return params;
}

// Adding an account must not quietly reuse the identity provider's session
// of the account that is already signed in (webmail 5771a213). Ask for the
// account picker, or for a fresh login where the server says it has no
// picker (Keycloak advertises only none/login/consent).
function addAccountPrompt(metadata: OAuthMetadata): string {
  const supported = metadata.prompt_values_supported;
  if (supported?.length && !supported.includes('select_account') && supported.includes('login')) return 'login';
  return 'select_account';
}

const DATA_SCOPE_PREFIX = 'urn:ietf:params:oauth:scope:';

/**
 * Scopes to ask for (webmail lib/oauth/scopes.ts). A provider that
 * advertises OAuth data scopes is Stalwart: 1.0 gives a client it doesn't
 * treat as first-party only what these name, and refuses a scope it doesn't
 * list (`email`, `profile`) with `invalid_scope`. For such a provider the
 * scopes it doesn't list are dropped and every data scope it lists is added;
 * any other provider gets the usual OIDC set.
 */
export function pkceScopes(metadata: OAuthMetadata): string {
  const wanted = ['openid', 'email', 'profile', 'offline_access'];
  const supported = metadata.scopes_supported;
  if (!supported?.length) return wanted.join(' ');
  const kept = wanted.filter((s) => supported.includes(s));
  const data = supported.filter((s) => typeof s === 'string' && s.startsWith(DATA_SCOPE_PREFIX));
  if (data.length) return [...new Set([...kept, ...data])].join(' ');
  return kept.join(' ') || supported.join(' ');
}

/**
 * The client the browser sign-in uses. When the server is its own
 * authorization server (Stalwart), the same check as the password sign-in
 * decides: 0.16 takes `bulwark-webmail` on `bulwarkmobile://`, 1.0 knows no
 * such client and gets one the app registers. Stalwart may name its
 * endpoints on the public address it is configured with rather than the one
 * the user typed; it still lists its data scopes, and the client is
 * registered where its metadata says. An external identity provider keeps
 * the webmail's client id.
 */
async function pkceClient(serverUrl: string, metadata: OAuthMetadata): Promise<{ clientId: string; redirectUri: string }> {
  const onServer = sameHost(metadata.authorization_endpoint, serverUrl) && sameHost(metadata.token_endpoint, serverUrl);
  const stalwart = !!metadata.scopes_supported?.some((s) => typeof s === 'string' && s.startsWith(DATA_SCOPE_PREFIX));
  if (onServer || stalwart) {
    try {
      return await resolveLoginClient(serverUrl, { registrationEndpoint: registrationEndpoint(metadata) });
    } catch (err) {
      // Unreachable: say so, rather than let the browser show the server
      // refusing a client it doesn't know.
      if (err instanceof NetworkError) throw err;
      // A refused registration or a redirect away: the browser shows what
      // the server says about the default client.
    }
  }
  return { clientId: DEFAULT_CLIENT_ID, redirectUri: HANDOFF_REDIRECT_URI };
}

function registrationEndpoint(metadata: OAuthMetadata): string | undefined {
  if (metadata.registration_endpoint && /^https?:\/\//i.test(metadata.registration_endpoint)) {
    return metadata.registration_endpoint;
  }
  const issuer = metadata.issuer ? /^(https?:\/\/[^/?#]+)/i.exec(metadata.issuer)?.[1] : undefined;
  return issuer ? `${issuer}/auth/register` : undefined;
}

/**
 * Run the authorization-code + PKCE flow in the system browser. Throws
 * `HandoffCancelledError` when the user closes the browser. With `addAccount`
 * the provider is asked to pick or sign in another account, and iOS runs the
 * session without the browser's cookies so the current one can't carry over.
 */
export async function loginWithPkce(
  serverUrl: string,
  metadata: OAuthMetadata,
  opts?: { clientId?: string; scopes?: string; redirectUri?: string; addAccount?: boolean; authorizationParams?: Record<string, string>; requireIdToken?: boolean },
): Promise<OAuthTokens> {
  const client = opts?.clientId
    ? { clientId: opts.clientId, redirectUri: opts.redirectUri ?? HANDOFF_REDIRECT_URI }
    : await pkceClient(serverUrl, metadata);
  const { clientId, redirectUri } = client;
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = randomHex(16);
  const nonce = opts?.requireIdToken ? randomHex(16) : undefined;
  const scope = opts?.scopes ?? pkceScopes(metadata);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (opts?.addAccount) params.set('prompt', addAccountPrompt(metadata));
  if (nonce) params.set('nonce', nonce);
  for (const [key, value] of Object.entries(opts?.authorizationParams ?? {})) {
    if (!/^(orgId|orgHandle|fidp|login_hint)$/.test(key) || !value.trim()) {
      throw new HandoffError('Unsupported or empty OIDC authorization parameter');
    }
    params.set(key, value);
  }
  const authUrl = `${metadata.authorization_endpoint}${metadata.authorization_endpoint.includes('?') ? '&' : '?'}${params.toString()}`;

  const result = await WebBrowser.openAuthSessionAsync(
    authUrl,
    redirectUri,
    opts?.addAccount ? { preferEphemeralSession: true } : undefined,
  );
  if (result.type === 'cancel' || result.type === 'dismiss') throw new HandoffCancelledError();
  if (result.type !== 'success' || !result.url) throw new HandoffError(`Sign-in failed: ${result.type}`);

  const cb = parseCallbackParams(result.url);
  const err = cb.get('error');
  if (err) throw new HandoffError(cb.get('error_description') || err);
  if (cb.get('state') !== state) throw new HandoffError('State mismatch');
  const code = cb.get('code');
  if (!code) throw new HandoffError('Sign-in response missing authorization code');

  if (!sameHost(metadata.token_endpoint, serverUrl) && !/^https:\/\//i.test(metadata.token_endpoint)) {
    throw new HandoffError('Token endpoint is not trusted');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  // The code and verifier follow a redirect only within the token endpoint's
  // own host, which may be an identity provider's rather than the server's.
  let response: Response;
  try {
    response = await fetchWithoutForeignRedirect(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (e) {
    throw new HandoffError(`Could not reach the token endpoint: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new HandoffError(`Token exchange failed: ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };
  if (!data.access_token) throw new HandoffError('Token response missing access_token');
  if (opts?.requireIdToken) {
    if (!data.id_token || !nonce) throw new HandoffError('OIDC token response missing ID token');
    await verifyConfiguredIdToken(data.id_token, metadata, clientId, nonce);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenEndpoint: metadata.token_endpoint,
    clientId,
    source: 'native',
    // Kept for ending the provider's session at sign-out (endProviderSession).
    ...(typeof data.id_token === 'string' && data.id_token ? { idToken: data.id_token } : {}),
  };
}

/**
 * The provider's logout URL for a sign-out (OIDC RP-Initiated Logout 1.0;
 * webmail lib/oauth/end-session.ts buildEndSessionUrl), or null when the
 * provider advertises no end_session_endpoint or an unusable one.
 *
 * `client_id` always goes along, `id_token_hint` when the sign-in's id token
 * was kept. The browser carries the id token there, so the endpoint must be
 * https, or on the mail server's own host, which the app already talks to in
 * the clear when the user chose that. `post_logout_redirect_uri` is sent only
 * for a client the app registered itself, with that URI on file: a provider
 * refuses the whole logout for one it does not have.
 */
export function buildEndSessionUrl(
  serverUrl: string,
  metadata: Pick<OAuthMetadata, 'end_session_endpoint'>,
  tokens: Pick<OAuthTokens, 'clientId' | 'idToken'>,
): { url: string; returnUrl: string } | null {
  const endpoint = metadata.end_session_endpoint;
  if (typeof endpoint !== 'string' || !/^https?:\/\//i.test(endpoint)) return null;
  if (!/^https:\/\//i.test(endpoint) && !sameHost(endpoint, serverUrl)) return null;
  const registered = tokens.clientId !== DEFAULT_CLIENT_ID && tokens.clientId !== MOBILE_CLIENT_ID;
  const params = new URLSearchParams({ client_id: tokens.clientId });
  if (tokens.idToken) params.set('id_token_hint', tokens.idToken);
  if (registered) params.set('post_logout_redirect_uri', REGISTERED_LOGOUT_REDIRECT_URI);
  return {
    url: `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`,
    // The browser session closes when the provider sends it back to the app.
    returnUrl: registered ? REGISTERED_LOGOUT_REDIRECT_URI : REGISTERED_REDIRECT_URI,
  };
}

let endSessionQueue: Promise<void> = Promise.resolve();

/**
 * End the identity provider's own login session at sign-out, best effort.
 * Revoking the refresh token ends the app's grant, but the session the
 * provider keeps in the browser stays, and the next browser sign-in would go
 * through without asking (webmail #905). Only a browser sign-in left one
 * (source 'native'); the password and TOTP sign-ins and the webmail's
 * hand-off and pairing did not, or own it. Opens the logout page in the
 * auth browser session, one at a time. Never throws and is not awaited by
 * the sign-out.
 */
export function endProviderSession(serverUrl: string, tokens: OAuthTokens): Promise<void> {
  if (tokens.source !== 'native') return Promise.resolve();
  const run = async () => {
    try {
      const metadata = await discoverOAuthMetadata(serverUrl);
      const target = metadata ? buildEndSessionUrl(serverUrl, metadata, tokens) : null;
      if (!target) return;
      await WebBrowser.openAuthSessionAsync(target.url, target.returnUrl);
    } catch {
      // never block or fail a sign-out
    }
  };
  endSessionQueue = endSessionQueue.then(run, run);
  return endSessionQueue;
}

/**
 * Best-effort RFC 7009 revocation of a refresh token on sign-out. Never
 * throws; the caller is already dropping the credentials.
 */
export async function revokeRefreshToken(serverUrl: string, tokens: OAuthTokens): Promise<void> {
  if (!tokens.refreshToken) return;
  try {
    const metadata = await discoverOAuthMetadata(serverUrl);
    const endpoint = metadata?.revocation_endpoint;
    if (!endpoint || !/^https?:\/\//i.test(endpoint)) return;
    const body = new URLSearchParams({
      token: tokens.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: tokens.clientId,
    });
    await fetchWithoutForeignRedirect(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    // ignore
  }
}
