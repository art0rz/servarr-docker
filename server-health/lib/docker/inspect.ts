import { docker } from './client';
import { getCachedContainer } from './containers';

export async function dockerInspect(path: string, containerName: string) {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();

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

export async function getContainerIP(containerName: string, networkName = 'servarr_media') {
  const cached = getCachedContainer(containerName);
  if (cached !== undefined) {
    const specifiedNetwork = cached.networks[networkName];
    if (specifiedNetwork?.IPAddress !== undefined && specifiedNetwork.IPAddress.length > 0) {
      return specifiedNetwork.IPAddress;
    }
    for (const net of Object.values(cached.networks)) {
      if (net.IPAddress !== undefined && net.IPAddress.length > 0) {
        return net.IPAddress;
      }
    }
  }

  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    const networks = info.NetworkSettings.Networks as Record<string, DockerNetwork>;

    const specifiedNetwork = networks[networkName];
    if (specifiedNetwork?.IPAddress !== undefined && specifiedNetwork.IPAddress.length > 0) {
      return specifiedNetwork.IPAddress;
    }

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
