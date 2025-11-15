export const useVpn = () => process.env.USE_VPN === 'true';
export async function discoverServices() {
  return {} as Record<string, string>;
}
export async function loadDashboardConfig() {
  return {
    vpn: null,
    qbitEgress: null,
    services: [],
    checks: [],
    gitRef: ''
  };
}
export async function probeServices(_urls: Record<string, string>) {
  return [] as any[];
}
export async function getIntegrationChecks(_urls: Record<string, string>) {
  return [] as any[];
}
export async function getSystemChecks(_urls: Record<string, string>) {
  return [] as any[];
}
export function updateHistory(_services: any[]) {}
export function getHistorySamples() {
  return [] as any[];
}
