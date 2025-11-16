import Docker from 'dockerode';

// Create Docker client instance
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export interface CommandResult {
  ok: boolean;
  out: string;
  err?: string;
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

