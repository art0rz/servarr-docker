import { docker } from './client';

export interface CommandResult {
  ok: boolean;
  out: string;
  err?: string;
}

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

export async function getEgressIP(containerName: string) {
  const commands = [
    ['sh', '-c', 'busybox wget -qO- https://ifconfig.io'],
    ['sh', '-c', 'wget -qO- https://ifconfig.io'],
    ['sh', '-c', 'curl -s https://ifconfig.io'],
  ];

  for (const cmd of commands) {
    const result = await execInContainer(containerName, cmd);
    if (result.ok && result.out.length > 0) {
      return result.out.trim();
    }
  }

  return '';
}

export async function readFileFromContainer(containerName: string, filePath: string) {
  const result = await execInContainer(containerName, ['cat', filePath]);
  return result.ok ? result.out : '';
}

export { execInContainer };
