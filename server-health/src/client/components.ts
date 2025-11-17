import type { HealthData, ServiceProbeResult, CheckResult, GluetunProbeResult, QbitEgressProbeResult, QbitIngressInfo } from './types';

// Utility functions
const escapeHtml = (str: string | number): string =>
  String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;');

const RATE_UNITS: Array<string> = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];

function formatRate(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '0';
  const units = RATE_UNITS;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  // Prefer the next unit when we're close to the boundary (>= 512 of current unit)
  if (value >= 512 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const formatted = value.toFixed(precision);
  const unit = units[unitIndex];
  const fallbackUnitIndex = units.length - 1;
  const fallbackUnit = fallbackUnitIndex >= 0 ? units[fallbackUnitIndex] : undefined;
  const displayUnit = unit ?? fallbackUnit ?? 'B/s';
  return `${formatted} ${displayUnit}`;
}

// Render functions
export function renderSummary(data: HealthData): string {
  const checks = data.checks;
  const okCount = checks.filter(c => c.ok).length;
  const total = checks.length;
  return `<div class="badge">${String(okCount)} / ${String(total)} checks passing</div>`;
}

export function renderVpnCard(
  vpn: GluetunProbeResult | { name: string; ok: boolean; running: boolean; healthy: null },
  qbitEgress: QbitEgressProbeResult,
  qbitIngress: QbitIngressInfo | null,
  pfSync: CheckResult | null,
): string {
  const vpnData = vpn as Partial<GluetunProbeResult>;
  const vpnOk = vpnData.ok === true;
  const vpnStatus = typeof vpnData.healthy === 'string' && vpnData.healthy.length > 0 ? vpnData.healthy.toUpperCase() : 'UNKNOWN';
  const vpnRunningText = vpnData.running === true ? 'Yes' : 'No';
  const vpnEgressText = typeof vpnData.vpnEgress === 'string' && vpnData.vpnEgress.length > 0 ? vpnData.vpnEgress : 'Unknown';

  const egressOk = qbitEgress.ok;
  const egressIp = qbitEgress.vpnEgress.length > 0 ? qbitEgress.vpnEgress : 'Unknown';

  const hasIngress = qbitIngress !== null;
  const ingressHost = hasIngress && typeof qbitIngress.hostPort === 'string' ? qbitIngress.hostPort : '';
  const ingressPort = hasIngress ? qbitIngress.listenPort ?? null : null;
  const ingressPresent = hasIngress && (ingressHost.length > 0 || typeof ingressPort === 'number');
  const ingressOk = ingressHost.length > 0 && typeof ingressPort === 'number';
  const ingressStatus = ingressOk ? 'ok' : 'fail';
  const ingressHostText = ingressHost.length > 0 ? ingressHost : 'pending';
  const ingressPortText = typeof ingressPort === 'number' ? String(ingressPort) : 'Unknown';

  const pfDetail = pfSync !== null && typeof pfSync.detail === 'string' && pfSync.detail.length > 0
    ? pfSync.detail
    : pfSync !== null
      ? (pfSync.ok ? 'OK' : 'Requires attention')
      : '';
  const pfStatus = pfSync?.ok === true ? 'ok' : 'fail';

  return `
    <div class="card">
      <div class="status ${vpnOk ? 'ok' : 'fail'}">
        ${vpnStatus}
      </div>
      <div><strong>Gluetun VPN</strong></div>
      <div class="tag">Running: ${vpnRunningText}</div>
      <div class="tag">Egress IP: ${vpnEgressText}</div>
    </div>
    <div class="card">
      <div class="status ${egressOk ? 'ok' : 'fail'}">
        ${egressOk ? 'OK' : 'FAIL'}
      </div>
      <div><strong>qBittorrent Egress</strong></div>
      <div class="tag">Egress IP: ${egressIp}</div>
    </div>
    ${ingressPresent ? `
    <div class="card">
      <div class="status ${ingressStatus}">Ingress</div>
      <div><strong>qBittorrent Ingress</strong></div>
      <div class="tag">Host Port: ${ingressHostText}</div>
      <div class="tag">qBittorrent Port: ${ingressPortText}</div>
    </div>` : ''}
    ${pfSync !== null ? `
    <div class="card">
      <div class="status ${pfStatus}">pf-sync</div>
      <div><strong>pf-sync heartbeat</strong></div>
      <div class="tag">${escapeHtml(pfDetail)}</div>
    </div>` : ''}
  `;
}

export function renderServiceCard(service: ServiceProbeResult, serviceChecks: Array<CheckResult> = []): string {
  const ok = service.ok;
  const extras: Array<string> = [];

  if (typeof service.version === 'string' && service.version.length > 0) extras.push(`v${service.version}`);
  if (typeof service.queue === 'number') extras.push(`Queue: ${String(service.queue)}`);
  if (typeof service.indexers === 'number') extras.push(`Indexers: ${String(service.indexers)}`);
  if (typeof service.dl === 'number') extras.push(`DL: ${formatRate(service.dl)}`);
  if (typeof service.up === 'number') extras.push(`UP: ${formatRate(service.up)}`);
  if (typeof service.total === 'number') extras.push(`Torrents: ${String(service.total)}`);
  if (typeof service.sessions === 'number') extras.push(`Sessions: ${String(service.sessions)}`);
  if (typeof service.lastRun === 'string' && service.lastRun.length > 0) extras.push(`Last: ${escapeHtml(service.lastRun)}`);
  if (typeof service.torrentsAdded === 'number') extras.push(`Added: ${String(service.torrentsAdded)}`);

  // Add detail field if present (e.g., error count for recyclarr)
  if (typeof service.detail === 'string' && service.detail.length > 0) extras.push(service.detail);

  const serviceCheckTags = serviceChecks.map(check => {
    const trimmed = check.name.replace(service.name, '').trim();
    const label = trimmed.length > 0 ? trimmed : check.name;
    const rawDetail = check.detail.length > 0 ? check.detail : (check.ok ? 'OK' : 'Requires attention');
    const detailText = rawDetail.replace(/^enabled:\s*/i, '');
    return `<div class="tag">${escapeHtml(`${label}: ${detailText}`)}</div>`;
  }).join('');

  return `
    <div class="card" style="${!ok ? 'border-color: #f85149;' : ''}">
      <div class="status ${ok ? 'ok' : 'fail'}">
        ${ok ? 'OK' : 'FAIL'}
      </div>
      <div><strong>${escapeHtml(service.name.length > 0 ? service.name : 'Unknown')}</strong></div>
      ${typeof service.url === 'string' && service.url.length > 0 ? `<div class="tag">
        <a href="${escapeHtml(service.url)}" target="_blank" rel="noreferrer">${escapeHtml(service.url)}</a>
      </div>` : ''}
      ${extras.length > 0 ? `<div class="tag">${extras.join(' • ')}</div>` : ''}
      ${typeof service.reason === 'string' && service.reason.length > 0 ? `<div class="tag" style="color: #f85149;">Reason: ${escapeHtml(service.reason)}</div>` : ''}
      ${serviceCheckTags}
    </div>
  `;
}

export function renderCheckCard(check: CheckResult): string {
  const ok = check.ok;
  return `
    <div class="card">
      <div class="status ${ok ? 'ok' : 'fail'}">
        ${ok ? 'OK' : 'FAIL'}
      </div>
      <div>${escapeHtml(check.name)}</div>
      ${check.detail.length > 0 ? `<pre class="kv">${escapeHtml(check.detail)}</pre>` : ''}
    </div>
  `;
}
