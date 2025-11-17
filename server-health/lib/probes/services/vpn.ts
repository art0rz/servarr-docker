/**
 * Health probes for VPN services (Gluetun)
 */

import { dockerInspect, dockerEnvMap, getEgressIP, getCachedGluetunPort } from '../../docker';
import type { GluetunProbeResult } from '../types';

/**
 * Probe Gluetun VPN gateway
 */
export async function probeGluetun(): Promise<GluetunProbeResult> {
  const name = 'gluetun';
  const env = await dockerEnvMap(name);
  const pfEnv = env['VPN_PORT_FORWARDING'] ?? env['PORT_FORWARDING'] ?? '';
  const pfExpected = pfEnv.toLowerCase() === 'on';

  // Get cached forwarded port (no need to exec into container)
  const forwardedPort = getCachedGluetunPort();

  const [healthy, running, uiMap, ip] = await Promise.all([
    dockerInspect('.State.Health.Status', name),
    dockerInspect('.State.Running', name),
    dockerInspect(`.NetworkSettings.Ports["8080/tcp"]`, name),
    getEgressIP(name).catch(() => ''),
  ]);

  const healthyStr = typeof healthy === 'string' ? healthy : null;
  const runningBool = running === true;

  interface PortMapping {
    HostPort?: unknown;
  }
  const uiHostPort = Array.isArray(uiMap) && uiMap[0] !== undefined
    ? (typeof (uiMap[0] as PortMapping).HostPort === 'string' ? (uiMap[0] as PortMapping).HostPort as string : '')
    : '';

  return {
    name: 'Gluetun',
    container: name,
    ok: runningBool && healthyStr === 'healthy',
    running: runningBool,
    healthy: healthyStr,
    vpnEgress: ip.length > 0 ? ip : '',
    forwardedPort,
    pfExpected,
    uiHostPort: uiHostPort.length > 0 ? uiHostPort : '',
  };
}
