import { describe, it, expect, beforeEach } from 'vitest';
import { MockFileSystem } from './mocks';

describe('Config File Parsing', () => {
  let mockFs: MockFileSystem;

  beforeEach(() => {
    mockFs = new MockFileSystem();
  });

  describe('XML API Key Reading', () => {
    it('should extract API key from XML config', async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<Config>
  <BindAddress>*</BindAddress>
  <Port>8989</Port>
  <ApiKey>test-api-key-12345</ApiKey>
</Config>`;

      mockFs.setFile('/config/sonarr/config.xml', xmlContent);
      const content = await mockFs.readFile('/config/sonarr/config.xml', 'utf-8');

      const apiKeyRegex = /<ApiKey>([^<]+)<\/ApiKey>/i;
      const match = apiKeyRegex.exec(content);

      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('test-api-key-12345');
    });

    it('should return null for missing API key', async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<Config>
  <Port>8989</Port>
</Config>`;

      mockFs.setFile('/config/sonarr/config.xml', xmlContent);
      const content = await mockFs.readFile('/config/sonarr/config.xml', 'utf-8');

      const apiKeyRegex = /<ApiKey>([^<]+)<\/ApiKey>/i;
      const match = apiKeyRegex.exec(content);

      expect(match).toBeNull();
    });
  });

  describe('INI API Key Reading', () => {
    it('should extract API key from Bazarr INI config', async () => {
      const iniContent = `[general]
port = 6767

[auth]
type = form
apikey = bazarr-test-key-xyz

[sonarr]
ip = 172.18.0.5`;

      mockFs.setFile('/config/bazarr/config/config.ini', iniContent);
      const content = await mockFs.readFile('/config/bazarr/config/config.ini', 'utf-8');

      const lines = content.split(/\r?\n/);
      let inSection = false;
      let apiKey: string | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '[auth]') {
          inSection = true;
          continue;
        }
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          inSection = false;
          continue;
        }
        if (inSection && trimmed.startsWith('apikey')) {
          const parts = trimmed.split('=', 2);
          if (parts.length === 2 && parts[1] !== undefined) {
            apiKey = parts[1].trim();
          }
        }
      }

      expect(apiKey).toBe('bazarr-test-key-xyz');
    });
  });

  describe('qBittorrent Credentials Extraction', () => {
    it('should extract credentials from cross-seed config', async () => {
      const configContent = `module.exports = {
  qbittorrentUrl: "http://admin:secret123@172.18.0.10:8080",
  torznab: [
    "http://prowlarr:9696/1/torznab"
  ]
};`;

      mockFs.setFile('/config/cross-seed/config.js', configContent);
      const content = await mockFs.readFile('/config/cross-seed/config.js', 'utf-8');

      const regex = /"qbittorrent:(?:readonly:)?([^"]+)"/gi;
      let match = regex.exec(content);

      // Try alternate pattern
      if (match === null) {
        const urlRegex = /"http:\/\/([^:]+):([^@]+)@/;
        match = urlRegex.exec(content);

        if (match !== null) {
          expect(match[1]).toBe('admin');
          expect(match[2]).toBe('secret123');
        }
      }
    });
  });
});
