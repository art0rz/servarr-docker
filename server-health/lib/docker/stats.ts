import type { Readable } from 'node:stream';

import { docker, dockerLogger } from './client';

export interface NetworkThroughput {
  downloadBytesPerSec: number;
  uploadBytesPerSec: number;
}

export interface MemoryUsage {
  usedBytes: number;
  limitBytes: number;
  usedPercent: number;
}

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
const STATS_RETRY_DELAY_MS = 5000;

interface RawStatsPayload {
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  memory_stats?: { usage?: number; limit?: number };
}

function scheduleStatsWatcherRestart(containerName: string, delayMs = STATS_RETRY_DELAY_MS) {
  setTimeout(() => { void watchContainerStats(containerName); }, delayMs);
}

function updateStatsCache(containerName: string, stats: RawStatsPayload) {
  let rxBytes = 0;
  let txBytes = 0;

  const networks = stats.networks as unknown;
  if (networks !== null && networks !== undefined && typeof networks === 'object') {
    for (const iface of Object.values(networks as Record<string, { rx_bytes?: number; tx_bytes?: number }>)) {
      rxBytes += iface.rx_bytes ?? 0;
      txBytes += iface.tx_bytes ?? 0;
    }
  }

  const memoryUsageBytes = stats.memory_stats?.usage ?? 0;
  const memoryLimitBytes = stats.memory_stats?.limit ?? 0;

  const now = Date.now();
  const previous = containerStatsCache.get(containerName);

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
      scheduleStatsWatcherRestart(containerName);
    });

    stream.on('end', () => {
      if (buffer.trim().length > 0) {
        processStatsPayload(containerName, buffer);
      }
      activeStatsStreams.delete(containerName);
      scheduleStatsWatcherRestart(containerName, 1000);
    });
  } catch (error) {
    dockerLogger.warn({ err: error, container: containerName }, 'Failed to start stats stream, retrying soon');
    activeStatsStreams.delete(containerName);
    scheduleStatsWatcherRestart(containerName);
  }
}

export function getContainerNetworkThroughput(containerName: string) {
  const cached = containerStatsCache.get(containerName);
  return cached?.throughput ?? null;
}

export function getContainerMemoryUsage(containerName: string) {
  const cached = containerStatsCache.get(containerName);
  if (cached === undefined) {
    return null;
  }
  const usedBytes = cached.memoryUsageBytes;
  const limitBytes = cached.memoryLimitBytes;
  const usedPercent = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;
  return { usedBytes, limitBytes, usedPercent };
}

export function getAllContainerMemoryUsage() {
  const result: Record<string, MemoryUsage> = {};
  for (const [containerName, stats] of containerStatsCache) {
    const usedBytes = stats.memoryUsageBytes;
    const limitBytes = stats.memoryLimitBytes;
    const usedPercent = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;
    result[containerName] = { usedBytes, limitBytes, usedPercent };
  }
  return result;
}

export async function getContainerImageAge(containerName: string) {
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
