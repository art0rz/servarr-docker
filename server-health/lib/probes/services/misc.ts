/**
 * Health probes for miscellaneous services (FlareSolverr, Cross-Seed, Recyclarr)
 */

import { dockerInspect, getContainerLogs } from '../../docker';
import { loadCrossSeedStats } from '../../config';
import { httpGet, httpPost, parseJson } from '../http';
import type {
  FlareProbeResult,
  CrossSeedProbeResult,
  RecyclarrProbeResult,
} from '../types';

/**
 * Probe FlareSolverr
 */
export async function probeFlare(url: string | undefined): Promise<FlareProbeResult> {
  if (url === undefined) return { name: 'FlareSolverr', ok: false, reason: 'container not found' };

  const result = await httpPost(`${url}/v1`, { cmd: 'sessions.list' });
  const ok = result.ok;
  const sessions = ok ? parseJson(result.out, (data) =>
    Array.isArray((data as { sessions?: unknown }).sessions)
      ? (data as { sessions: Array<unknown> }).sessions.length
      : null
  ) ?? 0 : 0;

  return { name: 'FlareSolverr', url, ok, sessions, http: ok ? 200 : 0 };
}

/**
 * Probe Cross-Seed
 */
export async function probeCrossSeed(url: string | undefined): Promise<CrossSeedProbeResult> {
  if (url === undefined) return { name: 'Cross-Seed', ok: false, reason: 'container not found' };

  const result = await httpGet(`${url}/api/ping`);
  const ok = result.ok;

  if (ok) {
    const stats = loadCrossSeedStats();
    return {
      name: 'Cross-Seed',
      url,
      ok: true,
      version: '',
      http: 200,
      lastRun: stats?.lastTimestamp ?? null,
      torrentsAdded: typeof stats?.added === 'number' ? stats.added : null,
    };
  }

  return { name: 'Cross-Seed', url, ok: false, http: 0 };
}

/**
 * Probe Recyclarr by checking Docker logs
 */
export async function probeRecyclarr(): Promise<RecyclarrProbeResult> {
  const name = 'Recyclarr';

  // Check if container is running
  const running = await dockerInspect('.State.Running', 'recyclarr');
  if (running !== true) {
    return { name, ok: false, reason: 'container not running' };
  }

  // Get logs from last 24 hours
  const logsText = await getContainerLogs('recyclarr');

  if (logsText.length === 0) {
    return { name, ok: false, reason: 'failed to read logs' };
  }

  // Count errors in last 24h
  const logLines = logsText.split('\n');
  const errorLines = logLines.filter(line => {
    const lower = line.toLowerCase();
    return lower.includes('[err]') || (lower.includes('error') && !lower.includes('0 error'));
  });
  const errorCount = errorLines.length;

  // Check for success indicators
  const logText = logsText.toLowerCase();
  const hasSuccess = logText.includes('completed successfully') ||
                     logText.includes('[inf]') ||
                     logText.includes('starting cron');

  // Consider healthy if running with success indicators and no errors
  const ok = hasSuccess && errorCount === 0;

  return {
    name,
    ok,
    version: '',
    http: 0,
    detail: errorCount === 0 ? 'no errors (24h)' : `${String(errorCount)} error${errorCount !== 1 ? 's' : ''} (24h)`,
  };
}
