import Constants from 'expo-constants';
import {
  validateOrganizationConfig,
  type OrganizationConfig,
} from './organization-resolver';

let cachedRaw: unknown;
let cachedConfig: OrganizationConfig | null = null;

/**
 * Read the public, build-time organization map embedded by app.config.js.
 * Invalid configuration throws so a broken production tenant map fails
 * closed instead of silently falling back to arbitrary server discovery.
 */
export function getOrganizationConfig(): OrganizationConfig | null {
  const extra = Constants.expoConfig?.extra as { irisaOrganizations?: unknown } | undefined;
  const raw = extra?.irisaOrganizations;
  if (raw == null) return null;
  if (raw === cachedRaw && cachedConfig) return cachedConfig;
  const validated = validateOrganizationConfig(raw);
  cachedRaw = raw;
  cachedConfig = validated;
  return validated;
}

/** Reset only for deterministic unit tests. */
export function resetOrganizationConfigCache(): void {
  cachedRaw = undefined;
  cachedConfig = null;
}
