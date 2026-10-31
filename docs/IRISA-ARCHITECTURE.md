# IRISA Mail Mobile — Architecture and delivery plan

## Product scope

This repository is the IRISA-only distribution of Bulwark Native for IRISA and its subsidiaries. It is not intended to become a general white-label product.

Target platforms: Android and iOS.

The upstream project remains the JMAP mail/calendar/contacts client. IRISA-specific behavior must be isolated behind configuration, adapters, Expo config plugins, and native modules wherever possible.

## Decisions recorded

| Area | Decision |
|---|---|
| Product | IRISA Mail Mobile |
| Audience | IRISA and subsidiary organizations only |
| Identity | Both WSO2 OIDC and direct JMAP login |
| Organization selection | Resolve the organization from the entered email domain using an explicit allow-listed map |
| Android notifications | Support the existing Bulwark relay and UnifiedPush; add an embedded ntfy-compatible client so users do not need to install the ntfy app |
| iOS notifications | APNs through the IRISA push relay; do not assume Android UnifiedPush behavior exists on iOS |
| Push selection | User-selectable where multiple supported transports are available |
| Languages | Persian and English, with correct RTL behavior for Persian |

The organization map must be explicit. Never derive an issuer, OAuth client, organization ID, or JMAP host from an untrusted email-domain string. Unknown domains must fail closed and offer a safe manual configuration path only if enabled by administrators.

## Authentication architecture

### WSO2 OIDC

- Use Authorization Code Flow with PKCE (S256).
- Resolve the email domain against the bundled allow-list before opening the WSO2 authorization page; send the configured `orgId` (preferred) or `orgHandle` to the root-organization authorization endpoint.
- Load discovery only from the configured HTTPS issuer, require exact issuer equality, and restrict authorization/token/JWKS endpoints to that issuer origin.
- Require and cryptographically validate the RS256 ID token signature through the discovered JWKS, plus issuer, audience, expiry, issue time, and nonce.
- The mobile app is a public client. Never embed a client secret in the application bundle.
- Configure one trusted OIDC profile per organization where WSO2 organization routing requires it.
- Bind each accepted email domain to a preconfigured WSO2 issuer, client ID, redirect URI, and organization identifier/handle.
- Validate issuer, state, nonce (where applicable), redirect URI, and token audience.
- Store refresh/access credentials only in platform secure storage.
- Do not treat an email claim alone as proof that a user belongs to an organization.
- Support account switching and logout without leaking tokens between organizations.

### Direct JMAP

- Keep direct JMAP authentication as a separate provider.
- Use only authentication methods advertised and supported by the configured Stalwart/JMAP deployment.
- Do not silently downgrade from OIDC to password authentication.
- Use TLS, validate server origins, and keep credentials in secure storage.
- Organization mapping may supply the expected Stalwart endpoint, but the endpoint must be allow-listed.

## Organization configuration

The template is `config/organizations.example.json`. A deployment copies it to the ignored `config/organizations.json` and sets `IRISA_ORGANIZATIONS_CONFIG` during the Expo build. `app.config.js` embeds that public routing map in Expo `extra`; `src/lib/irisa-config.ts` validates it at runtime and `src/lib/organization-resolver.ts` performs exact domain matching. No production configuration is committed.

Each organization entry may define:
- stable internal organization key and display name;
- accepted email domains;
- WSO2 issuer and organization routing metadata (`orgId` or `orgHandle`);
- public OIDC client ID, scopes, and exact app redirect URI;
- allowed JMAP origins (required when external OIDC is enabled);
- optional legacy WSO2 `fidp=OrganizationSSO` selection and branding key.

Production configuration must be supplied by the build/release environment or a protected deployment configuration. Never commit client secrets, private keys, signing credentials, or user data. The resolver rejects `clientSecret`/`client_secret` fields because a native mobile app is a public OAuth client.

## Notifications

### Existing upstream capability

The upstream code already contains a hosted Bulwark relay path, FCM handling, Android UnifiedPush integration, and iOS APNs-related native code. Preserve these capabilities while adding IRISA providers behind a transport abstraction.

### Android embedded ntfy client

The target experience is that the user installs only IRISA Mail. The app itself subscribes to the IRISA ntfy server and displays Android notifications; the separate ntfy application is not required.

Important implementation constraints:
- The ntfy protocol client is an app component, not a UnifiedPush distributor.
- Use authenticated, per-device/per-user subscriptions. Do not use guessable public topics.
- Provision and revoke subscriptions through a trusted backend or a narrowly scoped credential flow; never place a server-wide access token in the APK.
- Persist message IDs/cursors safely and support reconnect/replay without duplicate notifications.
- Use a native Android background execution strategy compatible with current Android foreground-service and background-start restrictions.
- A permanently running foreground service may require a visible ongoing notification and user-visible disclosure. Do not claim that a persistent socket is guaranteed to survive force-stop, OEM battery restrictions, or all network transitions.
- Prefer a push wake-up mechanism (FCM or another supported platform transport) when available; direct ntfy streaming is an explicit alternative with documented device limitations.
- Add battery, reconnect, offline, duplicate-delivery, token-revocation, and force-stop tests.

### UnifiedPush

Keep UnifiedPush as an optional Android path for users who already have a compatible distributor. It is distinct from the embedded ntfy client. The embedded ntfy implementation must not pretend to be a UnifiedPush distributor.

### iOS

Use APNs and the existing iOS notification extension/relay architecture. iOS background execution does not permit assuming an always-on HTTP stream will work like Android. Keep provider selection platform-aware and explain unsupported combinations in the UI.

### Push transport selection

The settings UI should expose only transports supported by the current platform/build and organization policy. Prevent simultaneous duplicate delivery by ensuring one active transport per device/account unless a deliberate fallback policy is implemented and tested.

## Branding and platform identity

The proposed brand defaults are recorded in `config/irisa-brand.example.json`. Application identifiers and URL schemes must be changed consistently across Expo config, native Android manifests/flavors, iOS bundle settings, push entitlements, OAuth redirect registrations, and release workflows.

Do not replace binary artwork with text placeholders. Final icons/splash assets must be supplied and reviewed before a branded release.

## Upstream maintenance strategy

Branches:
- `main`: stable IRISA release branch.
- `development`: IRISA implementation and integration branch.
- `upstream-sync`: clean mirror of `bulwarkmail/native:main`, used only as the source side of upstream update PRs.

Rules:
1. Never develop IRISA features directly on `upstream-sync`.
2. Pull upstream changes into `upstream-sync` and open a PR targeting `development`.
3. Resolve conflicts in `development`, run checks, and review native platform changes before merging.
4. Promote tested `development` to `main) using a reviewed PR.
5. Tag releases as `irisa-vX.Y.Z`; record the exact upstream commit in release notes.
6. Keep IRISA-only code in dedicated directories/modules and minimize edits to upstream files.
7. When an upstream file must be patched, document the reason and add a regression test.

The workflow in `.github/workflows/upstream-sync.yml` provides a manual/scheduled upstream mirror update and opens or updates a PR. It does not auto-merge.

## Delivery phases

### Phase 0 — repository foundation
- [x] Verify repository is a fork-equivalent copy of upstream at the same commit.
- [x] Create `development` and `upstream-sync` branches.
- [x] Record architecture and configuration contracts.
- [ ] Enable branch protection and required CI checks in GitHub repository settings.

### Phase 1 — identity and organization routing
- [x] Implement strict organization resolution with exact domain allow-list matching, HTTPS issuer/JMAP validation, duplicate-domain rejection, and client-secret rejection.
- [x] Load deployment-specific organization configuration through `IRISA_ORGANIZATIONS_CONFIG`; ignore the local production config file in Git.
- [x] Route email-first login through the configured organization and use its allow-listed JMAP origin.
- [x] Add WSO2-compatible Authorization Code + PKCE login with `orgId`/`orgHandle` routing and RS256 ID-token signature/claim/nonce validation.
- [x] Register the dedicated `ir.irisa.mail:/oauth/callback` scheme in Expo and Android configuration.
- [x] Add resolver and WSO2 OIDC unit tests; verify final CI result before treating the phase as test-complete.
- [ ] Verify WSO2 login against the actual IRISA IS 7.3.0 tenant setup and verify Stalwart accepts only the intended WSO2 access-token audience/scopes.
- [ ] Add end-to-end tenant-isolation, refresh, account-switching, and revocation tests.
- [ ] Keep direct JMAP password/token sign-in as a separately available path and test its coexistence with organization SSO.

### Phase 2 — branding and localization
- [ ] Wire IRISA build-time branding and identifiers through all native targets.
- [ ] Verify Persian RTL layouts and English LTR layouts on real devices.
- [ ] Add IRISA source-code/about links and release metadata.

### Phase 3 — notifications
- [ ] Preserve and test upstream relay/FCM and UnifiedPush paths.
- [ ] Implement embedded Android ntfy client and secure subscription provisioning.
- [ ] Integrate Android background execution and notification channels.
- [ ] Confirm APNs relay behavior for iOS and platform-specific settings.
- [ ] Test reconnect, offline replay, duplicate suppression, revocation, battery use, and OS restrictions.

### Phase 4 — release
- [ ] Run typecheck, unit tests, Android build, iOS build, and device regression tests.
- [ ] Verify AGPL-3.0-only obligations and app-store distribution permission status before distribution.
- [ ] Publish source corresponding to every distributed build.

## Security and licensing

The upstream repository states AGPL-3.0-only and includes a provisional additional app-store distribution permission. Preserve copyright/license notices and review the current LICENSE and contributor-permission status before publishing to app stores. This document is an engineering record, not legal advice.

Never commit secrets, production user data, private signing material, FCM service-account credentials, APNs private keys, or WSO2 client secrets.
