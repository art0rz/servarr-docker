import type { HealthData } from './types';
import { renderSummary, renderVpnCard, renderServiceCard, renderCheckCard } from './components';
import { initNetworkChart, initLoadChart, initResponseTimeChart, updateCharts, setResolution, type TimeResolution } from './chart';
import './style.css';

let chartsInitialized = false;

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

    // Update charts with latest data
    if (chartsInitialized && data.chartData.length > 0) {
      updateCharts(data.chartData);
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

function refresh() {
  void loadHealth();
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
      void loadHealth();
    });
  });
});

// Initial load and auto-refresh
void loadHealth();
setInterval(() => { void loadHealth(); }, 3000);
