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
}

export interface HealthData {
  vpn: GluetunProbeResult | { name: string; ok: boolean; running: boolean; healthy: null };
  qbitEgress: QbitEgressProbeResult;
  services: Array<ServiceProbeResult>;
  checks: Array<CheckResult>;
  nets: Array<never>;
  chartData: Array<ChartDataPoint>;
  updatedAt: string | null;
  updating: boolean;
  error: string | null;
  gitRef: string;
}
