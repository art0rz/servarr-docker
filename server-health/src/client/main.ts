import type { HealthData, CompactChartData, ChartDataPoint, CheckResult, TimeResolution } from './types';
import { renderSummary, renderVpnCard, renderServiceCard, renderCheckCard } from './components';
import { initNetworkChart, initLoadChart, initResponseTimeChart, initMemoryChart, updateCharts, setResolution } from './chart';
import './style.css';

const DEFAULT_CHART_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESOLUTIONS: Array<TimeResolution> = ['1h', '1d', '1w', '1m'];

interface ChartBucket {
  point: ChartDataPoint;
  samples: number;
}

type ChartSeriesStore = Record<TimeResolution, Array<ChartBucket>>;

// Logging helpers
function log(message: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function logError(message: string, error?: unknown) {
  const timestamp = new Date().toISOString();
  if (error !== undefined) {
    console.error(`[${timestamp}] ${message}`, error);
  } else {
    console.error(`[${timestamp}] ${message}`);
  }
}

let chartsInitialized = false;
let selectedResolution: TimeResolution = '1h';
let chartRetentionMs = DEFAULT_CHART_RETENTION_MS;
let chartSeriesStore: ChartSeriesStore = createEmptySeriesStore();

// Local health state (updated via WebSocket)
let healthData: HealthData | null = null;

function createEmptySeriesStore(): ChartSeriesStore {
  return {
    '1h': [],
    '1d': [],
    '1w': [],
    '1m': [],
  };
}

function cloneChartPoint(point: ChartDataPoint): ChartDataPoint {
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

function getResolutionConfig(resolution: TimeResolution) {
  if (resolution === '1m') {
    return { windowMs: chartRetentionMs, bucketMs: 30 * 60 * 1000 };
  }
  if (resolution === '1w') {
    return { windowMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 };
  }
  if (resolution === '1d') {
    return { windowMs: 24 * 60 * 60 * 1000, bucketMs: 60 * 1000 };
  }
  return { windowMs: 60 * 60 * 1000, bucketMs: 0 };
}

function decompressChartData(compact: CompactChartData): ChartSeriesStore {
  const store = createEmptySeriesStore();
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
        },
        samples: series.samples[i] ?? 1,
      });
    }

    store[resolution] = buckets;
  }

  return store;
}

function appendChartDataPoint(point: ChartDataPoint) {
  for (const resolution of RESOLUTIONS) {
    const { windowMs, bucketMs } = getResolutionConfig(resolution);
    const buckets = chartSeriesStore[resolution];
    const clone = cloneChartPoint(point);

    if (bucketMs <= 0) {
      buckets.push({ point: clone, samples: 1 });
    } else {
      const bucketTimestamp = Math.floor(point.timestamp / bucketMs) * bucketMs;
      clone.timestamp = bucketTimestamp;
      const lastBucket = buckets[buckets.length - 1];
      if (lastBucket?.point.timestamp === bucketTimestamp) {
        mergeBucket(lastBucket, clone);
      } else {
        buckets.push({ point: clone, samples: 1 });
      }
    }

    const cutoff = point.timestamp - windowMs;
    while (buckets.length > 0 && (buckets[0]?.point.timestamp ?? 0) < cutoff) {
      buckets.shift();
    }
  }
}

function getChartPointsForResolution(resolution: TimeResolution): Array<ChartDataPoint> {
  return chartSeriesStore[resolution].map(bucket => bucket.point);
}

function updateChartsForCurrentResolution() {
  if (!chartsInitialized) return;
  const points = getChartPointsForResolution(selectedResolution);
  if (points.length === 0) return;
  updateCharts(points);
}

// Render health data (called after state update)
const SERVICE_CHECK_MAP: Record<string, Array<string>> = {
  Sonarr: ['Sonarr download clients'],
  Radarr: ['Radarr download clients'],
  Prowlarr: ['Prowlarr indexers'],
};

function partitionChecks(checks: Array<CheckResult>): { serviceChecks: Map<string, Array<CheckResult>>; remaining: Array<CheckResult> } {
  const serviceChecks = new Map<string, Array<CheckResult>>();
  const remaining: Array<CheckResult> = [];

  for (const check of checks) {
    let matchedService: string | undefined;
    for (const [serviceName, names] of Object.entries(SERVICE_CHECK_MAP)) {
      if (names.includes(check.name)) {
        matchedService = serviceName;
        break;
      }
    }
    if (matchedService !== undefined) {
      const list = serviceChecks.get(matchedService) ?? [];
      list.push(check);
      serviceChecks.set(matchedService, list);
    } else {
      remaining.push(check);
    }
  }

  return { serviceChecks, remaining };
}

function renderHealth() {
  if (healthData === null) return;

  // Check if VPN is enabled
  const vpnEnabled = 'running' in healthData.vpn && healthData.vpn.running;

  const { serviceChecks, remaining } = partitionChecks(healthData.checks);

  // Update summary
  const summaryEl = document.getElementById('summary');
  if (summaryEl !== null) {
    const summarySource = { ...healthData, checks: remaining } as HealthData;
    summaryEl.innerHTML = renderSummary(summarySource);
  }

  // Initialize charts on first load
  if (!chartsInitialized) {
    const networkCanvas = document.getElementById('networkChart') as HTMLCanvasElement | null;
    const loadCanvas = document.getElementById('loadChart') as HTMLCanvasElement | null;
    const responseTimeCanvas = document.getElementById('responseTimeChart') as HTMLCanvasElement | null;
    const memoryCanvas = document.getElementById('memoryChart') as HTMLCanvasElement | null;
    if (networkCanvas !== null && loadCanvas !== null && responseTimeCanvas !== null && memoryCanvas !== null) {
      initNetworkChart(networkCanvas);
      initLoadChart(loadCanvas);
      initResponseTimeChart(responseTimeCanvas);
      initMemoryChart(memoryCanvas);
      chartsInitialized = true;
    }
  }

  // Update charts with cached data
  updateChartsForCurrentResolution();

  // Update VPN section - hide if VPN is disabled
  const vpnSectionEl = document.querySelector<HTMLElement>('h2:nth-of-type(4)');
  const vpnDivEl = document.getElementById('vpn');

  if (vpnSectionEl !== null && vpnDivEl !== null) {
    if (vpnEnabled) {
      vpnSectionEl.style.display = 'block';
      vpnDivEl.style.display = 'grid';
      vpnDivEl.innerHTML = renderVpnCard(healthData.vpn, healthData.qbitEgress, healthData.qbitIngress ?? null, healthData.pfSync ?? null);
    } else {
      vpnSectionEl.style.display = 'none';
      vpnDivEl.style.display = 'none';
    }
  }

  // Update services section
  const servicesEl = document.getElementById('services');
  if (servicesEl !== null) {
    const services = healthData.services
      .map(service => renderServiceCard(service, serviceChecks.get(service.name) ?? []))
      .join('');
    servicesEl.innerHTML = services.length > 0 ? services : '<div class="empty">No services found</div>';
  }

  // Update checks section
  const checksSectionEl = document.querySelector<HTMLElement>('h2:nth-of-type(6)');
  const checksDivEl = document.getElementById('checks');

  if (checksSectionEl !== null && checksDivEl !== null) {
    const checks = remaining.map(renderCheckCard).join('');
    checksSectionEl.style.display = 'block';
    checksDivEl.style.display = 'grid';
    checksDivEl.innerHTML = checks.length > 0 ? checks : '<div class="empty">No checks configured</div>';
  }
}

// Fetch health data from HTTP (only for initial load or fallback)
async function fetchHealth() {
  try {
    const response = await fetch('/api/health');
    healthData = await response.json() as HealthData;
    renderHealth();
  } catch (error) {
    logError('Failed to load health data', error);
    const summaryEl = document.getElementById('summary');
    if (summaryEl !== null) {
      summaryEl.innerHTML =
        '<div class="badge" style="color: #f85149;">Failed to load health data</div>';
    }
  }
}

async function loadChartData() {
  try {
    const response = await fetch('/api/charts');
    const compact = await response.json() as CompactChartData;
    if (typeof compact.retentionMs === 'number' && compact.retentionMs > 0) {
      chartRetentionMs = compact.retentionMs;
    }
    chartSeriesStore = decompressChartData(compact);
    updateChartsForCurrentResolution();
  } catch (error) {
    logError('Failed to load chart data', error);
  }
}

function refresh() {
  void fetchHealth();
  void loadChartData();
}

// Make refresh function globally available (for debugging)
(window as unknown as { refresh: () => void }).refresh = refresh;

// Set up resolution selector
document.addEventListener('DOMContentLoaded', () => {
  const resolutionButtons = document.querySelectorAll('.resolution-btn');
  resolutionButtons.forEach(button => {
    button.addEventListener('click', () => {
      const resolution = (button as HTMLElement).dataset['resolution'] as TimeResolution;

      // Update active state
      resolutionButtons.forEach(btn => { btn.classList.remove('active'); });
      button.classList.add('active');

      // Set resolution and trigger chart update
      setResolution(resolution);
      selectedResolution = resolution;
      updateChartsForCurrentResolution();
    });
  });
});

// WebSocket connection
let ws: WebSocket | null = null;
let reconnectTimeout: number | null = null;

interface WSMessage {
  type: 'health' | 'chartPoint';
  data: Partial<HealthData> | ChartDataPoint;
}

function connectWebSocket() {
  // Clear any existing reconnect timeout
  if (reconnectTimeout !== null) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  // Determine WebSocket URL (ws:// or wss://)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    // Refresh health and chart data on (re)connect to ensure we have latest state
    void fetchHealth();
    void loadChartData();
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data as string) as WSMessage;

      if (message.type === 'health') {
        // Partial health update - merge with current state and re-render
        if (healthData !== null) {
          const partialUpdate = message.data as Partial<HealthData>;
          healthData = {
            ...healthData,
            ...partialUpdate,
          };
          renderHealth();
        } else {
          // No local state yet, fetch full state from server
          void fetchHealth();
        }
      } else {
        // message.type === 'chartPoint'
        // New chart data point - append to chartData
        const newPoint = message.data as ChartDataPoint;
        appendChartDataPoint(newPoint);
        updateChartsForCurrentResolution();
      }
    } catch (error) {
      logError('[ws] Failed to parse message', error);
    }
  };

  ws.onerror = (error) => {
    logError('[ws] Error', error);
  };

  ws.onclose = (event) => {
    const wasClean = event.wasClean;
    if (!wasClean) {
      log('[ws] Connection lost, reconnecting...');
    }
    ws = null;
    // Reconnect after 5 seconds
    reconnectTimeout = window.setTimeout(() => {
      connectWebSocket();
    }, 5000);
  };
}

// Initial load via HTTP
void fetchHealth();
void loadChartData();

// Connect WebSocket for real-time updates
connectWebSocket();
