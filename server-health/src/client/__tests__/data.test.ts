import { describe, it, expect } from 'vitest';
import type { CompactChartData, ChartDataPoint, TimeResolution } from '../types';

const RESOLUTIONS: Array<TimeResolution> = ['1h', '1d', '1w', '1m'];

interface ChartBucket {
  point: ChartDataPoint;
  samples: number;
}

function createEmptyStore(): Record<TimeResolution, Array<ChartBucket>> {
  return {
    '1h': [],
    '1d': [],
    '1w': [],
    '1m': [],
  };
}

/**
 * Decompress compact chart data format (duplicated from main.ts for testing)
 */
function decompressChartData(compact: CompactChartData): Record<TimeResolution, Array<ChartBucket>> {
  const store = createEmptyStore();
  for (const resolution of RESOLUTIONS) {
    const series = compact.series[resolution];
    if (series === undefined || series.dataPoints === 0) continue;
    const buckets: Array<ChartBucket> = [];

    for (let i = 0; i < series.dataPoints; i++) {
      const responseTimes: Record<string, number> = {};
      for (const service of compact.services) {
        const quantized = series.responseTimes[service]?.[i] ?? 0;
        responseTimes[service] = quantized * 10;
      }

      const memoryUsage: Record<string, number> = {};
      for (const container of compact.containers) {
        memoryUsage[container] = series.memoryUsage[container]?.[i] ?? 0;
      }

      const torrentRates: Record<string, { name: string; downloadRate: number; uploadRate: number }> = {};
      for (const torrent of compact.torrents) {
        const downloadSeries = series.torrentDownload[torrent.id] ?? [];
        const uploadSeries = series.torrentUpload[torrent.id] ?? [];
        torrentRates[torrent.id] = {
          name: torrent.name,
          downloadRate: downloadSeries[i] ?? 0,
          uploadRate: uploadSeries[i] ?? 0,
        };
      }

      buckets.push({
        point: {
          timestamp: series.timestamps[i] ?? Date.now(),
          downloadRate: series.downloadRate[i] ?? 0,
          uploadRate: series.uploadRate[i] ?? 0,
          load1: series.load1[i] ?? 0,
          load5: 0,
          load15: 0,
          responseTimes,
          memoryUsage,
          torrentRates,
        },
        samples: series.samples[i] ?? 1,
      });
    }

    store[resolution] = buckets;
  }

  return store;
}

function extractPoints(store: Record<TimeResolution, Array<ChartBucket>>, resolution: TimeResolution = '1h') {
  return store[resolution].map(bucket => bucket.point);
}

describe('Chart Data Processing', () => {
  describe('decompressChartData', () => {
    it('should decompress compact chart data', () => {
      const compact: CompactChartData = {
        retentionMs: 3600000,
        services: ['Sonarr', 'Radarr'],
        containers: ['qbittorrent', 'sonarr'],
        torrents: [{ id: 'hash1', name: 'Torrent One' }],
        series: {
          '1h': {
            dataPoints: 3,
            timestamps: [1700000000000, 1700000001000, 1700000002000],
            downloadRate: [1048576, 2097152, 1572864],
            uploadRate: [524288, 1048576, 786432],
            load1: [0.5, 0.75, 0.6],
            responseTimes: {
              'Sonarr': [10, 12, 11],
              'Radarr': [15, 14, 16],
            },
            memoryUsage: {
              'qbittorrent': [512, 520, 518],
              'sonarr': [256, 260, 258],
            },
            torrentDownload: {
              'hash1': [1024, 2048, 0],
            },
            torrentUpload: {
              'hash1': [256, 128, 0],
            },
            samples: [1, 1, 1],
          },
        },
      };

      const store = decompressChartData(compact);
      const result = extractPoints(store, '1h');

      expect(result).toHaveLength(3);
      expect(result[0]?.timestamp).toBe(1700000000000);
      expect(result[0]?.downloadRate).toBe(1048576);
      expect(result[0]?.uploadRate).toBe(524288);
      expect(result[0]?.load1).toBe(0.5);
      expect(result[0]?.responseTimes['Sonarr']).toBe(100);
      expect(result[0]?.responseTimes['Radarr']).toBe(150);

      expect(result[1]?.timestamp).toBe(1700000001000);
      expect(result[1]?.downloadRate).toBe(2097152);
      expect(result[1]?.uploadRate).toBe(1048576);
      expect(result[1]?.load1).toBe(0.75);
      expect(result[1]?.responseTimes['Sonarr']).toBe(120);
      expect(result[1]?.responseTimes['Radarr']).toBe(140);

      expect(result[2]?.timestamp).toBe(1700000002000);
      expect(result[2]?.downloadRate).toBe(1572864);
      expect(result[2]?.uploadRate).toBe(786432);
      expect(result[2]?.load1).toBe(0.6);
      expect(result[2]?.responseTimes['Sonarr']).toBe(110);
      expect(result[2]?.responseTimes['Radarr']).toBe(160);
    });

    it('should handle empty chart data', () => {
      const compact: CompactChartData = {
        retentionMs: 3600000,
        services: [],
        containers: [],
        torrents: [],
        series: {
          '1h': {
            dataPoints: 0,
            timestamps: [],
            downloadRate: [],
            uploadRate: [],
            load1: [],
            responseTimes: {},
            memoryUsage: {},
            torrentDownload: {},
            torrentUpload: {},
            samples: [],
          },
        },
      };

      const store = decompressChartData(compact);
      const result = extractPoints(store, '1h');

      expect(result).toHaveLength(0);
    });

    it('should handle missing response time data', () => {
      const compact: CompactChartData = {
        retentionMs: 3600000,
        services: ['Sonarr'],
        containers: [],
        torrents: [],
        series: {
          '1h': {
            dataPoints: 2,
            timestamps: [1700000000000, 1700000001000],
            downloadRate: [1048576, 2097152],
            uploadRate: [524288, 1048576],
            load1: [0.5, 0.75],
            responseTimes: {
              'Sonarr': [10],
            },
            memoryUsage: {},
            torrentDownload: {},
            torrentUpload: {},
            samples: [1, 1],
          },
        },
      };

      const store = decompressChartData(compact);
      const result = extractPoints(store, '1h');

      expect(result).toHaveLength(2);
      expect(result[0]?.responseTimes['Sonarr']).toBe(100);
      expect(result[1]?.responseTimes['Sonarr']).toBe(0);
    });

    it('should use actual timestamps from server', () => {
      const compact: CompactChartData = {
        retentionMs: 3600000,
        services: [],
        containers: [],
        torrents: [],
        series: {
          '1h': {
            dataPoints: 3,
            timestamps: [1700000000000, 1700000005000, 1700000010000],
            downloadRate: [0, 0, 0],
            uploadRate: [0, 0, 0],
            load1: [0, 0, 0],
            responseTimes: {},
            memoryUsage: {},
            torrentDownload: {},
            torrentUpload: {},
            samples: [1, 1, 1],
          },
        },
      };

      const store = decompressChartData(compact);
      const result = extractPoints(store, '1h');

      expect(result[0]?.timestamp).toBe(1700000000000);
      expect(result[1]?.timestamp).toBe(1700000005000);
      expect(result[2]?.timestamp).toBe(1700000010000);
    });

    it('should preserve load1 precision', () => {
      const compact: CompactChartData = {
        retentionMs: 3600000,
        services: [],
        containers: [],
        torrents: [],
        series: {
          '1h': {
            dataPoints: 2,
            timestamps: [1700000000000, 1700000001000],
            downloadRate: [0, 0],
            uploadRate: [0, 0],
            load1: [1.23, 4.56],
            responseTimes: {},
            memoryUsage: {},
            torrentDownload: {},
            torrentUpload: {},
            samples: [1, 1],
          },
        },
      };

      const store = decompressChartData(compact);
      const result = extractPoints(store, '1h');

      expect(result[0]?.load1).toBe(1.23);
      expect(result[1]?.load1).toBe(4.56);
    });
  });

  describe('Chart Data Validation', () => {
    it('should handle data with multiple services', () => {
      const compact: CompactChartData = {
        retentionMs: 3600000,
        services: ['Sonarr', 'Radarr', 'Prowlarr', 'Bazarr', 'qBittorrent'],
        containers: [],
        torrents: [],
        series: {
          '1h': {
            dataPoints: 1,
            timestamps: [1700000000000],
            downloadRate: [0],
            uploadRate: [0],
            load1: [0],
            responseTimes: {
              'Sonarr': [10],
              'Radarr': [12],
              'Prowlarr': [8],
              'Bazarr': [15],
              'qBittorrent': [5],
            },
            memoryUsage: {},
            torrentDownload: {},
            torrentUpload: {},
            samples: [1],
          },
        },
      };

      const store = decompressChartData(compact);
      const result = extractPoints(store, '1h');

      expect(result[0]?.responseTimes).toHaveProperty('Sonarr');
      expect(result[0]?.responseTimes).toHaveProperty('Radarr');
      expect(result[0]?.responseTimes).toHaveProperty('Prowlarr');
      expect(result[0]?.responseTimes).toHaveProperty('Bazarr');
      expect(result[0]?.responseTimes).toHaveProperty('qBittorrent');
      expect(Object.keys(result[0]?.responseTimes ?? {})).toHaveLength(5);
    });
  });
});
