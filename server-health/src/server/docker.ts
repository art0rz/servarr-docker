import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const sh = promisify(exec);

function toTrimmedString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export interface CommandResult {
  ok: boolean;
  out: string;
  err?: string;
}

export async function cmd(command: string, opts: Record<string, unknown> = {}): Promise<CommandResult> {
  try {
    const { stdout } = await sh(command, { timeout: 4000, shell: '/bin/sh', ...opts });
    return { ok: true, out: stdout.trim() };
  } catch (error) {
    const err = error as { stdout?: unknown, stderr?: unknown, message?: unknown, };
    return {
      ok: false,
      out: toTrimmedString(err?.stdout),
      err: toTrimmedString(err?.stderr ?? err?.message)
    };
  }
}

export async function dockerInspect(path: string, containerName: string): Promise<unknown> {
  const query = `docker inspect -f '{{json ${path}}}' ${containerName}`;
  const result = await cmd(query);
  if (!result.ok || !result.out) return null;
  try {
    return JSON.parse(result.out);
  } catch {
    return null;
  }
}

export async function dockerEnvMap(containerName: string): Promise<Record<string, string>> {
  const result = await cmd(`docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${containerName}`);
  if (!result.ok || !result.out) return {};
  return result.out.split(/\n+/).reduce<Record<string, string>>((map, line) => {
    const index = line.indexOf('=');
    if (index > 0) {
      map[line.slice(0, index)] = line.slice(index + 1);
    }
    return map;
  }, {});
}

interface DockerNetwork {
  IPAddress?: string;
}

function extractIp(network: unknown): string | null {
  if (typeof network !== 'object' || network === null) return null;
  const candidate = (network as DockerNetwork).IPAddress;
  return typeof candidate === 'string' && candidate ? candidate : null;
}

function isDockerNetworkMap(value: unknown): value is Record<string, DockerNetwork> {
  return typeof value === 'object' && value !== null;
}

export async function getContainerIP(containerName: string, networkName?: string): Promise<string | null> {
  const networks = await dockerInspect('.NetworkSettings.Networks', containerName);
  if (!isDockerNetworkMap(networks)) return null;

  if (networkName) {
    const direct = extractIp(networks[networkName]);
    if (direct) return direct;
  }

  for (const net of Object.values(networks)) {
    const ip = extractIp(net);
    if (ip) return ip;
  }

  return null;
}

export async function getEgressIP(containerName: string): Promise<string> {
  const result = await cmd(
    `docker exec ${containerName} sh -c 'busybox wget -qO- https://ifconfig.io || wget -qO- https://ifconfig.io || curl -s https://ifconfig.io'`
  );
  return result.ok ? result.out.split(/\s+/)[0] : '';
}

export async function getFileMtime(containerName: string, filePath: string): Promise<number | null> {
  const result = await cmd(`docker exec ${containerName} sh -c 'stat -c %Y ${filePath} 2>/dev/null'`);
  if (!result.ok) return null;
  const epoch = parseInt(result.out.trim(), 10);
  return Number.isFinite(epoch) ? epoch * 1000 : null;
}

export interface DiskUsage {
  filesystem: string;
  usedPercent: number | null;
  used: string;
  available: string;
  mount: string;
}

export async function getDiskUsage(containerName: string, path: string): Promise<DiskUsage | null> {
  const result = await cmd(`docker exec ${containerName} sh -c "df -P ${path} 2>/dev/null | tail -1"`);
  if (!result.ok || !result.out.trim()) return null;
  const parts = result.out.trim().split(/\s+/);
  if (parts.length < 6) return null;
  const percent = parseInt(parts[4].replace('%', ''), 10);
  return {
    filesystem: parts[0],
    usedPercent: Number.isFinite(percent) ? percent : null,
    used: parts[2],
    available: parts[3],
    mount: parts[5]
  };
}

export async function getImageCreationDate(containerName: string): Promise<number | null> {
  const imageId = await cmd(`docker inspect -f '{{.Image}}' ${containerName}`);
  if (!imageId.ok || !imageId.out.trim()) return null;
  const created = await cmd(`docker inspect -f '{{.Created}}' ${imageId.out.trim()}`);
  if (!created.ok || !created.out.trim()) return null;
  const timestamp = Date.parse(created.out.trim());
  return Number.isNaN(timestamp) ? null : timestamp;
}
