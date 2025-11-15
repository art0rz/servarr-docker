import './style.css';
import Chart from 'chart.js/auto';

interface CheckEntry {
  name: string;
  ok: boolean;
  detail?: string;
}

interface ServiceEntry {
  name: string;
  ok: boolean;
  url?: string;
  version?: string;
  queue?: number;
  indexers?: number;
  total?: number;
  sessions?: number;
  detail?: string;
}

interface VpnEntry {
  name: string;
  ok: boolean;
  running?: boolean;
  healthy?: string | null;
  vpnEgress?: string;
  forwardedPort?: string;
}

interface QbitEgressEntry {
  name: string;
  ok: boolean;
  vpnEgress?: string;
}

interface HealthResponse {
  vpn?: VpnEntry;
  qbitEgress?: QbitEgressEntry;
  services?: ServiceEntry[];
  checks?: CheckEntry[];
  gitRef?: string;
}

interface HistorySample {
  timestamp: number;
  dl: number;
  up: number;
}

interface HistoryResponse {
  updatedAt?: string;
  samples?: HistorySample[];
}

const summaryEl = document.getElementById('summary');
const vpnEl = document.getElementById('vpn');
const servicesEl = document.getElementById('services');
const checksEl = document.getElementById('checks');
const gitRefEl = document.getElementById('git-ref');
const chartStatusEl = document.getElementById('chart-status');
const chartCanvas = document.getElementById('qbit-chart') as HTMLCanvasElement;

let qbitChart: Chart | null = null;

function renderSummary(checks: CheckEntry[]) {
  if (!summaryEl) return;
  const okCount = checks.filter((c) => c.ok).length;
  summaryEl.innerHTML = `<div class="badge">${okCount} / ${checks.length} checks passing</div>`;
}

function renderVPN(vpn?: VpnEntry, qbitEgress?: QbitEgressEntry) {
  if (!vpnEl) return;
  const running = vpn?.running ? 'Yes' : 'No';
  vpnEl.innerHTML = `
    <div class="card">
      <div class="status ${vpn?.ok ? 'ok' : 'fail'}">${vpn?.healthy || 'unknown'}</div>
      <div><strong>Gluetun VPN</strong></div>
      <div class="tag">Running: ${running}</div>
      <div class="tag">Egress IP: ${vpn?.vpnEgress || 'Unknown'}</div>
      <div class="tag">Forwarded Port: ${vpn?.forwardedPort || 'None'}</div>
    </div>
    <div class="card">
      <div class="status ${qbitEgress?.ok ? 'ok' : 'fail'}">${qbitEgress?.ok ? 'OK' : 'FAIL'}</div>
      <div><strong>qBittorrent Egress</strong></div>
      <div class="tag">Egress IP: ${qbitEgress?.vpnEgress || 'Unknown'}</div>
    </div>
  `;
}

function renderServices(services: ServiceEntry[]) {
  if (!servicesEl) return;
  servicesEl.innerHTML = services
    .map((service) => {
      const ok = service.ok;
      const extras: string[] = [];
      if (service.version) extras.push(`v${service.version}`);
      if (typeof service.queue === 'number') extras.push(`Queue: ${service.queue}`);
      if (typeof service.indexers === 'number') extras.push(`Indexers: ${service.indexers}`);
      if (typeof service.total === 'number') extras.push(`Torrents: ${service.total}`);
      if (service.sessions) extras.push(`Sessions: ${service.sessions}`);
      if (service.detail) extras.push(service.detail);
      return `
        <div class="card" style="${!ok ? 'border-color: #f85149;' : ''}">
          <div class="status ${ok ? 'ok' : 'fail'}">${ok ? 'OK' : 'FAIL'}</div>
          <div><strong>${service.name}</strong></div>
          ${service.url ? `<div class="tag"><a href="${service.url}">${service.url}</a></div>` : ''}
          ${extras.length ? `<div class="tag">${extras.join(' • ')}</div>` : ''}
        </div>
      `;
    })
    .join('');
}

function renderChecks(checks: CheckEntry[]) {
  if (!checksEl) return;
  checksEl.innerHTML = checks
    .map((check) => {
      return `
        <div class="card">
          <div class="status ${check.ok ? 'ok' : 'fail'}">${check.ok ? 'OK' : 'FAIL'}</div>
          <div>${check.name}</div>
          ${check.detail ? `<pre class="kv">${check.detail}</pre>` : ''}
        </div>
      `;
    })
    .join('');
}

function updateGitRef(ref: string | undefined) {
  if (gitRefEl) {
    gitRefEl.textContent = ref ? `git: ${ref}` : '';
  }
}

function destroyChart() {
  if (qbitChart) {
    qbitChart.destroy();
    qbitChart = null;
  }
}

function renderChart(samples: HistorySample[]) {
  if (!chartCanvas || !chartStatusEl) return;
  if (!samples.length) {
    chartStatusEl.textContent = 'No qBit data';
    destroyChart();
    return;
  }
  chartStatusEl.textContent = '';
  const labels = samples.map((s) => new Date(s.timestamp).toLocaleTimeString());
  const dlData = samples.map((s) => s.dl / 1024 / 1024);
  const upData = samples.map((s) => s.up / 1024 / 1024);
  if (!qbitChart) {
    qbitChart = new Chart(chartCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Download (MB/s)',
            data: dlData,
            borderColor: '#3fb950',
            backgroundColor: 'rgba(63,185,80,0.2)',
            tension: 0.3
          },
          {
            label: 'Upload (MB/s)',
            data: upData,
            borderColor: '#f85149',
            backgroundColor: 'rgba(248,81,73,0.2)',
            tension: 0.3
          }
        ]
      },
      options: {
        animation: false,
        responsive: true,
        scales: {
          y: { beginAtZero: true }
        }
      }
    });
  } else {
    qbitChart.data.labels = labels;
    qbitChart.data.datasets[0].data = dlData;
    qbitChart.data.datasets[1].data = upData;
    qbitChart.update('none');
  }
}

async function loadHealth() {
  const res = await fetch('/api/health');
  const data = (await res.json()) as HealthResponse;
  renderSummary(data.checks ?? []);
  renderVPN(data.vpn, data.qbitEgress);
  renderServices(data.services ?? []);
  renderChecks(data.checks ?? []);
  updateGitRef(data.gitRef);
}

async function loadHistory() {
  const res = await fetch('/api/qbit-history');
  const data = (await res.json()) as HistoryResponse;
  renderChart(data.samples ?? []);
}

loadHealth();
loadHistory();
setInterval(loadHealth, 3000);
setInterval(loadHistory, 5000);
