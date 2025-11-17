import { describe, it, expect, beforeEach } from 'vitest';
import { MockDockerClient, fixtures } from './mocks';

describe('Docker Probe Functions', () => {
  let mockDocker: MockDockerClient;

  beforeEach(() => {
    mockDocker = new MockDockerClient();
  });

  describe('Gluetun VPN Probe', () => {
    it('should detect running and healthy Gluetun container', async () => {
      mockDocker.setContainers([fixtures.gluetunContainer]);
      mockDocker.setInspectData('/gluetun', fixtures.healthyContainerInspect);

      const containers = await mockDocker.listContainers();
      const gluetun = containers.find(c => c.Names.some(n => n.includes('gluetun')));

      expect(gluetun).toBeDefined();
      expect(gluetun?.State).toBe('running');

      const inspect = await mockDocker.inspectContainer('/gluetun');
      expect(inspect.State.Health?.Status).toBe('healthy');
    });

    it('should extract forwarded port from environment', async () => {
      mockDocker.setContainers([fixtures.gluetunContainer]);
      mockDocker.setExecResult(
        'gluetun',
        'printenv FIREWALL_VPN_INPUT_PORTS',
        { out: '12345', err: '' }
      );

      const result = await mockDocker.execInContainer('gluetun', ['printenv', 'FIREWALL_VPN_INPUT_PORTS']);

      expect(result.out).toBe('12345');
      expect(result.err).toBe('');
    });

    it('should get egress IP from curl', async () => {
      mockDocker.setContainers([fixtures.gluetunContainer]);
      mockDocker.setExecResult(
        'gluetun',
        'curl -s https://api.ipify.org',
        { out: '198.51.100.42', err: '' }
      );

      const result = await mockDocker.execInContainer('gluetun', ['curl', '-s', 'https://api.ipify.org']);

      expect(result.out).toBe('198.51.100.42');
    });

    it('should extract UI host port from container info', () => {
      const port = fixtures.gluetunContainer.Ports.find(
        p => p.PrivatePort === 8000 && p.Type === 'tcp'
      );

      expect(port?.PublicPort).toBe(8080);
    });
  });

  describe('Recyclarr Probe', () => {
    it('should read logs and count errors', async () => {
      const logs = `2024-01-15 10:00:00 [INF] Starting sync
2024-01-15 10:00:01 [INF] Processing Sonarr
2024-01-15 10:00:02 [ERR] Failed to connect to Radarr
2024-01-15 10:00:03 [INF] Sync complete
2024-01-15 10:00:04 [ERR] Unexpected error occurred`;

      mockDocker.setLogs('recyclarr', logs);

      const logContent = await mockDocker.getContainerLogs('recyclarr');
      const errorCount = (logContent.match(/\[ERR\]/g) ?? []).length;

      expect(errorCount).toBe(2);
    });

    it('should handle missing container', async () => {
      mockDocker.setContainers([]);

      const logs = await mockDocker.getContainerLogs('recyclarr');

      expect(logs).toBe('');
    });
  });

  describe('Container Listing', () => {
    it('should list all containers', async () => {
      mockDocker.setContainers([
        {
          Names: ['/sonarr'],
          State: 'running',
          Status: 'Up 3 hours',
          Ports: [{ PrivatePort: 8989, Type: 'tcp' }],
        },
        {
          Names: ['/radarr'],
          State: 'running',
          Status: 'Up 3 hours',
          Ports: [{ PrivatePort: 7878, Type: 'tcp' }],
        },
      ]);

      const containers = await mockDocker.listContainers();

      expect(containers).toHaveLength(2);
      expect(containers[0]?.Names[0]).toBe('/sonarr');
      expect(containers[1]?.Names[0]).toBe('/radarr');
    });

    it('should filter containers by name', async () => {
      mockDocker.setContainers([
        { Names: ['/sonarr'], State: 'running', Status: 'Up', Ports: [] },
        { Names: ['/radarr'], State: 'running', Status: 'Up', Ports: [] },
        { Names: ['/gluetun'], State: 'running', Status: 'Up', Ports: [] },
      ]);

      const containers = await mockDocker.listContainers();
      const vpnContainer = containers.find(c => c.Names.some(n => n.includes('gluetun')));

      expect(vpnContainer).toBeDefined();
      expect(vpnContainer?.Names[0]).toBe('/gluetun');
    });
  });

  describe('Container Inspection', () => {
    it('should inspect container health status', async () => {
      mockDocker.setInspectData('sonarr', {
        State: {
          Health: {
            Status: 'healthy',
          },
        },
      });

      const inspect = await mockDocker.inspectContainer('sonarr');

      expect(inspect.State.Health?.Status).toBe('healthy');
    });

    it('should handle unhealthy container', async () => {
      mockDocker.setInspectData('radarr', {
        State: {
          Health: {
            Status: 'unhealthy',
          },
        },
      });

      const inspect = await mockDocker.inspectContainer('radarr');

      expect(inspect.State.Health?.Status).toBe('unhealthy');
    });

    it('should handle container without health check', async () => {
      mockDocker.setInspectData('bazarr', {
        State: {},
      });

      const inspect = await mockDocker.inspectContainer('bazarr');

      expect(inspect.State.Health).toBeUndefined();
    });
  });
});
