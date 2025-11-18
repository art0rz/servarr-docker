export interface ChartDataPoint {
  timestamp: number;
  downloadRate: number;
  uploadRate: number;
  load1: number;
  load5: number;
  load15: number;
  responseTimes: Record<string, number>;
  memoryUsage: Record<string, number>;
}

export const TIME_RESOLUTIONS = ['1h', '1d', '1w', '1m'] as const;
export type TimeResolution = typeof TIME_RESOLUTIONS[number];

interface ChartBucket {
  point: ChartDataPoint;
  samples: number;
}

export type ChartStore = Record<TimeResolution, Array<ChartBucket>>;

export interface CompactChartSeries {
  dataPoints: number;
  timestamps: Array<number>;
  downloadRate: Array<number>;
  uploadRate: Array<number>;
  load1: Array<number>;
  responseTimes: Record<string, Array<number>>;
  memoryUsage: Record<string, Array<number>>;
  samples: Array<number>;
}

export interface ChartApiPayload {
  retentionMs: number;
  services: Array<string>;
  containers: Array<string>;
  series: Record<TimeResolution, CompactChartSeries>;
}

interface ChartStoreHelpers {
  createEmptyStore(): ChartStore;
  appendSample(store: ChartStore, sample: ChartDataPoint): void;
  sanitizeStore(raw: Record<string, unknown>): ChartStore;
  convertLegacyData(data: Array<unknown>): ChartStore;
  buildPayload(store: ChartStore): ChartApiPayload;
}

export function createChartStoreHelpers(retentionMs: number): ChartStoreHelpers {
  const RESOLUTION_CONFIG: Record<TimeResolution, { windowMs: number; bucketMs: number }> = {
    '1h': { windowMs: 60 * 60 * 1000, bucketMs: 60 * 1000 },
    '1d': { windowMs: 24 * 60 * 60 * 1000, bucketMs: 60 * 1000 },
    '1w': { windowMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 },
    '1m': { windowMs: retentionMs, bucketMs: 30 * 60 * 1000 },
  };

  function createEmptyStore(): ChartStore {
    return {
      '1h': [],
      '1d': [],
      '1w': [],
      '1m': [],
    };
  }

  function clonePoint(point: ChartDataPoint): ChartDataPoint {
    return {
      ...point,
      responseTimes: { ...point.responseTimes },
      memoryUsage: { ...point.memoryUsage },
    };
  }

  function mergeRecordAverages(
    target: Record<string, number>,
    sample: Record<string, number>,
    prevCount: number,
    newCount: number
  ) {
    const keys = new Set([...Object.keys(target), ...Object.keys(sample)]);
    for (const key of keys) {
      const current = target[key] ?? 0;
      const incoming = sample[key] ?? 0;
      target[key] = (current * prevCount + incoming) / newCount;
    }
  }

  function mergeBucket(bucket: ChartBucket, sample: ChartDataPoint) {
    const prevCount = bucket.samples;
    const newCount = prevCount + 1;
    const target = bucket.point;

    target.timestamp = sample.timestamp;
    target.downloadRate = (target.downloadRate * prevCount + sample.downloadRate) / newCount;
    target.uploadRate = (target.uploadRate * prevCount + sample.uploadRate) / newCount;
    target.load1 = (target.load1 * prevCount + sample.load1) / newCount;
    target.load5 = (target.load5 * prevCount + sample.load5) / newCount;
    target.load15 = (target.load15 * prevCount + sample.load15) / newCount;
    mergeRecordAverages(target.responseTimes, sample.responseTimes, prevCount, newCount);
    mergeRecordAverages(target.memoryUsage, sample.memoryUsage, prevCount, newCount);

    bucket.samples = newCount;
  }

  function appendSample(store: ChartStore, sample: ChartDataPoint) {
    for (const resolution of TIME_RESOLUTIONS) {
      const { bucketMs, windowMs } = RESOLUTION_CONFIG[resolution];
      const buckets = store[resolution];
      const sampleClone = clonePoint(sample);

      if (bucketMs <= 0) {
        buckets.push({ point: sampleClone, samples: 1 });
      } else {
        const bucketTimestamp = Math.floor(sample.timestamp / bucketMs) * bucketMs;
        sampleClone.timestamp = bucketTimestamp;
        const lastBucket = buckets[buckets.length - 1];
        if (lastBucket?.point.timestamp === bucketTimestamp) {
          mergeBucket(lastBucket, sampleClone);
        } else {
          buckets.push({ point: sampleClone, samples: 1 });
        }
      }

      const cutoff = sample.timestamp - windowMs;
      while (buckets.length > 0 && (buckets[0]?.point.timestamp ?? 0) < cutoff) {
        buckets.shift();
      }
    }
  }

  function isValidPoint(point: unknown): point is ChartDataPoint {
    if (typeof point !== 'object' || point === null) return false;
    const candidate = point as ChartDataPoint;
    return typeof candidate.timestamp === 'number' &&
      typeof candidate.downloadRate === 'number' &&
      typeof candidate.uploadRate === 'number' &&
      typeof candidate.load1 === 'number' &&
      typeof candidate.load5 === 'number' &&
      typeof candidate.load15 === 'number' &&
      typeof candidate.responseTimes === 'object' &&
      typeof candidate.memoryUsage === 'object';
  }

  function sanitizeStore(raw: Record<string, unknown>): ChartStore {
    const sanitized = createEmptyStore();
    const now = Date.now();

    for (const resolution of TIME_RESOLUTIONS) {
      const config = RESOLUTION_CONFIG[resolution];
      const list = Array.isArray(raw[resolution]) ? raw[resolution] : [];
      for (const entry of list) {
        if (typeof entry !== 'object' || entry === null) continue;
        const bucket = entry as Partial<ChartBucket>;
        if (typeof bucket.samples !== 'number' || bucket.samples <= 0) continue;
        if (!isValidPoint(bucket.point)) continue;
        if (now - bucket.point.timestamp > config.windowMs) continue;
        sanitized[resolution].push({
          point: clonePoint(bucket.point),
          samples: bucket.samples,
        });
      }
    }

    return sanitized;
  }

  function convertLegacyData(data: Array<unknown>): ChartStore {
    const store = createEmptyStore();
    for (const point of data) {
      if (isValidPoint(point)) {
        appendSample(store, point);
      }
    }
    return store;
  }

  function buildCompactSeries(
    buckets: Array<ChartBucket>,
    services: Array<string>,
    containers: Array<string>
  ): CompactChartSeries {
    const points = buckets.map(bucket => bucket.point);

    const responseTimes: Record<string, Array<number>> = {};
    for (const service of services) {
      responseTimes[service] = points.map(point => Math.round((point.responseTimes[service] ?? 0) / 10));
    }

    const memoryUsage: Record<string, Array<number>> = {};
    for (const container of containers) {
      memoryUsage[container] = points.map(point => point.memoryUsage[container] ?? 0);
    }

    return {
      dataPoints: points.length,
      timestamps: points.map(point => point.timestamp),
      downloadRate: points.map(point => Math.round(point.downloadRate)),
      uploadRate: points.map(point => Math.round(point.uploadRate)),
      load1: points.map(point => Math.round(point.load1 * 100) / 100),
      responseTimes,
      memoryUsage,
      samples: buckets.map(bucket => bucket.samples),
    };
  }

  function buildPayload(store: ChartStore): ChartApiPayload {
    const services = new Set<string>();
    const containers = new Set<string>();

    for (const resolution of TIME_RESOLUTIONS) {
      for (const bucket of store[resolution]) {
        for (const service of Object.keys(bucket.point.responseTimes)) {
          services.add(service);
        }
        for (const container of Object.keys(bucket.point.memoryUsage)) {
          containers.add(container);
        }
      }
    }

    const serviceList = Array.from(services);
    const containerList = Array.from(containers);

    const series = Object.fromEntries(
      TIME_RESOLUTIONS.map(resolution => [
        resolution,
        buildCompactSeries(store[resolution], serviceList, containerList),
      ])
    ) as Record<TimeResolution, CompactChartSeries>;

    return {
      retentionMs,
      services: serviceList,
      containers: containerList,
      series,
    };
  }

  return {
    createEmptyStore,
    appendSample,
    sanitizeStore,
    convertLegacyData,
    buildPayload,
  };
}
