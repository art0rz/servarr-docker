import type { HealthData } from './types';
import { renderSummary, renderVpnCard, renderServiceCard, renderCheckCard } from './components';
import { initChart, updateChart } from './chart';
import './style.css';

let chartInitialized = false;

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

    // Initialize chart on first load
    if (!chartInitialized) {
      const canvas = document.getElementById('trafficChart') as HTMLCanvasElement | null;
      if (canvas !== null) {
        initChart(canvas);
        chartInitialized = true;
      }
    }

    // Update chart with latest data
    if (chartInitialized && data.chartData.length > 0) {
      updateChart(data.chartData);
    }

    // Update VPN section - hide if VPN is disabled
    const vpnSectionEl = document.querySelector<HTMLElement>('h2:nth-of-type(2)');
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
    const checksSectionEl = document.querySelector<HTMLElement>('h2:nth-of-type(4)');
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

function refresh() {
  void loadHealth();
}

// Make refresh function globally available
(window as unknown as { refresh: () => void }).refresh = refresh;

// Initial load and auto-refresh
void loadHealth();
setInterval(() => { void loadHealth(); }, 3000);
