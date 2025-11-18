import type {
  GluetunProbeResult,
  QbitEgressProbeResult,
  SonarrProbeResult,
  ProwlarrProbeResult,
  BazarrProbeResult,
  QbitProbeResult,
  FlareProbeResult,
  CrossSeedProbeResult,
  RecyclarrProbeResult,
  CheckResult,
} from './probes';
import type { ChartStore } from './chart-store';

export type ServiceProbeResult =
  | SonarrProbeResult
  | ProwlarrProbeResult
  | BazarrProbeResult
  | QbitProbeResult
  | FlareProbeResult
  | CrossSeedProbeResult
  | RecyclarrProbeResult;

export interface HealthCache {
  vpn: GluetunProbeResult | { name: string; ok: boolean; running: boolean; healthy: null };
  qbitEgress: QbitEgressProbeResult | null;
  qbitIngress: { hostPort: string; listenPort: number | null } | null;
  pfSync: CheckResult | null;
  services: Array<ServiceProbeResult>;
  checks: Array<CheckResult>;
  nets: Array<never>;
  chartData: ChartStore;
  updatedAt: string | null;
  updating: boolean;
  error: string | null;
  gitRef: string;
  torrentRatesEnabled: boolean;
}

export function createInitialHealthCache(options: {
  useVpn: boolean;
  gitRef: string;
  chartData: ChartStore;
  torrentRatesEnabled: boolean;
}): HealthCache {
  const { useVpn, gitRef, chartData, torrentRatesEnabled } = options;
  return {
    vpn: { name: 'VPN', ok: false, running: false, healthy: null },
    qbitEgress: useVpn
      ? { name: 'qBittorrent egress', container: 'qbittorrent', ok: false, vpnEgress: '' }
      : { name: 'qBittorrent egress', container: 'qbittorrent', ok: true, vpnEgress: 'VPN disabled' },
    qbitIngress: null,
    pfSync: null,
    services: [],
    checks: useVpn ? [] : [{ name: 'VPN status', ok: true, detail: 'disabled (no VPN configured)' }],
    nets: [],
    chartData,
    updatedAt: null,
    updating: true,
    error: 'initializing',
    gitRef,
    torrentRatesEnabled,
  };
}

export function applyHealthUpdate(
  cache: HealthCache,
  partial: Partial<HealthCache>
): {
  cache: HealthCache;
  hasChanges: boolean;
  changedKeys: Array<string>;
} {
  const {
    chartData: _chartData,
    updatedAt: _updatedAt,
    updating: _updating,
    error: _error,
    gitRef: _gitRef,
    ...newData
  } = partial;

  let hasChanges = false;
  const changedKeys: Array<string> = [];

  for (const [key, value] of Object.entries(newData)) {
    const currentValue = cache[key as keyof HealthCache];
    if (JSON.stringify(currentValue) !== JSON.stringify(value)) {
      hasChanges = true;
      changedKeys.push(key);
    }
  }

  const updated: HealthCache = {
    ...cache,
    ...partial,
    updatedAt: new Date().toISOString(),
    updating: false,
    error: partial.error ?? null,
  };

  return { cache: updated, hasChanges, changedKeys };
}
