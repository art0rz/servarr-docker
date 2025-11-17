import { describe, it, expect } from 'vitest';
import { renderSummary, renderServiceCard, renderCheckCard, renderVpnCard } from '../components';
import type { HealthData, ServiceProbeResult, CheckResult, GluetunProbeResult, QbitEgressProbeResult, QbitIngressInfo } from '../types';

describe('Component Rendering', () => {
  describe('renderSummary', () => {
    it('should render passing checks summary', () => {
      const data: HealthData = {
        vpn: { name: 'VPN', ok: false, running: false, healthy: null },
        qbitEgress: { name: 'qBittorrent egress', container: 'qbittorrent', ok: true, vpnEgress: '' },
        services: [],
        checks: [
          { name: 'Check 1', ok: true, detail: '' },
          { name: 'Check 2', ok: true, detail: '' },
          { name: 'Check 3', ok: false, detail: '' },
        ],
        nets: [],
        updatedAt: null,
        updating: false,
        error: null,
        gitRef: '',
      };

      const html = renderSummary(data);

      expect(html).toContain('2 / 3');
      expect(html).toContain('badge');
    });

    it('should handle all checks passing', () => {
      const data: HealthData = {
        vpn: { name: 'VPN', ok: false, running: false, healthy: null },
        qbitEgress: { name: 'qBittorrent egress', container: 'qbittorrent', ok: true, vpnEgress: '' },
        services: [],
        checks: [
          { name: 'Check 1', ok: true, detail: '' },
          { name: 'Check 2', ok: true, detail: '' },
        ],
        nets: [],
        updatedAt: null,
        updating: false,
        error: null,
        gitRef: '',
      };

      const html = renderSummary(data);

      expect(html).toContain('2 / 2');
    });
  });

  describe('renderServiceCard', () => {
    it('should render healthy service', () => {
      const service: ServiceProbeResult = {
        name: 'Sonarr',
        url: 'http://172.18.0.5:8989',
        ok: true,
        version: '4.0.0.738',
        queue: 3,
      };

      const html = renderServiceCard(service);

      expect(html).toContain('Sonarr');
      expect(html).toContain('v4.0.0.738');
      expect(html).toContain('Queue: 3');
      expect(html).toContain('status ok');
      expect(html).toContain('OK');
    });

    it('should render failed service', () => {
      const service: ServiceProbeResult = {
        name: 'Radarr',
        url: 'http://172.18.0.6:7878',
        ok: false,
        reason: 'Connection refused',
      };

      const html = renderServiceCard(service);

      expect(html).toContain('Radarr');
      expect(html).toContain('status fail');
      expect(html).toContain('FAIL');
      expect(html).toContain('Connection refused');
      expect(html).toContain('border-color: #f85149');
    });

    it('should render qBittorrent with transfer rates', () => {
      const service: ServiceProbeResult = {
        name: 'qBittorrent',
        url: 'http://172.18.0.10:8080',
        ok: true,
        version: '4.6.0',
        dl: 1048576, // 1 MB/s
        up: 524288,  // 0.5 MB/s
        total: 42,
      };

      const html = renderServiceCard(service);

      expect(html).toContain('qBittorrent');
      expect(html).toContain('DL: 1.00 MB/s');
      expect(html).toContain('UP: 0.50 MB/s');
      expect(html).toContain('Torrents: 42');
    });

    it('should handle service with zero download rate', () => {
      const service: ServiceProbeResult = {
        name: 'qBittorrent',
        ok: true,
        dl: 0,
        up: 0,
      };

      const html = renderServiceCard(service);

      expect(html).toContain('DL: 0');
      expect(html).toContain('UP: 0');
    });

    it('should render Prowlarr with indexers', () => {
      const service: ServiceProbeResult = {
        name: 'Prowlarr',
        ok: true,
        version: '1.10.0',
        indexers: 15,
      };

      const html = renderServiceCard(service);

      expect(html).toContain('Prowlarr');
      expect(html).toContain('Indexers: 15');
    });

    it('should include integration check tags when provided', () => {
      const service: ServiceProbeResult = {
        name: 'Sonarr',
        ok: true,
      };
      const checks: Array<CheckResult> = [
        { name: 'Sonarr download clients', ok: true, detail: 'enabled: qBittorrent' },
        { name: 'Custom check', ok: false, detail: 'needs auth' },
      ];

      const html = renderServiceCard(service, checks);

      expect(html).toContain('download clients');
      expect(html).toContain('enabled: qBittorrent');
      expect(html).toContain('Custom check');
      expect(html).toContain('needs auth');
    });

    it('should escape HTML in service details', () => {
      const service: ServiceProbeResult = {
        name: 'Test<script>alert("xss")</script>',
        ok: false,
        reason: '<img src=x onerror=alert(1)>',
      };

      const html = renderServiceCard(service);

      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;');
      expect(html).toContain('&gt;');
    });
  });

  describe('renderCheckCard', () => {
    it('should render passing check', () => {
      const check: CheckResult = {
        name: 'VPN Status',
        ok: true,
        detail: 'Connected to NL-Amsterdam',
      };

      const html = renderCheckCard(check);

      expect(html).toContain('VPN Status');
      expect(html).toContain('status ok');
      expect(html).toContain('OK');
      expect(html).toContain('NL-Amsterdam');
    });

    it('should render failing check', () => {
      const check: CheckResult = {
        name: 'Disk Space',
        ok: false,
        detail: 'Only 5% remaining',
      };

      const html = renderCheckCard(check);

      expect(html).toContain('Disk Space');
      expect(html).toContain('status fail');
      expect(html).toContain('FAIL');
      expect(html).toContain('Only 5% remaining');
    });

    it('should handle empty detail', () => {
      const check: CheckResult = {
        name: 'Simple Check',
        ok: true,
        detail: '',
      };

      const html = renderCheckCard(check);

      expect(html).toContain('Simple Check');
      expect(html).toContain('OK');
    });
  });

  describe('renderVpnCard', () => {
    it('should render VPN and qBit egress info', () => {
      const vpn: GluetunProbeResult = {
        name: 'VPN',
        container: 'gluetun',
        ok: true,
        running: true,
        healthy: 'healthy',
        vpnEgress: '198.51.100.42',
        forwardedPort: '12345',
        pfExpected: true,
      };

      const qbitEgress: QbitEgressProbeResult = {
        name: 'qBittorrent egress',
        container: 'qbittorrent',
        ok: true,
        vpnEgress: '198.51.100.42',
      };

      const ingress: QbitIngressInfo = { hostPort: '12345', listenPort: 8080 };
      const html = renderVpnCard(vpn, qbitEgress, ingress);

      expect(html).toContain('HEALTHY');
      expect(html).toContain('Running: Yes');
      expect(html).toContain('198.51.100.42');
      expect(html).toContain('Host Port: 12345');
      expect(html).toContain('qBittorrent Port: 8080');
    });

    it('should handle VPN not running', () => {
      const vpn: GluetunProbeResult = {
        name: 'VPN',
        container: 'gluetun',
        ok: false,
        running: false,
        healthy: null,
        vpnEgress: '',
        forwardedPort: '',
        pfExpected: false,
      };

      const qbitEgress: QbitEgressProbeResult = {
        name: 'qBittorrent egress',
        container: 'qbittorrent',
        ok: false,
        vpnEgress: '',
      };

      const html = renderVpnCard(vpn, qbitEgress, null);

      expect(html).toContain('Running: No');
      expect(html).toContain('status fail');
    });
  });
});
