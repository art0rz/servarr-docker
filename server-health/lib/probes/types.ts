/**
 * Type definitions for health probes and checks
 */

/**
 * Base result type for service probes
 */
export interface BaseProbeResult {
  name: string;
  url?: string;
  ok: boolean;
  reason?: string;
  version?: string;
  http?: number;
}

/**
 * Probe result for *arr services with queue info (Sonarr, Radarr)
 */
export interface ArrQueueProbeResult extends BaseProbeResult {
  queue?: number;
}

export type SonarrProbeResult = ArrQueueProbeResult;
export type RadarrProbeResult = ArrQueueProbeResult;

/**
 * Probe result for Prowlarr with indexer count
 */
export interface ProwlarrProbeResult extends BaseProbeResult {
  indexers?: number;
}

/**
 * Probe result for Bazarr
 */
export type BazarrProbeResult = BaseProbeResult;

export interface QbitTorrentRate {
  id: string;
  name: string;
  downloadRate: number;
  uploadRate: number;
}

/**
 * Probe result for qBittorrent
 */
export interface QbitProbeResult extends BaseProbeResult {
  dl?: number | null;
  up?: number | null;
  total?: number | null;
  listenPort?: number | null;
  torrents?: Array<QbitTorrentRate>;
}

/**
 * Probe result for FlareSolverr
 */
export interface FlareProbeResult extends BaseProbeResult {
  sessions?: number;
}

/**
 * Probe result for Cross-Seed
 */
export interface CrossSeedProbeResult extends BaseProbeResult {
  lastRun?: string | null;
  torrentsAdded?: number | null;
}

/**
 * Probe result for Gluetun VPN gateway
 */
export interface GluetunProbeResult {
  name: string;
  container: string;
  ok: boolean;
  running: boolean;
  healthy: string | null;
  vpnEgress: string;
  forwardedPort: string;
  pfExpected: boolean;
}

/**
 * Probe result for qBittorrent egress check
 */
export interface QbitEgressProbeResult {
  name: string;
  container: string;
  ok: boolean;
  vpnEgress: string;
}

/**
 * Probe result for Recyclarr
 */
export interface RecyclarrProbeResult extends BaseProbeResult {
  detail?: string;
}

/**
 * Result type for health checks
 */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}
