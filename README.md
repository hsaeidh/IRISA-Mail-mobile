# IRISA Mail Mobile

IRISA's Android and iOS mobile mail client, based on the upstream
[Bulwark Native](https://github.com/bulwarkmail/native) React Native / Expo
application.

This repository is the IRISA-specific application for IRISA and its
subsidiary organizations. It is not a general-purpose white-label product.
The app is being adapted to use WSO2 Identity Server 7.3.0 for organization-aware
OIDC sign-in and Stalwart JMAP for mail access.

## Project status

- Organization-aware email-domain resolution and WSO2 Authorization Code +
  PKCE sign-in are implemented in the development branch.
- The OIDC ID token is verified using the issuer's JWKS (RS256), including
  issuer, audience, expiry, issue-time and nonce checks.
- The organization map is supplied at build time; production domains and
  organization identifiers are not committed.
- Direct JMAP password/token sign-in remains available.
- The upstream Bulwark Firebase project and hosted push relay are not used by
  IRISA builds. The IRISA relay and embedded ntfy transport are still being
  integrated.
- The native app identifiers are being changed to IRISA. Final logo, app icon,
  splash artwork, Apple Team ID and production signing configuration still
  need deployment-specific inputs.

Do not treat this development branch as a production release until the
WSO2-to-Stalwart access-token trust, tenant isolation, native builds, push
delivery, and final brand assets have all been tested.

## Build locally

Install dependencies:

```bash
npm ci
```

For an Android development build, configure the public organization map as
described in [WSO2 mobile OIDC setup](docs/WSO2-MOBILE-OIDC.md), then:

```cmd
set IRISA_ORGANIZATIONS_CONFIG=config\organizations.json
npx expo run:android
```

See [Android release signing](docs/android-release.md) for release APK/AAB
signing. For iOS, set `APPLE_TEAM_ID` to the Apple Developer Team ID before
building; see [iOS release](docs/ios-release.md).

## Architecture and maintenance

- [IRISA architecture and roadmap](docs/IRISA-ARCHITECTURE.md)
- [WSO2 IS 7.3.0 mobile OIDC setup](docs/WSO2-MOBILE-OIDC.md)
- [Upstream maintenance and sync strategy](docs/UPSTREAM-MAINTENANCE.md)

The `upstream-sync` branch mirrors `bulwarkmail/native` and must remain free
of IRISA-specific changes. IRISA implementation work belongs on
`development`; production releases are promoted to `main` only after review
and verification.

## License

AGPL-3.0-only, with the additional app-store permission included by the
upstream project. See [LICENSE](LICENSE) and preserve all required notices.
