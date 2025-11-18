
export interface ServiceProbeResult {
  name: string;
  url?: string;
  ok: boolean;
  reason?: string;
  version?: string;
  http?: number;
  queue?: number;
  indexers?: number;
  dl?: number | null;
  up?: number | null;
  total?: number | null;
  sessions?: number;
  lastRun?: string;
  torrentsAdded?: number;
  detail?: string;
  torrents?: Array<TorrentRate>;
}

export interface QbitIngressInfo {
  hostPort: string;
  listenPort: number | null;
}

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

export interface QbitEgressProbeResult {
  name: string;
  container: string;
  ok: boolean;
  vpnEgress: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ChartDataPoint {
  timestamp: number;
  downloadRate: number;
  uploadRate: number;
  load1: number;
  load5: number;
  load15: number;
  responseTimes: Record<string, number>; // service name -> response time in ms
  memoryUsage: Record<string, number>; // container name -> memory usage in MB
  torrentRates: Record<string, TorrentRate>;
}

export type TimeResolution = '1h' | '1d' | '1w' | '1m';

export interface HealthData {
  vpn: GluetunProbeResult | { name: string; ok: boolean; running: boolean; healthy: null };
  qbitEgress: QbitEgressProbeResult;
  qbitIngress: QbitIngressInfo | null;
  pfSync: CheckResult | null;
  services: Array<ServiceProbeResult>;
  checks: Array<CheckResult>;
  nets: Array<never>;
  updatedAt: string | null;
  updating: boolean;
  error: string | null;
  gitRef: string;
  torrentRatesEnabled: boolean;
}

export interface CompactChartSeries {
  dataPoints: number;
  timestamps: Array<number>;
  downloadRate: Array<number>;
  uploadRate: Array<number>;
  load1: Array<number>;
  responseTimes: Record<string, Array<number>>; // Quantized to 10ms
  memoryUsage: Record<string, Array<number>>; // Memory in MB
  torrentDownload: Record<string, Array<number>>;
  torrentUpload: Record<string, Array<number>>;
  samples: Array<number>; // Number of raw samples aggregated into each bucket
}

export interface CompactChartData {
  services: Array<string>;
  containers: Array<string>;
  torrents: Array<{ id: string; name: string }>;
  retentionMs: number; // Data retention window in milliseconds
  series: Partial<Record<TimeResolution, CompactChartSeries>>;
}

export interface TorrentRate {
  name: string;
  downloadRate: number;
  uploadRate: number;
}
