import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../docker', () => ({
  getContainerIP: vi.fn(),
}));

import { discoverServices } from '../services';
import { getContainerIP } from '../docker';

const mockedGetContainerIP = vi.mocked(getContainerIP);
const ORIGINAL_ENV = { ...process.env };

describe('service discovery', () => {
  beforeEach(() => {
    Object.keys(process.env).forEach(key => {
      if (!(key in ORIGINAL_ENV)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      }
    });
    Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
      process.env[key] = value;
    });
    mockedGetContainerIP.mockReset();
  });

  it('uses environment ports when provided', async () => {
    process.env['USE_VPN'] = 'false';
    process.env['SONARR_PORT'] = '9100';
    process.env['QBIT_WEBUI'] = '8112';

    mockedGetContainerIP.mockImplementation((name: string) => {
      if (name === 'sonarr') return Promise.resolve('172.18.0.5');
      if (name === 'qbittorrent') return Promise.resolve('172.18.0.8');
      return Promise.resolve(null);
    });

    const urls = await discoverServices();

    expect(urls['sonarr']).toBe('http://172.18.0.5:9100');
    expect(urls['qbittorrent']).toBe('http://172.18.0.8:8112');
  });

  it('switches to gluetun when VPN is enabled', async () => {
    process.env['USE_VPN'] = 'true';
    process.env['QBIT_WEBUI'] = '9000';

    mockedGetContainerIP.mockImplementation((name: string): Promise<string | null> => {
      if (name === 'gluetun') return Promise.resolve('172.18.0.20');
      return Promise.resolve(null);
    });

    const urls = await discoverServices();

    expect(urls).toHaveProperty('gluetun', 'http://172.18.0.20:9000');
    expect(urls).not.toHaveProperty('qbittorrent');
  });
});
