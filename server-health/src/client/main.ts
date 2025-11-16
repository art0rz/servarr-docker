import type { HealthData, CompactChartData, ChartDataPoint } from './types';
import { renderSummary, renderVpnCard, renderServiceCard, renderCheckCard } from './components';
import { initNetworkChart, initLoadChart, initResponseTimeChart, updateCharts, setResolution, type TimeResolution } from './chart';
import './style.css';

let chartsInitialized = false;
let chartData: Array<ChartDataPoint> = [];

// Decompress compact chart data format
function decompressChartData(compact: CompactChartData): Array<ChartDataPoint> {
  const result: Array<ChartDataPoint> = [];
  for (let i = 0; i < compact.dataPoints; i++) {
    const responseTimes: Record<string, number> = {};
    for (const service of compact.services) {
      const quantized = compact.responseTimes[service]?.[i] ?? 0;
      responseTimes[service] = quantized * 10; // De-quantize from 10ms buckets
    }

    result.push({
      timestamp: compact.startTime + (i * compact.interval),
      downloadRate: compact.downloadRate[i] ?? 0,
      uploadRate: compact.uploadRate[i] ?? 0,
      load1: compact.load1[i] ?? 0,
      load5: 0, // Not sent in compact format (not used in charts)
      load15: 0, // Not sent in compact format (not used in charts)
      responseTimes,
    });
  }
  return result;
}

// Main load function
async function loadHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json() as HealthData;

    // Check if VPN is enabled
    const vpnEnabled = 'running' in data.vpn && data.vpn.running;

    // Update summary
    const summaryEl = document.getElementById('summary');
    if (summaryEl !== null) {
      summaryEl.innerHTML = renderSummary(data);
    }

    // Initialize charts on first load
    if (!chartsInitialized) {
      const networkCanvas = document.getElementById('networkChart') as HTMLCanvasElement | null;
      const loadCanvas = document.getElementById('loadChart') as HTMLCanvasElement | null;
      const responseTimeCanvas = document.getElementById('responseTimeChart') as HTMLCanvasElement | null;
      if (networkCanvas !== null && loadCanvas !== null && responseTimeCanvas !== null) {
        initNetworkChart(networkCanvas);
        initLoadChart(loadCanvas);
        initResponseTimeChart(responseTimeCanvas);
        chartsInitialized = true;
      }
    }

    // Update charts with cached data
    if (chartsInitialized && chartData.length > 0) {
      updateCharts(chartData);
    }

    // Update VPN section - hide if VPN is disabled
    const vpnSectionEl = document.querySelector<HTMLElement>('h2:nth-of-type(5)');
    const vpnDivEl = document.getElementById('vpn');

    if (vpnSectionEl !== null && vpnDivEl !== null) {
      if (vpnEnabled) {
        vpnSectionEl.style.display = 'block';
        vpnDivEl.style.display = 'grid';
        vpnDivEl.innerHTML = renderVpnCard(data.vpn, data.qbitEgress);
      } else {
        vpnSectionEl.style.display = 'none';
        vpnDivEl.style.display = 'none';
      }
    }

    // Update services section
    const servicesEl = document.getElementById('services');
    if (servicesEl !== null) {
      const services = data.services.map(renderServiceCard).join('');
      servicesEl.innerHTML = services.length > 0 ? services : '<div class="empty">No services found</div>';
    }

    // Update checks section
    const checksSectionEl = document.querySelector<HTMLElement>('h2:nth-of-type(7)');
    const checksDivEl = document.getElementById('checks');

    if (checksSectionEl !== null && checksDivEl !== null) {
      const checks = data.checks.map(renderCheckCard).join('');
      checksSectionEl.style.display = 'block';
      checksDivEl.style.display = 'grid';
      checksDivEl.innerHTML = checks.length > 0 ? checks : '<div class="empty">No checks configured</div>';
    }
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
  void loadHealth();
  void loadChartData();
}

// Make refresh function globally available
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

// Initial load and auto-refresh
void loadHealth();
void loadChartData();

// Refresh health status every 3s, chart data every 10s
setInterval(() => { void loadHealth(); }, 3000);
setInterval(() => { void loadChartData(); }, 10000);
