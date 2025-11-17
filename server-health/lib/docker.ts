import Docker from 'dockerode';
import type { Readable } from 'node:stream';
import { readFile, watch as fsWatch } from 'node:fs';
import { promisify } from 'node:util';
import { logger } from './logger';

const readFileAsync = promisify(readFile);

// Create Docker client instance
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Child logger for docker operations
const dockerLogger = logger.child({ component: 'docker' });

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

// Container stats cache (network + memory)
interface ContainerStats {
  rxBytes: number;
  txBytes: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  timestamp: number;
  throughput: NetworkThroughput | null;
}

const containerStatsCache = new Map<string, ContainerStats>();
const activeStatsStreams = new Map<string, boolean>();

export interface NetworkThroughput {
  downloadBytesPerSec: number;
  uploadBytesPerSec: number;
}

export interface MemoryUsage {
  usedBytes: number;
  limitBytes: number;
  usedPercent: number;
}

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

    dockerLogger.info({ count: containerCache.size }, 'Cached containers');
  } catch (error) {
    dockerLogger.error({ err: error }, 'Failed to refresh container cache');
  }
}

/**
 * Watch Docker events and update cache
 */
export async function watchDockerEvents() {
  if (eventStreamActive) {
    dockerLogger.debug('Event stream already active');
    return;
  }

  dockerLogger.info('Setting up Docker events stream');

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
          // Refresh this specific container's info
          if (event.id !== undefined) {
            void updateContainerInCache(event.id, containerName);
          }
        }
      } catch (error) {
        dockerLogger.error({ err: error }, 'Failed to parse event');
      }
    });

    stream.on('error', (error) => {
      dockerLogger.error({ err: error }, 'Event stream error');
      eventStreamActive = false;
      // Reconnect after delay
      setTimeout(() => { void watchDockerEvents(); }, 5000);
    });

    stream.on('end', () => {
      dockerLogger.info('Event stream ended, reconnecting...');
      eventStreamActive = false;
      setTimeout(() => { void watchDockerEvents(); }, 1000);
    });
  } catch (error) {
    dockerLogger.error({ err: error }, 'Failed to start event stream');
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
  } catch {
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
      dockerLogger.info({ port }, 'Gluetun forwarded port updated');
    } else {
      cachedForwardedPort = '';
      dockerLogger.warn('Gluetun forwarded port file contains invalid data');
    }
  } catch {
    // File doesn't exist yet or can't be read
    cachedForwardedPort = '';
  }
}

/**
 * Watch the Gluetun forwarded port file
 */
export async function watchGluetunPort() {
  dockerLogger.info('Setting up Gluetun forwarded port watcher');

  // Initial read
  await readGluetunPort();

  try {
    const watcher = fsWatch(GLUETUN_PORT_FILE, { persistent: false }, (eventType) => {
      if (eventType === 'change') {
        void readGluetunPort();
      }
    });

    watcher.on('error', (error) => {
      dockerLogger.error({ err: error, file: GLUETUN_PORT_FILE }, 'Error watching file');
    });
  } catch (error) {
    dockerLogger.error({ err: error, file: GLUETUN_PORT_FILE }, 'Failed to watch file');
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
 * Watch container stats stream (continuous updates ~1/sec)
 */
const STATS_RETRY_DELAY_MS = 5000;

interface RawStatsPayload {
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  memory_stats?: { usage?: number; limit?: number };
}

function scheduleStatsWatcherRestart(containerName: string, delayMs = STATS_RETRY_DELAY_MS) {
  setTimeout(() => { void watchContainerStats(containerName); }, delayMs);
}

function updateStatsCache(containerName: string, stats: RawStatsPayload) {
  // Extract network stats (sum across all interfaces)
  let rxBytes = 0;
  let txBytes = 0;

  const networks = stats.networks as unknown;
  if (networks !== null && networks !== undefined && typeof networks === 'object') {
    for (const iface of Object.values(networks as Record<string, { rx_bytes?: number; tx_bytes?: number }>)) {
      rxBytes += iface.rx_bytes ?? 0;
      txBytes += iface.tx_bytes ?? 0;
    }
  }

  // Extract memory stats
  const memoryUsageBytes = stats.memory_stats?.usage ?? 0;
  const memoryLimitBytes = stats.memory_stats?.limit ?? 0;

  const now = Date.now();
  const previous = containerStatsCache.get(containerName);

  // Calculate throughput if we have a previous sample
  let throughput: NetworkThroughput | null = null;
  if (previous !== undefined) {
    const elapsedMs = now - previous.timestamp;
    if (elapsedMs > 0) {
      const elapsedSec = elapsedMs / 1000;
      const downloadBytesPerSec = Math.max(0, (rxBytes - previous.rxBytes) / elapsedSec);
      const uploadBytesPerSec = Math.max(0, (txBytes - previous.txBytes) / elapsedSec);

      throughput = { downloadBytesPerSec, uploadBytesPerSec };
    }
  }

  containerStatsCache.set(containerName, {
    rxBytes,
    txBytes,
    memoryUsageBytes,
    memoryLimitBytes,
    timestamp: now,
    throughput,
  });
}

function processStatsPayload(containerName: string, payload: string) {
  const trimmed = payload.trim();
  if (trimmed.length === 0) {
    return;
  }

  try {
    const stats = JSON.parse(trimmed) as RawStatsPayload;
    updateStatsCache(containerName, stats);
  } catch (error) {
    dockerLogger.debug({ err: error, container: containerName, payloadSnippet: payload.slice(0, 80) }, 'Failed to parse stats payload');
  }
}

async function fetchStatsSnapshot(containerName: string): Promise<RawStatsPayload | null> {
  try {
    const container = docker.getContainer(containerName);
    const snapshot = await container.stats({ stream: false }) as unknown;
    if (snapshot === null || snapshot === undefined) {
      return null;
    }

    if (typeof snapshot === 'string') {
      return JSON.parse(snapshot) as RawStatsPayload;
    }

    if (Buffer.isBuffer(snapshot)) {
      return JSON.parse(snapshot.toString()) as RawStatsPayload;
    }

    return snapshot as RawStatsPayload;
  } catch (error) {
    dockerLogger.debug({ err: error, container: containerName }, 'Failed to fetch stats snapshot');
    return null;
  }
}

export async function refreshContainerStats(containerName: string) {
  const snapshot = await fetchStatsSnapshot(containerName);
  if (snapshot === null) {
    dockerLogger.debug({ container: containerName }, 'No stats snapshot available');
    return;
  }
  updateStatsCache(containerName, snapshot);
}

export async function watchContainerStats(containerName: string) {
  // Check if already watching this container
  if (activeStatsStreams.get(containerName) === true) {
    return;
  }

  activeStatsStreams.set(containerName, true);

  try {
    const container = docker.getContainer(containerName);
    const stream = await container.stats({ stream: true }) as Readable;

    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        processStatsPayload(containerName, line);
      }
    });

    stream.on('error', (error) => {
      dockerLogger.error({ err: error, container: containerName }, 'Stats stream error');
      activeStatsStreams.delete(containerName);
      // Reconnect after delay
      scheduleStatsWatcherRestart(containerName);
    });

    stream.on('end', () => {
      if (buffer.trim().length > 0) {
        processStatsPayload(containerName, buffer);
      }
      activeStatsStreams.delete(containerName);
      // Reconnect after short delay
      scheduleStatsWatcherRestart(containerName, 1000);
    });
  } catch (error) {
    dockerLogger.warn({ err: error, container: containerName }, 'Failed to start stats stream, retrying soon');
    activeStatsStreams.delete(containerName);
    scheduleStatsWatcherRestart(containerName);
  }
}

/**
 * Get cached network throughput for a container (bytes/second)
 * Returns null if no stats available or stream hasn't collected 2+ samples yet
 * Note: Call watchContainerStats(containerName) first to start the stats stream
 */
export function getContainerNetworkThroughput(containerName: string): NetworkThroughput | null {
  const cached = containerStatsCache.get(containerName);
  if (cached === undefined) {
    return null;
  }

  return cached.throughput;
}

/**
 * Get cached memory usage for a container
 * Returns null if no stats available
 * Note: Call watchContainerStats(containerName) first to start the stats stream
 */
export function getContainerMemoryUsage(containerName: string): MemoryUsage | null {
  const cached = containerStatsCache.get(containerName);
  if (cached === undefined) {
    return null;
  }

  const usedBytes = cached.memoryUsageBytes;
  const limitBytes = cached.memoryLimitBytes;
  const usedPercent = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;

  return {
    usedBytes,
    limitBytes,
    usedPercent,
  };
}

/**
 * Get memory usage for all watched containers
 */
export function getAllContainerMemoryUsage(): Record<string, MemoryUsage> {
  const result: Record<string, MemoryUsage> = {};

  for (const [containerName, stats] of containerStatsCache) {
    const usedBytes = stats.memoryUsageBytes;
    const limitBytes = stats.memoryLimitBytes;
    const usedPercent = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;

    result[containerName] = {
      usedBytes,
      limitBytes,
      usedPercent,
    };
  }

  return result;
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
