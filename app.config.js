const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const VERSION = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();

let COMMIT = process.env.GITHUB_SHA || '';
if (!COMMIT) {
  try {
    COMMIT = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    COMMIT = 'dev';
  }
}
COMMIT = COMMIT.slice(0, 7);

// App Store Connect rejects a build whose CFBundleVersion it has already seen
// for this CFBundleShortVersionString, so this has to advance on every upload
// even when VERSION does not. CI passes the workflow run number; local builds
// fall back to 1 (never uploaded).
const IOS_BUILD_NUMBER = process.env.IOS_BUILD_NUMBER || '1';

// Apple team: prefixes the keychain groups the app shares with its
// notification service extension (plugins/ios-push). Not a secret.
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || '';
// Which APNs host the device tokens belong to: TestFlight and App Store builds
// use production, simulators and development builds the sandbox.
const APS_ENVIRONMENT = process.env.APS_ENVIRONMENT === 'development' ? 'development' : 'production';

/**
 * Public tenant routing configuration. The JSON contains issuer/client IDs
 * and organization identifiers, never client secrets. Supply a deployment-
 * specific file with IRISA_ORGANIZATIONS_CONFIG; no example config is bundled
 * into a release by default.
 */
const HAS_ANDROID_GOOGLE_SERVICES = fs.existsSync(path.join(__dirname, 'android/app/google-services.json'));

let IRISA_ORGANIZATIONS = null;
if (process.env.IRISA_ORGANIZATIONS_CONFIG) {
  const configPath = path.resolve(__dirname, process.env.IRISA_ORGANIZATIONS_CONFIG);
  IRISA_ORGANIZATIONS = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!IRISA_ORGANIZATIONS || IRISA_ORGANIZATIONS.schemaVersion !== 1 ||
      !Array.isArray(IRISA_ORGANIZATIONS.organizations)) {
    throw new Error('IRISA_ORGANIZATIONS_CONFIG must contain schemaVersion 1 and an organizations array');
  }
}

module.exports = {
  expo: {
    name: 'IRISA Mail',
    slug: 'irisa-mail',
    // mailto: lets Android/iOS offer the app for mail links in other apps;
    // bulwarkmail: is the webmail's sign-in link (bulwarkmail://pair?...).
    // org.bulwarkmail.mobile: is where Stalwart 1.0 sends the browser sign-in
    // back: it registers public clients only with a scheme that has a dot.
    // Android's manifest is maintained by hand and lists the same schemes.
    scheme: ['bulwarkmobile', 'bulwarkmail', 'mailto', 'org.bulwarkmail.mobile', 'irisamail', 'ir.irisa.mail'],
    version: VERSION,
    orientation: 'default',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
      dark: {
        image: './assets/splash-icon.png',
        backgroundColor: '#09090b',
      },
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'ir.irisa.mail',
      buildNumber: IOS_BUILD_NUMBER,
      config: {
        // PGP and S/MIME (#58) add end-to-end encryption beyond HTTPS/TLS,
        // so the app declares non-exempt encryption; App Store Connect asks
        // for the export compliance documentation on upload.
        usesNonExemptEncryption: true,
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#db2d54',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: 'ir.irisa.mail',
      // The AsyncStorage database holds cached message bodies, the outbox and
      // the account registry; the platform backup would ship all of it to the
      // user's Google account. Credentials live in SecureStore (excluded by
      // its own rules) but the mail cache must not leave the device either.
      allowBackup: false,
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      'expo-secure-store',
      // WebCrypto for PGP and S/MIME (#58). On iOS it raises the deployment
      // target (app and pods) to 16.4, the minimum Nitro modules build for;
      // Android has nothing to set.
      'react-native-quick-crypto',
      '@react-native-community/datetimepicker',
      'expo-localization',
      [
        'expo-camera',
        {
          cameraPermission:
            'IRISA Mail uses the camera to scan supported sign-in QR codes.',
          // QR scanning never records audio; leaving the mic entry in would be
          // an unexplained permission in App Review.
          microphonePermission: false,
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission:
            'IRISA Mail needs access to your photos so you can attach them to emails and set contact photos.',
          // Only launchImageLibraryAsync is used - no in-app capture.
          cameraPermission: false,
          microphonePermission: false,
        },
      ],
      ['./plugins/ios-push', { apsEnvironment: APS_ENVIRONMENT, teamId: APPLE_TEAM_ID }],
      // TLS client certificates (#3): the iOS side of src/lib/client-cert.ts.
      './plugins/ios-client-cert',
      // The iOS inbox widget (WidgetKit); src/widgets/ios.ts feeds it.
      ['./plugins/ios-widget', { teamId: APPLE_TEAM_ID }],
      // The reading fonts (Settings > Accessibility > Font) for the app's
      // text on iOS, found by the family names in the files
      // (src/theme/reading-fonts.ts). iOS only: Android reads the same files
      // from its hand-maintained assets/fonts, where the plugin would copy
      // them onto themselves.
      [
        'expo-font',
        {
          ios: {
            fonts: [
              'AtkinsonHyperlegibleNext.ttf',
              'AtkinsonHyperlegibleNext_bold.ttf',
              'Lexend.ttf',
              'Lexend_bold.ttf',
              'OpenDyslexic.ttf',
              'OpenDyslexic_bold.ttf',
            ].map((file) => `./android/app/src/main/assets/fonts/${file}`),
          },
        },
      ],
      // Bundles the Involved sound calendar reminders (src/lib/calendar-
      // notifications.ts) and new mail (plugins/ios-push) play on iOS.
      // Android has it in res/raw.
      [
        'expo-notifications',
        {
          mode: APS_ENVIRONMENT,
          sounds: ['./assets/sounds/involved_notification.wav'],
        },
      ],
    ],
    extra: {
      commit: COMMIT,
      // Settings → About → Source code. A modified build sets SOURCE_CODE_URL
      // to where its own source is (AGPL §13); the default is upstream.
      sourceCodeUrl: process.env.SOURCE_CODE_URL || 'https://github.com/hsaeidh/IRISA-Mail-mobile',
      // src/lib/ios-push-shared.ts
      iosSharedKeychainGroup: APPLE_TEAM_ID ? `${APPLE_TEAM_ID}.ir.irisa.mail.shared` : null,
      iosAppKeychainGroup: APPLE_TEAM_ID ? `${APPLE_TEAM_ID}.ir.irisa.mail` : null,
      apnsEnvironment: APS_ENVIRONMENT === 'development' ? 'sandbox' : 'production',
      irisaOrganizations: IRISA_ORGANIZATIONS,
      fcmEnabled: HAS_ANDROID_GOOGLE_SERVICES,
      irisaPushRelayUrl: process.env.IRISA_PUSH_RELAY_URL || '',
    },
  },
};
