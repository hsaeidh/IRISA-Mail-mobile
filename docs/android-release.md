# IRISA Mail — Android release builds

Android release APK/AAB builds are produced by
[release-android.yml](../.github/workflows/release-android.yml). Release builds
must use the private IRISA signing key. The public React Native debug key is
never accepted for a published build.

## Application IDs

| Flavor | Application ID | Distribution |
|---|---|---|
| github | ir.irisa.mail.github | APK attached to GitHub Releases; supports sideload updates |
| play | ir.irisa.mail | AAB uploaded to Google Play; updates are managed by Play |

The flavors are separate Android applications and can be installed side by side.
Both must be signed with the same IRISA release key if users are expected to
move between distribution channels in the future. The Android Gradle
namespace remains an internal React Native namespace; it is not the
installed application ID.

The IRISA package IDs are new. The upstream Bulwark debug-key signing lineage
is deliberately not carried over: it does not apply to these package IDs and
would let the old public debug key sign updates to the new app.

## 1. Generate the release keystore

Use a supported JDK's keytool. Run from the repository root:

~~~cmd
set IRISA_KS_PASS=REPLACE_WITH_A_LONG_RANDOM_PASSWORD
keytool -genkeypair -v -storetype PKCS12 -keystore irisa-release.p12 ^
  -alias irisa -keyalg RSA -keysize 4096 -validity 10000 ^
  -dname "CN=IRISA Mail, O=IRISA" ^
  -storepass:env IRISA_KS_PASS -keypass:env IRISA_KS_PASS
~~~

Use a password manager to create and store the password. Back up the
irisa-release.p12 file and password separately in at least two secure places.
If the keystore is lost, Android will not accept a differently signed update to
an installed IRISA app.

Export and record the certificate fingerprint:

~~~cmd
keytool -exportcert -keystore irisa-release.p12 -alias irisa ^
  -storepass:env IRISA_KS_PASS -file irisa-release-cert.der
~~~

Then calculate SHA-256 with PowerShell or Git Bash:

~~~powershell
Get-FileHash .\irisa-release-cert.der -Algorithm SHA256
~~~

Never commit the keystore, certificate, or passwords.

## 2. Configure GitHub Actions secrets

In the repository, open **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| ANDROID_KEYSTORE_BASE64 | Base64 of irisa-release.p12 |
| ANDROID_KEYSTORE_PASSWORD | Keystore password |
| ANDROID_KEY_ALIAS | irisa |
| ANDROID_KEY_PASSWORD | Same password for this PKCS12 key |

To create the base64 value on Windows when Python is installed:

~~~cmd
python -c "import base64; print(base64.b64encode(open('irisa-release.p12','rb').read()).decode())"
~~~

Copy the single output line into ANDROID_KEYSTORE_BASE64. In Git Bash:

~~~bash
base64 -w0 irisa-release.p12
~~~

The workflow checks the keystore, alias, password and certificate before
building. It also verifies that both Android 9+ and Android 7-8.1 see only the
IRISA release certificate as the APK signer. There is no debug-key or signing
lineage fallback.

## 3. Local release builds

For local Gradle builds, use these properties in
%USERPROFILE%\.gradle\gradle.properties (Windows) or
~/.gradle/gradle.properties (Linux/macOS). Do not put secrets in the
repository's committed android/gradle.properties.

~~~properties
IRISA_RELEASE_STORE_FILE=C:/secure/keys/irisa-release.p12
IRISA_RELEASE_STORE_PASSWORD=REPLACE_WITH_PASSWORD
IRISA_RELEASE_KEY_ALIAS=irisa
IRISA_RELEASE_KEY_PASSWORD=REPLACE_WITH_PASSWORD
~~~

Build the GitHub APK:

~~~cmd
cd android
gradlew.bat assembleGithubRelease
~~~

Build the Play AAB:

~~~cmd
gradlew.bat bundlePlayRelease
~~~

Debug builds and npx expo run:android do not need the release keystore.
A release build without the signing properties fails before packaging.

## 4. Organization and push configuration

The mobile application uses public, build-time organization routing metadata.
Create config/organizations.json from
config/organizations.example.json and follow
[WSO2-MOBILE-OIDC.md](WSO2-MOBILE-OIDC.md). Set
IRISA_ORGANIZATIONS_CONFIG before running Expo or a release build.

The upstream Bulwark Firebase project configuration has been removed. FCM is
disabled unless IRISA supplies its own android/app/google-services.json.
That local file is gitignored and must contain clients for both
ir.irisa.mail.github and ir.irisa.mail. Never copy the upstream Firebase
configuration into this repository.

If using the existing IRISA-compatible push relay, set
IRISA_PUSH_RELAY_URL to its HTTPS base URL at build time. No upstream hosted
Bulwark relay is configured by default. The app's embedded ntfy transport is a
separate planned integration; UnifiedPush remains an optional Android
alternative that requires a compatible distributor.

## 5. Google Play

The play flavor uses package ID ir.irisa.mail. Create that app record in
Google Play Console before enabling automated uploads. Configure Play App
Signing and register the IRISA upload certificate. Set
PLAY_SERVICE_ACCOUNT_JSON in repository secrets if the workflow should
upload the AAB to testing tracks.

The github flavor uses ir.irisa.mail.github and is published as an APK on
GitHub Releases. Play forbids self-updating APKs, so the Play flavor does not
include the sideload updater.

## 6. Version and crash symbols

The app version comes from the root VERSION file. Android's versionCode
is derived from that value and must increase with each release.

R8 mapping files are named irisa-mail-<version>-<commit>-mapping.txt and
attached to the release/workflow artifact. Keep the mapping from each exact
release to decode obfuscated crash stack traces.
