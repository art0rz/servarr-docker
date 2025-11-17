/**
 * Health check functions for integrations and system resources
 */

import { dockerInspect, getContainerLogs, getContainerImageAge } from '../docker';
import { MEDIA_DIR } from '../config';
import { httpGet, arrHeaders, parseJson } from './http';
import type { CheckResult } from './types';

/**
 * Helper to extract names from array of objects
 */
function summarizeNames(items: Array<unknown>): string {
  return items
    .map(item => (item !== null && typeof item === 'object' && 'name' in item && typeof item.name === 'string' ? item.name : null))
    .filter((name): name is string => name !== null)
    .join(', ');
}

/**
 * Generic check for *arr service download clients
 */
async function checkArrDownloadClients(label: string, url: string | undefined, apiKey: string | null) {
  if (url === undefined) return { name: label, ok: false, detail: 'service URL unavailable' };
  if (apiKey === null) return { name: label, ok: false, detail: 'API key unavailable' };

  const headers = arrHeaders(apiKey);
  const response = await httpGet(`${url}/api/v3/downloadclient`, { headers, timeout: 4 });
  if (!response.ok) {
    return { name: label, ok: false, detail: response.err ?? (response.out.length > 0 ? response.out : 'request failed') };
  }

  const enabled = parseJson(response.out, (data) =>
    Array.isArray(data)
      ? data.filter(client => (client as { enable?: unknown }).enable === true)
      : null
  );

  if (enabled === null) {
    return { name: label, ok: false, detail: 'failed to parse response' };
  }

  const detail = enabled.length > 0
    ? `enabled: ${summarizeNames(enabled)}`
    : 'no enabled clients';

  return {
    name: label,
    ok: enabled.length > 0,
    detail,
  };
}

/**
 * Check Sonarr download clients
 */
export async function checkSonarrDownloadClients(url: string | undefined, apiKey: string | null): Promise<CheckResult> {
  return checkArrDownloadClients('Sonarr download clients', url, apiKey);
}

/**
 * Check Radarr download clients
 */
export async function checkRadarrDownloadClients(url: string | undefined, apiKey: string | null): Promise<CheckResult> {
  return checkArrDownloadClients('Radarr download clients', url, apiKey);
}

/**
 * Check Prowlarr indexers
 */
export async function checkProwlarrIndexers(url: string | undefined, apiKey: string | null): Promise<CheckResult> {
  const name = 'Prowlarr indexers';
  if (url === undefined) return { name, ok: false, detail: 'service URL unavailable' };
  if (apiKey === null) return { name, ok: false, detail: 'API key unavailable' };

  const headers = arrHeaders(apiKey);
  const response = await httpGet(`${url}/api/v1/indexer`, { headers, timeout: 4 });
  if (!response.ok) {
    return { name, ok: false, detail: response.err ?? (response.out.length > 0 ? response.out : 'request failed') };
  }

  const enabled = parseJson(response.out, (data) =>
    Array.isArray(data)
      ? data.filter(indexer => (indexer as { enable?: unknown }).enable === true)
      : null
  );

  if (enabled === null) {
    return { name, ok: false, detail: 'failed to parse response' };
  }

  const detail = enabled.length > 0
    ? `enabled: ${summarizeNames(enabled)}`
    : 'no enabled indexers';

  return {
    name,
    ok: enabled.length > 0,
    detail,
  };
}

/**
 * Check pf-sync heartbeat - verify port forwarding sync is working
 */
export async function checkPfSyncHeartbeat() {
  const name = 'pf-sync heartbeat';

  // Check if container is running
  const running = await dockerInspect('.State.Running', 'pf-sync');
  if (running !== true) {
    return { name, ok: false, detail: 'container not running' };
  }

  // Check logs for recent activity (last 5 minutes)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000 - 300);
  const logs = await getContainerLogs('pf-sync', String(fiveMinutesAgo));

  if (logs.length === 0) {
    return { name, ok: false, detail: 'no recent activity (5m)' };
  }

  // Look for successful port updates or error messages
  const hasError = /error|fail|fatal/i.test(logs);
  const hasSuccess = /updated|synced|forwarded|success/i.test(logs);

  if (hasError) {
    return { name, ok: false, detail: 'errors in recent logs' };
  }

  if (hasSuccess) {
    return { name, ok: true, detail: 'active (recent sync detected)' };
  }

  // No errors but also no explicit success - container is running but quiet
  return { name, ok: true, detail: 'running (no recent activity)' };
}

/**
 * Check disk usage for important volumes
 */
export async function checkDiskUsage() {
  const name = 'disk usage (media)';

  try {
    // Check disk usage on the media directory
    const { statfs } = await import('node:fs/promises');
    const stats = await statfs(MEDIA_DIR);

    const total = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    const used = total - available;
    const usedPercent = Math.round((used / total) * 100);

    const totalGB = (total / 1024 / 1024 / 1024).toFixed(1);
    const usedGB = (used / 1024 / 1024 / 1024).toFixed(1);
    const availableGB = (available / 1024 / 1024 / 1024).toFixed(1);
    const detail = `${String(usedPercent)}% used (${usedGB}GB / ${totalGB}GB, ${availableGB}GB free)`;

    // Warn if over 85%, error if over 95%
    if (usedPercent >= 95) {
      return { name, ok: false, detail: `${detail} - critical` };
    } else if (usedPercent >= 85) {
      return { name, ok: false, detail: `${detail} - warning` };
    }

    return { name, ok: true, detail };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return { name, ok: false, detail: `failed to check: ${err}` };
  }
}

/**
 * Check Docker image age for key containers
 */
export async function checkImageAge() {
  const name = 'image age';

  // Check a few key containers
  const containersToCheck = ['sonarr', 'radarr', 'qbittorrent', 'gluetun'];

  try {
    const results = await Promise.all(
      containersToCheck.map(async (containerName) => {
        const created = await getContainerImageAge(containerName);
        if (created === null) return null;

        const createdDate = new Date(created);
        const ageMs = Date.now() - createdDate.getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

        return { containerName, ageDays };
      })
    );

    const validResults = results.filter((r): r is { containerName: string; ageDays: number } => r !== null);

    if (validResults.length === 0) {
      return { name, ok: false, detail: 'unable to check any images' };
    }

    // Find oldest image
    const oldest = validResults.reduce((max, r) => (r.ageDays > max.ageDays ? r : max));

    // Warn if any image is > 90 days old
    const hasOld = validResults.some(r => r.ageDays > 90);

    const detail = `oldest: ${oldest.containerName} (${String(oldest.ageDays)}d)`;

    if (hasOld) {
      return { name, ok: false, detail: `${detail} - update recommended` };
    }

    return { name, ok: true, detail };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return { name, ok: false, detail: `failed to check: ${err}` };
  }
}
