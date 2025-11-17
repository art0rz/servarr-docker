import { describe, it, expect } from 'vitest';
import type { CompactChartData, ChartDataPoint } from '../types';

/**
 * Decompress compact chart data format (duplicated from main.ts for testing)
 */
function decompressChartData(compact: CompactChartData): Array<ChartDataPoint> {
  const result: Array<ChartDataPoint> = [];
  for (let i = 0; i < compact.dataPoints; i++) {
    const responseTimes: Record<string, number> = {};
    for (const service of compact.services) {
      const quantized = compact.responseTimes[service]?.[i] ?? 0;
      responseTimes[service] = quantized * 10; // De-quantize from 10ms buckets
    }

    const memoryUsage: Record<string, number> = {};
    for (const container of compact.containers) {
      memoryUsage[container] = compact.memoryUsage[container]?.[i] ?? 0; // Memory in MB
    }

    result.push({
      timestamp: compact.timestamps[i] ?? Date.now(),
      downloadRate: compact.downloadRate[i] ?? 0,
      uploadRate: compact.uploadRate[i] ?? 0,
      load1: compact.load1[i] ?? 0,
      load5: 0, // Not sent in compact format
      load15: 0, // Not sent in compact format
      responseTimes,
      memoryUsage,
    });
  }
  return result;
}

describe('Chart Data Processing', () => {
  describe('decompressChartData', () => {
    it('should decompress compact chart data', () => {
      const compact: CompactChartData = {
        dataPoints: 3,
        services: ['Sonarr', 'Radarr'],
        containers: ['qbittorrent', 'sonarr'],
        timestamps: [1700000000000, 1700000001000, 1700000002000],
        downloadRate: [1048576, 2097152, 1572864], // 1MB, 2MB, 1.5MB
        uploadRate: [524288, 1048576, 786432],     // 0.5MB, 1MB, 0.75MB
        load1: [0.5, 0.75, 0.6],
        responseTimes: {
          'Sonarr': [10, 12, 11],   // 100ms, 120ms, 110ms (quantized to 10ms)
          'Radarr': [15, 14, 16],   // 150ms, 140ms, 160ms
        },
        memoryUsage: {
          'qbittorrent': [512, 520, 518],
          'sonarr': [256, 260, 258],
        },
      };

      const result = decompressChartData(compact);

      expect(result).toHaveLength(3);

      // First data point
      expect(result[0]?.timestamp).toBe(1700000000000);
      expect(result[0]?.downloadRate).toBe(1048576);
      expect(result[0]?.uploadRate).toBe(524288);
      expect(result[0]?.load1).toBe(0.5);
      expect(result[0]?.responseTimes['Sonarr']).toBe(100);
      expect(result[0]?.responseTimes['Radarr']).toBe(150);

      // Second data point
      expect(result[1]?.timestamp).toBe(1700000001000);
      expect(result[1]?.downloadRate).toBe(2097152);
      expect(result[1]?.uploadRate).toBe(1048576);
      expect(result[1]?.load1).toBe(0.75);
      expect(result[1]?.responseTimes['Sonarr']).toBe(120);
      expect(result[1]?.responseTimes['Radarr']).toBe(140);

      // Third data point
      expect(result[2]?.timestamp).toBe(1700000002000);
      expect(result[2]?.downloadRate).toBe(1572864);
      expect(result[2]?.uploadRate).toBe(786432);
      expect(result[2]?.load1).toBe(0.6);
      expect(result[2]?.responseTimes['Sonarr']).toBe(110);
      expect(result[2]?.responseTimes['Radarr']).toBe(160);
    });

    it('should handle empty chart data', () => {
      const compact: CompactChartData = {
        dataPoints: 0,
        services: [],
        containers: [],
        timestamps: [],
        downloadRate: [],
        uploadRate: [],
        load1: [],
        responseTimes: {},
        memoryUsage: {},
      };

      const result = decompressChartData(compact);

      expect(result).toHaveLength(0);
    });

    it('should handle missing response time data', () => {
      const compact: CompactChartData = {
        dataPoints: 2,
        services: ['Sonarr'],
        containers: [],
        timestamps: [1700000000000, 1700000001000],
        downloadRate: [1048576, 2097152],
        uploadRate: [524288, 1048576],
        load1: [0.5, 0.75],
        responseTimes: {
          'Sonarr': [10], // Only one value, second should default to 0
        },
        memoryUsage: {},
      };

      const result = decompressChartData(compact);

      expect(result).toHaveLength(2);
      expect(result[0]?.responseTimes['Sonarr']).toBe(100);
      expect(result[1]?.responseTimes['Sonarr']).toBe(0);
    });

    it('should use actual timestamps from server', () => {
      const compact: CompactChartData = {
        dataPoints: 3,
        services: [],
        containers: [],
        timestamps: [1700000000000, 1700000005000, 1700000010000], // Irregular 5-second intervals
        downloadRate: [0, 0, 0],
        uploadRate: [0, 0, 0],
        load1: [0, 0, 0],
        responseTimes: {},
        memoryUsage: {},
      };

      const result = decompressChartData(compact);

      expect(result[0]?.timestamp).toBe(1700000000000);
      expect(result[1]?.timestamp).toBe(1700000005000);
      expect(result[2]?.timestamp).toBe(1700000010000);
    });

    it('should preserve load1 precision', () => {
      const compact: CompactChartData = {
        dataPoints: 2,
        services: [],
        containers: [],
        timestamps: [1700000000000, 1700000001000],
        downloadRate: [0, 0],
        uploadRate: [0, 0],
        load1: [1.23, 4.56],
        responseTimes: {},
        memoryUsage: {},
      };

      const result = decompressChartData(compact);

      expect(result[0]?.load1).toBe(1.23);
      expect(result[1]?.load1).toBe(4.56);
    });
  });

  describe('Chart Data Validation', () => {
    it('should handle data with multiple services', () => {
      const compact: CompactChartData = {
        dataPoints: 1,
        services: ['Sonarr', 'Radarr', 'Prowlarr', 'Bazarr', 'qBittorrent'],
        containers: [],
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
      };

      const result = decompressChartData(compact);

      expect(result[0]?.responseTimes).toHaveProperty('Sonarr');
      expect(result[0]?.responseTimes).toHaveProperty('Radarr');
      expect(result[0]?.responseTimes).toHaveProperty('Prowlarr');
      expect(result[0]?.responseTimes).toHaveProperty('Bazarr');
      expect(result[0]?.responseTimes).toHaveProperty('qBittorrent');
      expect(Object.keys(result[0]?.responseTimes ?? {})).toHaveLength(5);
    });
  });
});
