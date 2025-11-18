import { describe, it, expect } from 'vitest';
import { aggregateData, selectRateScale, prepareChartSeries, RESOLUTION_TIME_RANGES, DEFAULT_RATE_SCALE } from '../chart-data';
import type { ChartDataPoint, TimeResolution } from '../types';

function buildPoint(timestamp: number, overrides: Partial<ChartDataPoint> = {}): ChartDataPoint {
  return {
    timestamp,
    downloadRate: 0,
    uploadRate: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    responseTimes: {},
    memoryUsage: {},
    torrentRates: {},
    ...overrides,
  };
}

describe('chart-data utilities', () => {
  describe('selectRateScale', () => {
    it('falls back to default scale for invalid values', () => {
      expect(selectRateScale(NaN)).toEqual(DEFAULT_RATE_SCALE);
      expect(selectRateScale(-1)).toEqual(DEFAULT_RATE_SCALE);
    });

    it('selects the largest readable unit', () => {
      expect(selectRateScale(500).unit).toBe('B/s');
      expect(selectRateScale(1024 * 1024 * 5).unit).toBe('MB/s');
      expect(selectRateScale(1024 * 1024 * 1024 * 2).unit).toBe('GB/s');
    });
  });

  describe('aggregateData', () => {
    it('aggregates points into resolution buckets', () => {
      const now = 1_700_000_000_000;
      const points: Array<ChartDataPoint> = [
        buildPoint(now - 30_000, {
          downloadRate: 2000,
          uploadRate: 500,
          load1: 1,
          responseTimes: { Sonarr: 100 },
          memoryUsage: { qbittorrent: 500 },
        }),
        buildPoint(now - 20_000, {
          downloadRate: 4000,
          uploadRate: 1500,
          load1: 2,
          responseTimes: { Sonarr: 200 },
          memoryUsage: { qbittorrent: 600 },
        }),
        buildPoint(now - 120_000, {
          downloadRate: 1000,
          uploadRate: 1000,
          load1: 0.5,
          responseTimes: { Radarr: 50 },
          memoryUsage: { radarr: 256 },
        }),
      ];

      const aggregated = aggregateData(points, '1d', now);
      expect(aggregated).toHaveLength(2);
      const latest = aggregated[aggregated.length - 1];
      expect(latest?.downloadRate).toBeCloseTo(3000);
      expect(latest?.uploadRate).toBeCloseTo(1000);
      expect(latest?.load1).toBeCloseTo(1.5);
      expect(latest?.responseTimes['Sonarr']).toBe(150);
      expect(latest?.memoryUsage['qbittorrent']).toBe(550);

      const older = aggregated[0];
      expect(older?.responseTimes['Radarr']).toBe(50);
      expect(older?.memoryUsage['radarr']).toBe(256);
    });

    it('averages 1h resolution data into 1-minute buckets', () => {
      const now = 3_600_000;
      const points: Array<ChartDataPoint> = [
        buildPoint(now - 10_000, { downloadRate: 4000 }),
        buildPoint(now - 20_000, { downloadRate: 2000 }),
        buildPoint(now - 90_000, { downloadRate: 1000 }),
      ];

      const aggregated = aggregateData(points, '1h', now);
      expect(aggregated).toHaveLength(2);
      const latest = aggregated[aggregated.length - 1];
      expect(latest?.downloadRate).toBeCloseTo(3000);
      const older = aggregated[0];
      expect(older?.downloadRate).toBeCloseTo(1000);
    });
  });

  describe('prepareChartSeries', () => {
    function makePoints(resolution: TimeResolution, now: number): Array<ChartDataPoint> {
      const [firstOffset, secondOffset] = resolution === '1h'
        ? ([70_000, 5_000] as const)
        : ([10_000, 5_000] as const);
      return [
        buildPoint(now - firstOffset, {
          downloadRate: 1024 * 1024 * 3,
          uploadRate: 1024 * 512,
          load1: 1.2,
          responseTimes: { Sonarr: 120 },
          memoryUsage: { qbittorrent: 512 },
          torrentRates: {
            'hash1': { name: 'Torrent Alpha', downloadRate: 1024 * 1024 * 2, uploadRate: 1024 * 128 },
          },
        }),
        buildPoint(now - secondOffset, {
          downloadRate: 1024 * 1024 * 5,
          uploadRate: 1024 * 256,
          load1: 0.9,
          responseTimes: { Radarr: 80 },
          memoryUsage: { radarr: 256 },
          torrentRates: {
            'hash1': { name: 'Torrent Alpha', downloadRate: 1024 * 1024 * 3, uploadRate: 1024 * 64 },
            'hash2': { name: 'Torrent Beta', downloadRate: 1024 * 512, uploadRate: 1024 * 32 },
          },
        }),
      ];
    }

    it('prepares XY data for Chart.js', () => {
      const now = 1_700_000_000_000;
      const prepared = prepareChartSeries(makePoints('1h', now), '1h', now);

      expect(prepared.download).toHaveLength(2);
      // Values scaled to MB/s
      expect(prepared.download[0]?.y).toBeCloseTo(3);
      expect(prepared.upload[1]?.y).toBeCloseTo(0.25);
      expect(prepared.load[0]?.y).toBeCloseTo(1.2);

      expect(prepared.services).toEqual(expect.arrayContaining(['Sonarr', 'Radarr']));
      expect(prepared.responseTimes['Sonarr']).toHaveLength(2);
      expect(prepared.memoryUsage['qbittorrent']?.[0]?.y).toBe(512);
      expect(prepared.torrents).toEqual(expect.arrayContaining([{ id: 'hash1', name: 'Torrent Alpha' }]));
      expect(prepared.torrentDownloads['hash1']?.length).toBe(2);
      expect(prepared.torrentUploads['hash2']?.[1]?.y).toBeGreaterThan(0);

      expect(prepared.xBounds.min).toBe(now - RESOLUTION_TIME_RANGES['1h']);
      expect(prepared.xBounds.max).toBe(now);
    });
  });
});
