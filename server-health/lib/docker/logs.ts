import { docker } from './client';

export async function getContainerLogs(containerName: string, since?: string) {
  try {
    const container = docker.getContainer(containerName);

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      since: since ?? Math.floor(Date.now() / 1000 - 86400),
      timestamps: false,
    });

    return logs.toString();
  } catch {
    return '';
  }
}
