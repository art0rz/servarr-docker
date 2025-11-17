import type { Readable } from 'node:stream';

import { docker, dockerLogger } from './client';

export interface CachedContainer {
  id: string;
  name: string;
  state: string;
  health?: string | null;
  networks: Record<string, { IPAddress?: string }>;
  updatedAt: number;
}

const containerCache = new Map<string, CachedContainer>();
let eventStreamActive = false;

export function getCachedContainer(containerName: string) {
  return containerCache.get(containerName);
}

export async function refreshContainerCache() {
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
    containerCache.delete(containerName);
  }
}

export async function watchDockerEvents() {
  if (eventStreamActive) {
    dockerLogger.debug('Event stream already active');
    return;
  }

  dockerLogger.info('Setting up Docker events stream');
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

        if (['start', 'stop', 'die', 'kill', 'health_status', 'create', 'destroy'].includes(event.Action)) {
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
