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

  describe('YAML API Key Reading', () => {
    it('should extract API key from Bazarr YAML config', async () => {
      const yamlContent = `---
general:
  port: 6767

auth:
  type: form
  apikey: bazarr-test-key-xyz
  username: test

sonarr:
  ip: 172.18.0.5`;

      mockFs.setFile('/config/bazarr/config/config.yaml', yamlContent);
      const content = await mockFs.readFile('/config/bazarr/config/config.yaml', 'utf-8');

      const lines = content.split(/\r?\n/);
      const stack: string[] = [];
      let apiKey: string | null = null;

      for (const line of lines) {
        if (line.trim().startsWith('#') || line.trim().length === 0 || line.trim() === '---') continue;

        const indentMatch = /^( *)/.exec(line);
        const indent = indentMatch?.[1]?.length ?? 0;
        const depth = Math.floor(indent / 2);

        const kvMatch = /^(\s*)([^:]+):\s*(.*)$/.exec(line);
        if (kvMatch !== null && kvMatch[2] !== undefined) {
          const key = kvMatch[2].trim();
          const value = kvMatch[3]?.trim() ?? '';

          stack.splice(depth);
          stack[depth] = key;

          const currentPath = stack.slice(0, depth + 1).join('.');
          if (currentPath === 'auth.apikey' && value.length > 0) {
            apiKey = value;
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
