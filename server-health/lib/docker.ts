import Docker from 'dockerode';
import type { Readable } from 'node:stream';
import { readFile, watch as fsWatch } from 'node:fs';
import { promisify } from 'node:util';

const readFileAsync = promisify(readFile);

// Create Docker client instance
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Container state cache
interface CachedContainer {
  id: string;
  name: string;
  state: string;
  health?: string | null;
  networks: Record<string, { IPAddress?: string }>;
  updatedAt: number;
}

const containerCache = new Map<string, CachedContainer>();
let eventStreamActive = false;

// Gluetun forwarded port cache
let cachedForwardedPort = '';
const GLUETUN_PORT_FILE = '/tmp/gluetun/forwarded_port';

export interface CommandResult {
  ok: boolean;
  out: string;
  err?: string;
}

/**
 * Load all containers into cache
 */
async function refreshContainerCache() {
  try {
    const containers = await docker.listContainers({ all: true });

    for (const container of containers) {
      const name = container.Names[0]?.replace(/^\//, '') ?? '';
      if (name.length === 0) continue;

      const fullInfo = await docker.getContainer(container.Id).inspect();
      const networks = fullInfo.NetworkSettings.Networks as Record<string, { IPAddress?: string }>;

      containerCache.set(name, {
        id: container.Id,
        name,
        state: container.State,
        health: fullInfo.State.Health?.Status ?? null,
        networks,
        updatedAt: Date.now(),
      });
    }

    console.log(`[docker] Cached ${containerCache.size} containers`);
  } catch (error) {
    console.error('[docker] Failed to refresh container cache:', error);
  }
}

/**
 * Watch Docker events and update cache
 */
export async function watchDockerEvents() {
  if (eventStreamActive) {
    console.log('[docker] Event stream already active');
    return;
  }

  console.log('[docker] Setting up Docker events stream');

  // Initial cache load
  await refreshContainerCache();

  try {
    const stream = await docker.getEvents({}) as Readable;
    eventStreamActive = true;

    stream.on('data', (chunk: Buffer) => {
      try {
        const event = JSON.parse(chunk.toString()) as {
          Type: string;
          Action: string;
          Actor?: { Attributes?: { name?: string } };
          id?: string;
        };

        if (event.Type !== 'container') return;

        const containerName = event.Actor?.Attributes?.name ?? '';
        if (containerName.length === 0) return;

        // Events we care about: start, stop, die, kill, health_status
        if (['start', 'stop', 'die', 'kill', 'health_status', 'create', 'destroy'].includes(event.Action)) {
          console.log(`[docker] Container event: ${containerName} - ${event.Action}`);

          // Refresh this specific container's info
          if (event.id !== undefined) {
            void updateContainerInCache(event.id, containerName);
          }
        }
      } catch (error) {
        console.error('[docker] Failed to parse event:', error);
      }
    });

    stream.on('error', (error) => {
      console.error('[docker] Event stream error:', error);
      eventStreamActive = false;
      // Reconnect after delay
      setTimeout(() => { void watchDockerEvents(); }, 5000);
    });

    stream.on('end', () => {
      console.log('[docker] Event stream ended, reconnecting...');
      eventStreamActive = false;
      setTimeout(() => { void watchDockerEvents(); }, 1000);
    });
  } catch (error) {
    console.error('[docker] Failed to start event stream:', error);
    eventStreamActive = false;
  }
}

/**
 * Update a specific container in the cache
 */
async function updateContainerInCache(containerId: string, containerName: string) {
  try {
    const fullInfo = await docker.getContainer(containerId).inspect();
    const networks = fullInfo.NetworkSettings.Networks as Record<string, { IPAddress?: string }>;

    containerCache.set(containerName, {
      id: containerId,
      name: containerName,
      state: fullInfo.State.Status,
      health: fullInfo.State.Health?.Status ?? null,
      networks,
      updatedAt: Date.now(),
    });
  } catch (error) {
    // Container might have been removed
    containerCache.delete(containerName);
  }
}

/**
 * Get cached container info
 */
export function getCachedContainer(containerName: string): CachedContainer | undefined {
  return containerCache.get(containerName);
}

/**
 * Read and cache the Gluetun forwarded port
 */
async function readGluetunPort() {
  try {
    const content = await readFileAsync(GLUETUN_PORT_FILE, 'utf-8');
    const port = content.trim();

    // Validate it's a number
    if (/^\d+$/.test(port)) {
      cachedForwardedPort = port;
      console.log(`[docker] Gluetun forwarded port updated: ${port}`);
    } else {
      cachedForwardedPort = '';
      console.log('[docker] Gluetun forwarded port file contains invalid data');
    }
  } catch (error) {
    // File doesn't exist yet or can't be read
    cachedForwardedPort = '';
  }
}

/**
 * Watch the Gluetun forwarded port file
 */
export async function watchGluetunPort() {
  console.log('[docker] Setting up Gluetun forwarded port watcher');

  // Initial read
  await readGluetunPort();

  try {
    const watcher = fsWatch(GLUETUN_PORT_FILE, { persistent: false }, (eventType) => {
      if (eventType === 'change') {
        void readGluetunPort();
      }
    });

    watcher.on('error', (error) => {
      console.error(`[docker] Error watching ${GLUETUN_PORT_FILE}:`, error);
    });
  } catch (error) {
    console.error(`[docker] Failed to watch ${GLUETUN_PORT_FILE}:`, error);
  }
}

/**
 * Get cached Gluetun forwarded port
 */
export function getCachedGluetunPort(): string {
  return cachedForwardedPort;
}

/**
 * Inspect a Docker container and extract a specific property path
 */
export async function dockerInspect(path: string, containerName: string) {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();

    // Parse the path (e.g., ".State.Running" or ".NetworkSettings.Networks")
    const pathParts = path.split('.').filter(p => p.length > 0);

    let result: unknown = info;
    for (const part of pathParts) {
      if (result === null || result === undefined || typeof result !== 'object') return null;
      result = (result as Record<string, unknown>)[part];
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Get environment variables from a Docker container
 */
export async function dockerEnvMap(containerName: string) {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();

    const envVars = info.Config.Env;
    return envVars.reduce<Record<string, string>>((map, envVar) => {
      const index = envVar.indexOf('=');
      if (index > 0) {
        map[envVar.slice(0, index)] = envVar.slice(index + 1);
      }
      return map;
    }, {});
  } catch {
    return {};
  }
}

interface DockerNetwork {
  IPAddress?: string;
  [key: string]: unknown;
}

/**
 * Get the IP address of a container on a specific network
 */
export async function getContainerIP(containerName: string, networkName = 'servarr_media') {
  // Try cache first
  const cached = getCachedContainer(containerName);
  if (cached !== undefined) {
    // Try the specified network first
    const specifiedNetwork = cached.networks[networkName];
    if (specifiedNetwork?.IPAddress !== undefined && specifiedNetwork.IPAddress.length > 0) {
      return specifiedNetwork.IPAddress;
    }

    // Fall back to any available network
    for (const net of Object.values(cached.networks)) {
      if (net.IPAddress !== undefined && net.IPAddress.length > 0) {
        return net.IPAddress;
      }
    }
  }

  // Fallback to direct API call if not in cache
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();

    const networks = info.NetworkSettings.Networks as Record<string, DockerNetwork>;

    // Try the specified network first
    const specifiedNetwork = networks[networkName];
    if (specifiedNetwork?.IPAddress !== undefined && specifiedNetwork.IPAddress.length > 0) {
      return specifiedNetwork.IPAddress;
    }

    // Fall back to any available network
    for (const net of Object.values(networks)) {
      if (net.IPAddress !== undefined && net.IPAddress.length > 0) {
        return net.IPAddress;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Execute a command in a container
 */
async function execInContainer(containerName: string, cmd: Array<string>) {
  try {
    const container = docker.getContainer(containerName);

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return await new Promise<CommandResult>((resolve) => {
      let stdout = '';
      let stderr = '';

      stream.on('data', (chunk: Buffer) => {
        // Docker exec uses multiplexed streams, first 8 bytes are header
        if (chunk.length > 8) {
          const streamType = chunk[0];
          const content = chunk.subarray(8).toString();
          if (streamType === 1) {
            stdout += content;
          } else if (streamType === 2) {
            stderr += content;
          }
        }
      });

      stream.on('end', () => {
        resolve({
          ok: stderr.length === 0,
          out: stdout.trim(),
          err: stderr.trim(),
        });
      });

      stream.on('error', (error: Error) => {
        resolve({
          ok: false,
          out: '',
          err: error.message,
        });
      });
    });
  } catch (error) {
    return {
      ok: false,
      out: '',
      err: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get the egress IP of a container
 */
export async function getEgressIP(containerName: string) {
  // Try multiple methods to get egress IP
  const commands = [
    ['sh', '-c', 'busybox wget -qO- https://ifconfig.io'],
    ['sh', '-c', 'wget -qO- https://ifconfig.io'],
    ['sh', '-c', 'curl -s https://ifconfig.io'],
  ];

  for (const cmd of commands) {
    const result = await execInContainer(containerName, cmd);
    if (result.ok && result.out.length > 0) {
      const firstToken = result.out.split(/\s+/)[0];
      return firstToken ?? '';
    }
  }

  return '';
}

/**
 * Get container logs
 */
export async function getContainerLogs(containerName: string, since?: string) {
  try {
    const container = docker.getContainer(containerName);

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      since: since ?? Math.floor(Date.now() / 1000 - 86400), // Default: last 24h
      timestamps: false,
    });

    return logs.toString();
  } catch {
    return '';
  }
}

/**
 * Read a file from a container
 */
export async function readFileFromContainer(containerName: string, filePath: string) {
  const result = await execInContainer(containerName, ['cat', filePath]);
  return result.ok ? result.out : '';
}

/**
 * Get image creation date for a container
 */
export async function getContainerImageAge(containerName: string): Promise<string | null> {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    const imageId = info.Image;

    const image = docker.getImage(imageId);
    const imageInfo = await image.inspect();

    return imageInfo.Created;
  } catch {
    return null;
  }
}

