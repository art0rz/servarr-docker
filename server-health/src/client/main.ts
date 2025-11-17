import type { HealthData, CompactChartData, ChartDataPoint } from './types';
import { renderSummary, renderVpnCard, renderServiceCard, renderCheckCard } from './components';
import { initNetworkChart, initLoadChart, initResponseTimeChart, initMemoryChart, updateCharts, setResolution, type TimeResolution } from './chart';
import './style.css';

let chartsInitialized = false;
let chartData: Array<ChartDataPoint> = [];

// Local health state (updated via WebSocket)
let healthData: HealthData | null = null;

// Decompress compact chart data format
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
      load5: 0, // Not sent in compact format (not used in charts)
      load15: 0, // Not sent in compact format (not used in charts)
      responseTimes,
      memoryUsage,
    });
  }
  return result;
}

// Render health data (called after state update)
function renderHealth() {
  if (healthData === null) return;

  // Check if VPN is enabled
  const vpnEnabled = 'running' in healthData.vpn && healthData.vpn.running;

  // Update summary
  const summaryEl = document.getElementById('summary');
  if (summaryEl !== null) {
    summaryEl.innerHTML = renderSummary(healthData);
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
  if (chartsInitialized && chartData.length > 0) {
    updateCharts(chartData);
  }

  // Update VPN section - hide if VPN is disabled
  const vpnSectionEl = document.querySelector<HTMLElement>('h2:nth-of-type(4)');
  const vpnDivEl = document.getElementById('vpn');

  if (vpnSectionEl !== null && vpnDivEl !== null) {
    if (vpnEnabled) {
      vpnSectionEl.style.display = 'block';
      vpnDivEl.style.display = 'grid';
      vpnDivEl.innerHTML = renderVpnCard(healthData.vpn, healthData.qbitEgress);
    } else {
      vpnSectionEl.style.display = 'none';
      vpnDivEl.style.display = 'none';
    }
  }

  // Update services section
  const servicesEl = document.getElementById('services');
  if (servicesEl !== null) {
    const services = healthData.services.map(renderServiceCard).join('');
    servicesEl.innerHTML = services.length > 0 ? services : '<div class="empty">No services found</div>';
  }

  // Update checks section
  const checksSectionEl = document.querySelector<HTMLElement>('h2:nth-of-type(6)');
  const checksDivEl = document.getElementById('checks');

  if (checksSectionEl !== null && checksDivEl !== null) {
    const checks = healthData.checks.map(renderCheckCard).join('');
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
    console.error('Failed to load health data:', error);
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
    chartData = decompressChartData(compact);

    // Update charts if initialized
    if (chartsInitialized && chartData.length > 0) {
      updateCharts(chartData);
    }
  } catch (error) {
    console.error('Failed to load chart data:', error);
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
      if (chartData.length > 0) {
        updateCharts(chartData);
      }
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
    console.log('[ws] Connected');
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
        chartData.push(newPoint);

        // Keep only last 360 points (1 hour at 10s intervals)
        const MAX_CHART_POINTS = 360;
        if (chartData.length > MAX_CHART_POINTS) {
          chartData.shift();
        }

        // Update charts
        if (chartsInitialized) {
          updateCharts(chartData);
        }
      }
    } catch (error) {
      console.error('[ws] Failed to parse message:', error);
    }
  };

  ws.onerror = (error) => {
    console.error('[ws] Error:', error);
  };

  ws.onclose = (event) => {
    const wasClean = event.wasClean;
    console.log(`[ws] Disconnected ${wasClean ? 'cleanly' : 'unexpectedly'}, reconnecting in 5s...`);
    ws = null;
    // Reconnect after 5 seconds
    reconnectTimeout = window.setTimeout(() => {
      console.log('[ws] Attempting to reconnect...');
      connectWebSocket();
    }, 5000);
  };
}

// Initial load via HTTP
void fetchHealth();
void loadChartData();

// Connect WebSocket for real-time updates
connectWebSocket();
