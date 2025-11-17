/**
 * Health probes for *arr services (Sonarr, Radarr, Prowlarr, Bazarr)
 */

import { httpGet, arrHeaders, parseJson } from '../http';
import type {
  ArrQueueProbeResult,
  SonarrProbeResult,
  RadarrProbeResult,
  ProwlarrProbeResult,
  BazarrProbeResult,
} from '../types';

/**
 * Generic probe for *arr services (Sonarr, Radarr, Prowlarr, Bazarr)
 */
async function probeArrService(name: string, url: string | undefined, headers: Array<string>, apiVersion = 'v3') {
  if (url === undefined) return { name, ok: false, reason: 'container not found' };

  const status = await httpGet(`${url}/api/${apiVersion}/system/status`, { headers });
  const ok = status.ok;
  const version = ok ? parseJson(status.out, (data) =>
    typeof (data as { version?: unknown }).version === 'string'
      ? (data as { version: string }).version
      : null
  ) ?? '' : '';

  return { name, url, ok, version, http: ok ? 200 : 0 };
}

/**
 * Generic probe for *arr services with queue info (Sonarr/Radarr)
 */
async function probeArrWithQueue(name: string, url: string | undefined, apiKey: string | null, apiVersion = 'v3'): Promise<ArrQueueProbeResult> {
  if (url === undefined) return { name, ok: false, reason: 'container not found' };

  const headers = arrHeaders(apiKey);
  const base = await probeArrService(name, url, headers, apiVersion);
  if (!base.ok) return base;

  const queue = await httpGet(`${url}/api/${apiVersion}/queue?page=1&pageSize=1`, { headers });
  const count = parseJson(queue.out, (data) =>
    typeof (data as { totalRecords?: unknown }).totalRecords === 'number'
      ? (data as { totalRecords: number }).totalRecords
      : null
  ) ?? 0;

  return { ...base, queue: count };
}

/**
 * Probe Sonarr with queue info
 */
export async function probeSonarr(url: string | undefined, apiKey: string | null): Promise<SonarrProbeResult> {
  return probeArrWithQueue('Sonarr', url, apiKey, 'v3');
}

/**
 * Probe Radarr with queue info
 */
export async function probeRadarr(url: string | undefined, apiKey: string | null): Promise<RadarrProbeResult> {
  return probeArrWithQueue('Radarr', url, apiKey, 'v3');
}

/**
 * Probe Prowlarr with indexer count
 */
export async function probeProwlarr(url: string | undefined, apiKey: string | null): Promise<ProwlarrProbeResult> {
  if (url === undefined) return { name: 'Prowlarr', ok: false, reason: 'container not found' };

  const headers = arrHeaders(apiKey);
  const base = await probeArrService('Prowlarr', url, headers, 'v1');
  if (!base.ok) return base;

  const indexers = await httpGet(`${url}/api/v1/indexer`, { headers });
  const active = parseJson(indexers.out, (data) =>
    Array.isArray(data)
      ? data.filter(i => (i as { enable?: unknown }).enable === true).length
      : null
  ) ?? 0;

  return { ...base, indexers: active };
}

/**
 * Probe Bazarr (uses different header name than *arr services)
 */
export async function probeBazarr(url: string | undefined, apiKey: string | null): Promise<BazarrProbeResult> {
  if (url === undefined) return { name: 'Bazarr', ok: false, reason: 'container not found' };

  const headers = apiKey !== null ? [`X-API-KEY: ${apiKey}`] : [];
  const status = await httpGet(`${url}/api/system/status`, { headers });
  const ok = status.ok;
  const version = ok ? parseJson(status.out, (data) =>
    typeof (data as { version?: unknown }).version === 'string'
      ? (data as { version: string }).version
      : null
  ) ?? '' : '';

  return { name: 'Bazarr', url, ok, version, http: ok ? 200 : 0 };
}
