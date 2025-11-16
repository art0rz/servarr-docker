import type { HealthData, ServiceProbeResult, CheckResult, GluetunProbeResult, QbitEgressProbeResult } from './types';

// Utility functions
const escapeHtml = (str: string | number): string =>
  String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;');

const formatRate = (bytes: number | null): string =>
  bytes !== null && bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(2)} MB/s` : '0';

// Render functions
export function renderSummary(data: HealthData): string {
  const checks = data.checks;
  const okCount = checks.filter(c => c.ok).length;
  const total = checks.length;
  return `<div class="badge">${String(okCount)} / ${String(total)} checks passing</div>`;
}

export function renderVpnCard(vpn: GluetunProbeResult | { name: string; ok: boolean; running: boolean; healthy: null }, qbitEgress: QbitEgressProbeResult): string {
  const v = vpn as GluetunProbeResult;
  const q = qbitEgress;

  return `
    <div class="card">
      <div class="status ${v.ok ? 'ok' : 'fail'}">
        ${(v.healthy ?? 'unknown').toUpperCase()}
      </div>
      <div><strong>Gluetun VPN</strong></div>
      <div class="tag">Running: ${v.running ? 'Yes' : 'No'}</div>
      <div class="tag">Egress IP: ${'vpnEgress' in v ? v.vpnEgress : 'Unknown'}</div>
      <div class="tag">Forwarded Port: ${'forwardedPort' in v ? (v.forwardedPort.length > 0 ? v.forwardedPort : 'None') : 'None'}</div>
      ${'uiHostPort' in v && v.uiHostPort.length > 0 ? `<div class="tag">WebUI Port: ${v.uiHostPort}</div>` : ''}
    </div>
    <div class="card">
      <div class="status ${q.ok ? 'ok' : 'fail'}">
        ${q.ok ? 'OK' : 'FAIL'}
      </div>
      <div><strong>qBittorrent Egress</strong></div>
      <div class="tag">Egress IP: ${q.vpnEgress.length > 0 ? q.vpnEgress : 'Unknown'}</div>
    </div>
  `;
}

export function renderServiceCard(service: ServiceProbeResult): string {
  const ok = service.ok;
  const extras: Array<string> = [];

  if (service.version !== undefined) extras.push(`v${service.version}`);
  if (typeof service.queue === 'number') extras.push(`Queue: ${String(service.queue)}`);
  if (typeof service.indexers === 'number') extras.push(`Indexers: ${String(service.indexers)}`);
  if (typeof service.dl === 'number') extras.push(`DL: ${formatRate(service.dl)}`);
  if (typeof service.up === 'number') extras.push(`UP: ${formatRate(service.up)}`);
  if (typeof service.total === 'number') extras.push(`Torrents: ${String(service.total)}`);
  if (typeof service.sessions === 'number') extras.push(`Sessions: ${String(service.sessions)}`);
  if (service.lastRun !== undefined) extras.push(`Last: ${escapeHtml(service.lastRun)}`);
  if (typeof service.torrentsAdded === 'number') extras.push(`Added: ${String(service.torrentsAdded)}`);

  // Add detail field if present (e.g., error count for recyclarr)
  if (service.detail !== undefined) extras.push(service.detail);

  return `
    <div class="card" style="${!ok ? 'border-color: #f85149;' : ''}">
      <div class="status ${ok ? 'ok' : 'fail'}">
        ${ok ? 'OK' : 'FAIL'}
      </div>
      <div><strong>${service.name.length > 0 ? service.name : 'Unknown'}</strong></div>
      ${service.url !== undefined ? `<div class="tag">
        <a href="${service.url}" target="_blank" rel="noreferrer">${service.url}</a>
      </div>` : ''}
      ${extras.length > 0 ? `<div class="tag">${extras.join(' • ')}</div>` : ''}
      ${service.reason !== undefined ? `<div class="tag" style="color: #f85149;">Reason: ${escapeHtml(service.reason)}</div>` : ''}
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
