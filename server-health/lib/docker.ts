import { exec, ExecOptions } from 'node:child_process';
import { promisify } from 'node:util';

const sh = promisify(exec);

export interface CommandResult {
  ok: boolean;
  out: string;
  err?: string;
}

interface ExecError extends Error {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

/**
 * Execute a shell command
 */
export async function cmd(command: string, opts: ExecOptions = {}): Promise<CommandResult> {
  try {
    const { stdout } = await sh(command, { timeout: 4000, shell: '/bin/sh', ...opts });
    return { ok: true, out: stdout.toString().trim() };
  } catch (e) {
    const error = e as ExecError;
    const stderrText = error.stderr?.toString().trim() ?? '';
    return {
      ok: false,
      out: (error.stdout ?? '').toString().trim(),
      err: stderrText.length > 0 ? stderrText : error.message,
    };
  }
}

/**
 * Inspect a Docker container using Go template
 */
export async function dockerInspect(path: string, containerName: string): Promise<unknown> {
  const query = `docker inspect -f '{{json ${path}}}' ${containerName}`;
  const result = await cmd(query);
  if (!result.ok || result.out.length === 0) return null;
  try {
    return JSON.parse(result.out) as unknown;
  } catch {
    return null;
  }
}

/**
 * Get environment variables from a Docker container
 */
export async function dockerEnvMap(containerName: string): Promise<Record<string, string>> {
  const result = await cmd(`docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${containerName}`);
  if (!result.ok) return {};

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
  [key: string]: unknown;
}

/**
 * Get the IP address of a container on a specific network
 */
export async function getContainerIP(containerName: string, networkName = 'servarr_media'): Promise<string | null> {
  const networks = await dockerInspect('.NetworkSettings.Networks', containerName) as Record<string, DockerNetwork> | null;
  if (networks === null || typeof networks !== 'object') return null;

  // Try the specified network first
  const specifiedNetwork = networks[networkName];
  if (specifiedNetwork?.IPAddress !== undefined) {
    return specifiedNetwork.IPAddress;
  }

  // Fall back to any available network
  for (const net of Object.values(networks)) {
    if (net.IPAddress !== undefined) {
      return net.IPAddress;
    }
  }

  return null;
}

/**
 * Get the egress IP of a container
 */
export async function getEgressIP(containerName: string): Promise<string> {
  const result = await cmd(
    `docker exec ${containerName} sh -c 'busybox wget -qO- https://ifconfig.io || wget -qO- https://ifconfig.io || curl -s https://ifconfig.io'`
  );
  const firstToken = result.ok ? result.out.split(/\s+/)[0] : '';
  return firstToken ?? '';
}
