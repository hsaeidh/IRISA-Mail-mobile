import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as WebBrowser from 'expo-web-browser';
import { generateKeyPairSync, createSign } from 'node:crypto';

vi.mock('../client-cert', () => {
  const fetchMock = vi.fn();
  return {
    secureFetch: fetchMock,
    fetchWithoutForeignRedirect: fetchMock,
    followedOnlyAllowedRedirects: () => false,
    mayFollowRedirect: () => false,
  };
});

import { secureFetch } from '../client-cert';
import {
  discoverConfiguredOidcMetadata,
  loginWithPkce,
  type OAuthMetadata,
} from '../oauth-native';

const fetchMock = secureFetch as unknown as ReturnType<typeof vi.fn>;
const openAuthSession = WebBrowser.openAuthSessionAsync as ReturnType<typeof vi.fn>;
const issuer = 'https://identity.example.org/oauth2/token';
const metadataUrl = `${issuer}/.well-known/openid-configuration`;
const metadata: OAuthMetadata = {
  issuer,
  authorization_endpoint: 'https://identity.example.org/oauth2/authorize',
  token_endpoint: 'https://identity.example.org/oauth2/token',
  jwks_uri: 'https://identity.example.org/oauth2/jwks',
  revocation_endpoint: 'https://identity.example.org/oauth2/revoke',
  end_session_endpoint: 'https://identity.example.org/oidc/logout',
  scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
  id_token_signing_alg_values_supported: ['RS256'],
};

function response(body: unknown, url: string): Response {
  const result = new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

function makeSignedIdToken(nonce: string, overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'irisa-test-key', use: 'sig', alg: 'RS256' };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'irisa-test-key' });
  const payload = encode({
    iss: issuer,
    sub: 'user-123',
    aud: 'irisa-mobile',
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    nonce,
    ...overrides,
  });
  const signed = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signed);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');
  return { idToken: `${signed}.${signature}`, jwks: { keys: [jwk] } };
}

describe('configured OIDC for WSO2 organizations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads WSO2-style issuer metadata only when issuer and endpoint origins match', async () => {
    fetchMock.mockResolvedValue(response(metadata, metadataUrl));
    await expect(discoverConfiguredOidcMetadata(issuer)).resolves.toMatchObject({
      issuer,
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
      jwks_uri: metadata.jwks_uri,
    });
    expect(fetchMock).toHaveBeenCalledWith(metadataUrl, expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects issuer substitution and endpoints on another origin', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...metadata, issuer: 'https://attacker.example/issuer' }, metadataUrl));
    await expect(discoverConfiguredOidcMetadata(issuer)).rejects.toThrow(/issuer does not match/);

    fetchMock.mockResolvedValueOnce(response({
      ...metadata,
      authorization_endpoint: 'https://attacker.example/authorize',
    }, metadataUrl));
    await expect(discoverConfiguredOidcMetadata(issuer)).rejects.toThrow(/configured issuer origin/);
  });

  it('routes the PKCE request to the configured WSO2 organization and verifies its ID token', async () => {
    const clientId = 'irisa-mobile';
    let signedToken = '';
    let jwks: unknown;
    openAuthSession.mockImplementation(async (authUrl: string, redirectUri: string) => {
      const params = new URL(authUrl).searchParams;
      const signed = makeSignedIdToken(params.get('nonce')!);
      signedToken = signed.idToken;
      jwks = signed.jwks;
      return {
        type: 'success',
        url: `${redirectUri}?code=authorization-code&state=${params.get('state')}`,
      };
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === metadata.jwks_uri) return response(jwks, url);
      if (url === metadata.token_endpoint) {
        return response({ access_token: 'jmap-access-token', id_token: signedToken, expires_in: 600 }, url);
      }
      throw new Error(`Unexpected OIDC request: ${url}`);
    });

    const tokens = await loginWithPkce('https://mail.example.org', metadata, {
      clientId,
      redirectUri: 'ir.irisa.mail:/oauth/callback',
      logoutRedirectUri: 'ir.irisa.mail:/oauth/logout',
      scopes: 'openid profile email offline_access',
      authorizationParams: { orgId: 'wso2-org-id-123' },
      requireIdToken: true,
    });

    const [authorizationUrl, callbackUri] = openAuthSession.mock.calls[0];
    const params = new URL(authorizationUrl as string).searchParams;
    expect(params.get('orgId')).toBe('wso2-org-id-123');
    expect(params.get('client_id')).toBe(clientId);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('nonce')).toBeTruthy();
    expect(callbackUri).toBe('ir.irisa.mail:/oauth/callback');
    expect(tokens.accessToken).toBe('jmap-access-token');
    expect(tokens.idToken).toBe(signedToken);
    expect(tokens.issuer).toBe(issuer);
    expect(tokens.revocationEndpoint).toBe(metadata.revocation_endpoint);
    expect(tokens.endSessionEndpoint).toBe(metadata.end_session_endpoint);
    expect(tokens.logoutRedirectUri).toBe('ir.irisa.mail:/oauth/logout');
  });

  it('rejects a validly signed ID token with a mismatched nonce', async () => {
    openAuthSession.mockImplementation(async (authUrl: string, redirectUri: string) => {
      const params = new URL(authUrl).searchParams;
      const signed = makeSignedIdToken('wrong-nonce');
      fetchMock.mockImplementation(async (url: string) => {
        if (url === metadata.jwks_uri) return response(signed.jwks, url);
        if (url === metadata.token_endpoint) return response({
          access_token: 'access',
          id_token: signed.idToken,
        }, url);
        throw new Error(`Unexpected OIDC request: ${url}`);
      });
      return {
        type: 'success',
        url: `${redirectUri}?code=code&state=${params.get('state')}`,
      };
    });

    await expect(loginWithPkce('https://mail.example.org', metadata, {
      clientId: 'irisa-mobile',
      redirectUri: 'ir.irisa.mail:/oauth/callback',
      requireIdToken: true,
    })).rejects.toThrow(/claims validation failed/);
  });
});
