import { describe, expect, it } from 'vitest';
import {
  JMAPSessionOriginError,
  validateJmapSessionOrigins,
} from '../session-origin-policy';

const server = 'https://mail.msc.test';
const session = {
  apiUrl: '/jmap/session',
  downloadUrl: '/jmap/download/{accountId}/{blobId}',
  uploadUrl: '/jmap/upload/{accountId}',
  eventSourceUrl: '/jmap/events',
};

describe('JMAP session origin policy', () => {
  it('accepts relative and same-origin JMAP resource URLs', () => {
    expect(() => validateJmapSessionOrigins(session, server)).not.toThrow();
    expect(() => validateJmapSessionOrigins({
      ...session,
      apiUrl: 'https://mail.msc.test/jmap/session',
      downloadUrl: 'https://mail.msc.test/download',
    }, server)).not.toThrow();
  });

  it('rejects an API URL that points to another origin', () => {
    expect(() => validateJmapSessionOrigins({
      ...session,
      apiUrl: 'https://attacker.test/jmap/session',
    }, server)).toThrow(JMAPSessionOriginError);
  });

  it('rejects external upload, download and event-source URLs by default', () => {
    for (const field of ['downloadUrl', 'uploadUrl', 'eventSourceUrl'] as const) {
      expect(() => validateJmapSessionOrigins({
        ...session,
        [field]: 'https://attacker.test/resource',
      }, server)).toThrow(JMAPSessionOriginError);
    }
  });

  it('allows a separately configured HTTPS resource origin', () => {
    expect(() => validateJmapSessionOrigins({
      ...session,
      downloadUrl: 'https://cdn.msc.test/download',
    }, server, ['https://cdn.msc.test'])).not.toThrow();
  });

  it('rejects insecure, credential-bearing and path-based resource origins', () => {
    expect(() => validateJmapSessionOrigins({
      ...session,
      uploadUrl: 'http://mail.msc.test/upload',
    }, server)).toThrow(JMAPSessionOriginError);
    expect(() => validateJmapSessionOrigins(session, server, ['https://user:pass@cdn.msc.test']))
      .toThrow(JMAPSessionOriginError);
    expect(() => validateJmapSessionOrigins(session, server, ['https://cdn.msc.test/private']))
      .toThrow(JMAPSessionOriginError);
  });
});
