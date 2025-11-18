import type { ChartDataPoint, TimeResolution } from './types';

export const RATE_UNITS = [
  { unit: 'B/s', divisor: 1 },
  { unit: 'KB/s', divisor: 1024 },
  { unit: 'MB/s', divisor: 1024 * 1024 },
  { unit: 'GB/s', divisor: 1024 * 1024 * 1024 },
  { unit: 'TB/s', divisor: 1024 * 1024 * 1024 * 1024 },
] as const;

export type RateScale = typeof RATE_UNITS[number];
export const DEFAULT_RATE_SCALE: RateScale = RATE_UNITS[2];

export const RESOLUTION_TIME_RANGES: Record<TimeResolution, number> = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
};

const RESOLUTION_BUCKET_MS: Record<TimeResolution, number> = {
  '1h': 60 * 1000,
  '1d': 60 * 1000,
  '1w': 5 * 60 * 1000,
  '1m': 30 * 60 * 1000,
};

export interface XYPoint {
  x: number;
  y: number;
}

export interface PreparedChartSeries {
  download: Array<XYPoint>;
  upload: Array<XYPoint>;
  load: Array<XYPoint>;
  responseTimes: Record<string, Array<XYPoint>>;
  memoryUsage: Record<string, Array<XYPoint>>;
  torrentDownloads: Record<string, Array<XYPoint>>;
  torrentUploads: Record<string, Array<XYPoint>>;
  services: Array<string>;
  containers: Array<string>;
  torrents: Array<{ id: string; name: string }>;
  rateScale: RateScale;
  xBounds: { min: number; max: number };
}

export function selectRateScale(maxBytes: number): RateScale {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return DEFAULT_RATE_SCALE;
  }
  for (let i = RATE_UNITS.length - 1; i >= 0; i--) {
    const candidate = RATE_UNITS[i];
    if (candidate === undefined) continue;
    if (maxBytes >= candidate.divisor || i === 0) {
      return candidate;
    }
  }
  return DEFAULT_RATE_SCALE;
}

export function formatScaledRate(value: number): string {
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(precision);
}

export function aggregateData(
  data: Array<ChartDataPoint>,
  resolution: TimeResolution,
  now: number = Date.now()
): Array<ChartDataPoint> {
  if (data.length === 0) return [];

  const timeRange = RESOLUTION_TIME_RANGES[resolution];
  const startTime = now - timeRange;

  if (RESOLUTION_BUCKET_MS[resolution] === 0) {
    return data.filter(point => point.timestamp >= startTime).sort((a, b) => a.timestamp - b.timestamp);
  }

  const bucketSizeMs = RESOLUTION_BUCKET_MS[resolution];
  const buckets = new Map<number, Array<ChartDataPoint>>();

  for (const point of data) {
    if (point.timestamp < startTime) continue;
    const bucketIndex = Math.floor((point.timestamp - startTime) / bucketSizeMs);
    const bucketTimestamp = startTime + bucketIndex * bucketSizeMs;
    const existing = buckets.get(bucketTimestamp);
    if (existing !== undefined) {
      existing.push(point);
    } else {
      buckets.set(bucketTimestamp, [point]);
    }
  }

  const aggregated: Array<ChartDataPoint> = [];
  const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);

  for (const [bucketTimestamp, points] of sortedBuckets) {
    if (points.length === 0) continue;

    const avgResponseTimes: Record<string, number> = {};
    const responseServices = new Set<string>();
    for (const point of points) {
      for (const service of Object.keys(point.responseTimes)) {
        responseServices.add(service);
      }
    }
    for (const service of responseServices) {
      const serviceTimes = points
        .map(p => p.responseTimes[service] ?? 0)
        .filter(t => t > 0);
      avgResponseTimes[service] =
        serviceTimes.length > 0 ? serviceTimes.reduce((sum, t) => sum + t, 0) / serviceTimes.length : 0;
    }

    const avgMemoryUsage: Record<string, number> = {};
    const memoryContainers = new Set<string>();
    for (const point of points) {
      for (const container of Object.keys(point.memoryUsage)) {
        memoryContainers.add(container);
      }
    }
    for (const container of memoryContainers) {
      const memoryValues = points
        .map(p => p.memoryUsage[container] ?? 0)
        .filter(m => m > 0);
      avgMemoryUsage[container] =
        memoryValues.length > 0 ? memoryValues.reduce((sum, m) => sum + m, 0) / memoryValues.length : 0;
    }

    const avgTorrentRates: Record<string, { name: string; downloadRate: number; uploadRate: number }> = {};
    const torrentIds = new Set<string>();
    for (const point of points) {
      for (const [id] of Object.entries(point.torrentRates)) {
        torrentIds.add(id);
      }
    }
    for (const id of torrentIds) {
      let downloadSum = 0;
      let uploadSum = 0;
      let name: string | null = null;
      for (const point of points) {
        const entry = point.torrentRates[id];
        if (entry !== undefined && name === null && entry.name.length > 0) {
          name = entry.name;
        }
        downloadSum += entry?.downloadRate ?? 0;
        uploadSum += entry?.uploadRate ?? 0;
      }
      const divisor = points.length > 0 ? points.length : 1;
      avgTorrentRates[id] = {
        name: name ?? id,
        downloadRate: downloadSum / divisor,
        uploadRate: uploadSum / divisor,
      };
    }

    const base: ChartDataPoint = {
      timestamp: bucketTimestamp,
      downloadRate: 0,
      uploadRate: 0,
      load1: 0,
      load5: 0,
      load15: 0,
      responseTimes: avgResponseTimes,
      memoryUsage: avgMemoryUsage,
      torrentRates: avgTorrentRates,
    };

    const aggregatedPoint = points.reduce<ChartDataPoint>((acc, p) => ({
      timestamp: acc.timestamp,
      downloadRate: acc.downloadRate + p.downloadRate / points.length,
      uploadRate: acc.uploadRate + p.uploadRate / points.length,
      load1: acc.load1 + p.load1 / points.length,
      load5: acc.load5 + p.load5 / points.length,
      load15: acc.load15 + p.load15 / points.length,
      responseTimes: avgResponseTimes,
      memoryUsage: avgMemoryUsage,
      torrentRates: avgTorrentRates,
    }), base);
    aggregated.push(aggregatedPoint);
  }

  return aggregated;
}

export function prepareChartSeries(
  data: Array<ChartDataPoint>,
  resolution: TimeResolution,
  now: number = Date.now()
): PreparedChartSeries {
  const aggregated = aggregateData(data, resolution, now);
  const timeRange = RESOLUTION_TIME_RANGES[resolution];
  const minTime = now - timeRange;

  const maxRateBytes = aggregated.reduce(
    (max, point) => Math.max(max, point.downloadRate, point.uploadRate),
    0
  );

  const rateScale = selectRateScale(maxRateBytes);
  const rateDivisor = rateScale.divisor > 0 ? rateScale.divisor : 1;

  const download = aggregated.map(point => ({
    x: point.timestamp,
    y: point.downloadRate / rateDivisor,
  }));

  const upload = aggregated.map(point => ({
    x: point.timestamp,
    y: point.uploadRate / rateDivisor,
  }));

  const load = aggregated.map(point => ({
    x: point.timestamp,
    y: point.load1,
  }));

  const servicesSet = new Set<string>();
  const containersSet = new Set<string>();
  const torrentsMap = new Map<string, string>();
  for (const point of aggregated) {
    for (const service of Object.keys(point.responseTimes)) {
      servicesSet.add(service);
    }
    for (const container of Object.keys(point.memoryUsage)) {
      containersSet.add(container);
    }
    for (const [id, snapshot] of Object.entries(point.torrentRates)) {
      if (!torrentsMap.has(id)) {
        torrentsMap.set(id, snapshot.name.length > 0 ? snapshot.name : id);
      }
    }
  }

  const services = Array.from(servicesSet);
  const containers = Array.from(containersSet);
  const torrents = Array.from(torrentsMap, ([id, name]) => ({ id, name }));

  const responseTimes: Record<string, Array<XYPoint>> = {};
  for (const service of services) {
    responseTimes[service] = aggregated.map(point => ({
      x: point.timestamp,
      y: point.responseTimes[service] ?? 0,
    }));
  }

  const memoryUsage: Record<string, Array<XYPoint>> = {};
  for (const container of containers) {
    memoryUsage[container] = aggregated.map(point => ({
      x: point.timestamp,
      y: point.memoryUsage[container] ?? 0,
    }));
  }

  const torrentDownloads: Record<string, Array<XYPoint>> = {};
  const torrentUploads: Record<string, Array<XYPoint>> = {};
  for (const torrent of torrents) {
    torrentDownloads[torrent.id] = aggregated.map(point => ({
      x: point.timestamp,
      y: (point.torrentRates[torrent.id]?.downloadRate ?? 0) / rateDivisor,
    }));
    torrentUploads[torrent.id] = aggregated.map(point => ({
      x: point.timestamp,
      y: (point.torrentRates[torrent.id]?.uploadRate ?? 0) / rateDivisor,
    }));
  }

  return {
    download,
    upload,
    load,
    responseTimes,
    memoryUsage,
    torrentDownloads,
    torrentUploads,
    services,
    containers,
    torrents,
    rateScale,
    xBounds: { min: minTime, max: now },
  };
}
