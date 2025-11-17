/**
 * Dependency interfaces for testing and dependency injection
 */

import { readFile } from 'node:fs/promises';
import Docker from 'dockerode';

// ============================================================================
// HTTP Client Interface
// ============================================================================

export interface HttpResponse {
  ok: boolean;
  status: number;
  out: string;
}

export interface HttpClient {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
}

export class FetchHttpClient implements HttpClient {
  async get(url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      });

      const out = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        out,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        out: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// File System Interface
// ============================================================================

export interface FileSystem {
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
}

export class NodeFileSystem implements FileSystem {
  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return await readFile(path, encoding);
  }
}

// ============================================================================
// Docker Client Interface
// ============================================================================

export interface ContainerInfo {
  Names: Array<string>;
  State: string;
  Status: string;
  Ports: Array<{ PublicPort?: number; PrivatePort: number; Type: string }>;
}

export interface ContainerInspect {
  State: {
    Health?: {
      Status: string;
    };
  };
}

export interface DockerClient {
  listContainers(): Promise<Array<ContainerInfo>>;
  inspectContainer(id: string): Promise<ContainerInspect>;
  getContainerLogs(containerName: string, since?: number): Promise<string>;
  execInContainer(containerName: string, cmd: Array<string>): Promise<{ out: string; err: string }>;
}

export class DockerodeClient implements DockerClient {
  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker({ socketPath: '/var/run/docker.sock' });
  }

  async listContainers(): Promise<Array<ContainerInfo>> {
    return (await this.docker.listContainers()) as Array<ContainerInfo>;
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const container = this.docker.getContainer(id);
    return (await container.inspect()) as ContainerInspect;
  }

  async getContainerLogs(containerName: string, since?: number): Promise<string> {
    try {
      const containers = await this.listContainers();
      const target = containers.find(c =>
        c.Names.some(n => n.includes(containerName))
      );

      if (target === undefined) return '';

      const container = this.docker.getContainer(target.Names[0] ?? '');
      const options: Docker.ContainerLogsOptions & { follow: false } = {
        stdout: true,
        stderr: true,
        tail: 1000,
        follow: false,
      };

      if (since !== undefined) {
        options.since = since;
      }

      const stream = await container.logs(options);
      return stream.toString('utf-8');
    } catch {
      return '';
    }
  }

  async execInContainer(
    containerName: string,
    cmd: Array<string>
  ): Promise<{ out: string; err: string }> {
    try {
      const containers = await this.listContainers();
      const target = containers.find(c =>
        c.Names.some(n => n.includes(containerName))
      );

      if (target === undefined) {
        return { out: '', err: 'container not found' };
      }

      const container = this.docker.getContainer(target.Names[0] ?? '');
      const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ hijack: true, stdin: false });
      const chunks: Array<Buffer> = [];

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        stream.on('end', () => { resolve(); });
        stream.on('error', reject);
      });

      const output = Buffer.concat(chunks).toString('utf-8');
      const lines = output.split(/\r?\n/).filter(Boolean);
      const cleaned = lines.map(line => line.replace(/^.{8}/, '')).join('\n');

      return { out: cleaned, err: '' };
    } catch (error) {
      return {
        out: '',
        err: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// Default Instances
// ============================================================================

export const defaultHttpClient = new FetchHttpClient();
export const defaultFileSystem = new NodeFileSystem();
export const defaultDockerClient = new DockerodeClient();
