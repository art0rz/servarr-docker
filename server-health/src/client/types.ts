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
  uiHostPort: string;
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
}

export interface HealthData {
  vpn: GluetunProbeResult | { name: string; ok: boolean; running: boolean; healthy: null };
  qbitEgress: QbitEgressProbeResult;
  services: Array<ServiceProbeResult>;
  checks: Array<CheckResult>;
  nets: Array<never>;
  updatedAt: string | null;
  updating: boolean;
  error: string | null;
  gitRef: string;
}

export interface CompactChartData {
  startTime: number;
  interval: number;
  dataPoints: number;
  services: Array<string>;
  downloadRate: Array<number>;
  uploadRate: Array<number>;
  load1: Array<number>;
  responseTimes: Record<string, Array<number>>; // Quantized to 10ms
}
