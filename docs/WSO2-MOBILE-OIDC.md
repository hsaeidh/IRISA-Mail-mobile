# WSO2 Identity Server 7.3.0 — IRISA Mail Mobile OIDC

This guide describes the implemented mobile authorization flow. It does not
replace the Stalwart-side configuration needed to accept WSO2 access tokens.

## Flow

1. The user enters an email address.
2. The app resolves its domain using the exact allow-list in the bundled
   organization configuration. It does not build an issuer or mail hostname
   from the email domain.
3. The configured organization supplies a fixed WSO2 issuer, public client ID,
   redirect URI, organization identifier, and one approved JMAP origin.
4. The app loads OIDC discovery metadata from
   `<issuer>/.well-known/openid-configuration`. It requires the returned
   issuer to match exactly and the authorization, token, and JWKS endpoints
   to use HTTPS on the issuer's origin.
5. The app performs Authorization Code + PKCE (S256), passing `orgId` (or
   `orgHandle`) to WSO2. It validates the returned ID token's RS256 signature,
   issuer, audience, expiry, issue time, and nonce against the discovered JWKS.
6. The resulting access token is presented to the configured Stalwart JMAP
   origin to create the mail session.

The app's ID-token validation authenticates the OIDC response to the mobile
client. It does **not** by itself make the WSO2 access token acceptable to
Stalwart. Stalwart must separately be configured to trust/validate WSO2-issued
access tokens and their expected audience/scopes. This final server-side
integration must be tested against the actual IRISA Stalwart deployment.

## WSO2 application setup

Create the OIDC application in the WSO2 organization whose issuer is placed in
the configuration (for the current root-organization design, use the root
organization's application).

Configure:

- Application/client type: **Native / public client** (not confidential).
- Grant: **Authorization Code**.
- PKCE: require S256 where the WSO2 application settings expose that option.
- Redirect URI, exactly:

  `ir.irisa.mail:/oauth/callback`

- Scopes: `openid`, `profile`, `email`, and `offline_access` if refresh
  tokens are required. Add any Stalwart-specific scopes only after confirming
  that WSO2 issues them and Stalwart expects them.
- Do not put a client secret in the mobile configuration. A native app cannot
  protect a shared client secret.

For enhanced organization authentication, the app sends the configured
`orgId` or `orgHandle` parameter on the initial authorization request. The
resolver prefers `orgId` when both are configured. For a WSO2 deployment still
using the legacy Organization SSO federated authenticator, set
`legacyOrganizationSso: true`; this additionally sends
`fidp=OrganizationSSO`. Do not enable this flag for the enhanced model unless
the WSO2 authentication flow is configured for the legacy authenticator.

The configured issuer must be the exact value returned by WSO2 discovery. A
typical WSO2 Identity Server issuer has the form
`https://identity.example.org/oauth2/token`, and its discovery document is
at `https://identity.example.org/oauth2/token/.well-known/openid-configuration`.
Use the issuer and endpoint values shown by your own WSO2 installation rather
than copying this example.

## Organization map

1. Copy `config/organizations.example.json` to
   `config/organizations.json`.
2. Replace the reserved example domain, issuer, organization handle/ID, client
   ID, and mail origin with values from your deployment.
3. Keep `redirectUri` exactly `ir.irisa.mail:/oauth/callback`.
4. Ensure `jmap.allowedOrigins` contains only the HTTPS origin of the user's
   Stalwart JMAP service. Do not include a path such as `/jmap/session`.
5. Leave `fallback.allowManualServerEntry` false for a strict IRISA-only
   distribution. Set it true only if administrators intentionally permit
   unlisted domains to use the legacy manual/discovery path.
6. Never add a client secret, private key, access token, or refresh token.

The file is loaded at Expo configuration time through
`IRISA_ORGANIZATIONS_CONFIG` and embedded as public app configuration. It is
not loaded dynamically from a URL at sign-in time.

### Windows CMD

From the repository root:

```cmd
copy config\organizations.example.json config\organizations.json
set IRISA_ORGANIZATIONS_CONFIG=config\organizations.json
npx expo run:android
```

For a release build, set the same environment variable in the build runner
before running the Expo/EAS build command. The configuration file is public
routing metadata, not a secret.

### Linux/macOS

```bash
cp config/organizations.example.json config/organizations.json
IRISA_ORGANIZATIONS_CONFIG=config/organizations.json npx expo run:android
```

## Important deployment checks

- Register the exact redirect URI in WSO2 and verify Android resolves the
  `ir.irisa.mail` callback scheme after a native rebuild.
- Verify WSO2's discovery document is reachable over trusted TLS and publishes
  an RS256 signing key in its JWKS.
- Verify the WSO2 public client can complete authorization-code + PKCE without
  a client secret.
- Verify the organization ID/handle routes a user from the root application
  to the intended child organization.
- Configure Stalwart to trust the WSO2 access-token issuer/signing keys and
  enforce the intended audience/scopes. Confirm the access token can create a
  JMAP session and cannot access another organization's mail.
- Test token refresh, expiry, logout, account switching, and revoked access.
- Do not enable production WSO2 login until the Stalwart token acceptance and
  tenant-isolation checks pass.

## References

- [WSO2 IS 7.1 OIDC discovery guide](https://is.docs.wso2.com/en/7.1.0/guides/authentication/oidc/discover-oidc-configs/)
- [WSO2 IS organization discovery](https://is.docs.wso2.com/en/latest/guides/organization-management/organization-discovery/organization-discovery/)
- [WSO2 IS organization-based login](https://is.docs.wso2.com/en/next/guides/organization-management/organization-login/)
