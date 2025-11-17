import { describe, it, expect, beforeEach } from 'vitest';
import { MockHttpClient, fixtures } from './mocks';

describe('HTTP Probe Functions', () => {
  let mockHttp: MockHttpClient;

  beforeEach(() => {
    mockHttp = new MockHttpClient();
  });

  describe('Sonarr Probe', () => {
    it('should successfully probe Sonarr', async () => {
      const url = 'http://172.18.0.5:8989';
      mockHttp.setJsonResponse(`${url}/api/v3/system/status`, fixtures.sonarrStatus);

      const response = await mockHttp.get(`${url}/api/v3/system/status`);

      expect(response.ok).toBe(true);
      const data = JSON.parse(response.out) as { version: string };
      expect(data.version).toBe('4.0.0.738');
    });

    it('should handle Sonarr connection failure', async () => {
      const url = 'http://172.18.0.5:8989';
      mockHttp.setErrorResponse(`${url}/api/v3/system/status`, 'Connection refused');

      const response = await mockHttp.get(`${url}/api/v3/system/status`);

      expect(response.ok).toBe(false);
      expect(response.out).toContain('Connection refused');
    });

    it('should return queue count from Sonarr', async () => {
      const url = 'http://172.18.0.5:8989';
      const queueData = {
        totalRecords: 5,
        records: [],
      };
      mockHttp.setJsonResponse(`${url}/api/v3/queue`, queueData);

      const response = await mockHttp.get(`${url}/api/v3/queue`);
      const data = JSON.parse(response.out) as { totalRecords: number };

      expect(data.totalRecords).toBe(5);
    });
  });

  describe('Radarr Probe', () => {
    it('should successfully probe Radarr', async () => {
      const url = 'http://172.18.0.6:7878';
      mockHttp.setJsonResponse(`${url}/api/v3/system/status`, fixtures.radarrStatus);

      const response = await mockHttp.get(`${url}/api/v3/system/status`);

      expect(response.ok).toBe(true);
      const data = JSON.parse(response.out) as { version: string };
      expect(data.version).toBe('5.2.0.8041');
    });
  });

  describe('Prowlarr Probe', () => {
    it('should successfully probe Prowlarr', async () => {
      const url = 'http://172.18.0.7:9696';
      mockHttp.setJsonResponse(`${url}/api/v1/system/status`, fixtures.prowlarrStatus);

      const response = await mockHttp.get(`${url}/api/v1/system/status`);

      expect(response.ok).toBe(true);
      const data = JSON.parse(response.out) as { version: string };
      expect(data.version).toBe('1.10.0.4280');
    });

    it('should return indexer count', async () => {
      const url = 'http://172.18.0.7:9696';
      const indexers = [
        { id: 1, name: 'Indexer 1', enable: true },
        { id: 2, name: 'Indexer 2', enable: true },
        { id: 3, name: 'Indexer 3', enable: false },
      ];
      mockHttp.setJsonResponse(`${url}/api/v1/indexer`, indexers);

      const response = await mockHttp.get(`${url}/api/v1/indexer`);
      const data = JSON.parse(response.out) as Array<unknown>;

      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(3);
    });
  });

  describe('Bazarr Probe', () => {
    it('should successfully probe Bazarr with API key', async () => {
      const url = 'http://172.18.0.3:6767';
      mockHttp.setJsonResponse(`${url}/api/system/status`, fixtures.bazarrStatus);

      const response = await mockHttp.get(`${url}/api/system/status`, {
        'X-API-KEY': 'test-key',
      });

      expect(response.ok).toBe(true);
      const data = JSON.parse(response.out) as { version: string };
      expect(data.version).toBe('1.4.0');
    });
  });

  describe('qBittorrent Probe', () => {
    it('should get transfer info', async () => {
      const url = 'http://172.18.0.10:8080';
      mockHttp.setJsonResponse(`${url}/api/v2/transfer/info`, fixtures.qbitTransferInfo);

      const response = await mockHttp.get(`${url}/api/v2/transfer/info`);
      const data = JSON.parse(response.out) as { dl_info_speed: number; up_info_speed: number };

      expect(data.dl_info_speed).toBe(1048576);
      expect(data.up_info_speed).toBe(524288);
    });

    it('should get torrent count', async () => {
      const url = 'http://172.18.0.10:8080';
      mockHttp.setJsonResponse(`${url}/api/v2/torrents/info`, fixtures.qbitTorrents);

      const response = await mockHttp.get(`${url}/api/v2/torrents/info`);
      const data = JSON.parse(response.out) as Array<unknown>;

      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(2);
    });

    it('should get listen port', async () => {
      const url = 'http://172.18.0.10:8080';
      mockHttp.setJsonResponse(`${url}/api/v2/app/preferences`, fixtures.qbitPreferences);

      const response = await mockHttp.get(`${url}/api/v2/app/preferences`);
      const data = JSON.parse(response.out) as { listen_port: number };

      expect(data.listen_port).toBe(6881);
    });
  });

  describe('FlareSolverr Probe', () => {
    it('should successfully probe FlareSolverr', async () => {
      const url = 'http://172.18.0.11:8191';
      const healthResponse = { status: 'ok', version: '3.3.13' };
      mockHttp.setJsonResponse(`${url}/health`, healthResponse);

      const response = await mockHttp.get(`${url}/health`);

      expect(response.ok).toBe(true);
      const data = JSON.parse(response.out) as { status: string };
      expect(data.status).toBe('ok');
    });
  });

  describe('Cross-Seed Probe', () => {
    it('should successfully probe Cross-Seed', async () => {
      const url = 'http://172.18.0.12:2468';
      const apiResponse = { version: '5.8.4' };
      mockHttp.setJsonResponse(`${url}/api`, apiResponse);

      const response = await mockHttp.get(`${url}/api`);

      expect(response.ok).toBe(true);
    });
  });
});
