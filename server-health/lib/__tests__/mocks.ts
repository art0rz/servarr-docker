/**
 * Mock implementations for testing
 */

import type {
  HttpClient,
  HttpResponse,
  FileSystem,
  DockerClient,
  ContainerInfo,
  ContainerInspect,
} from '../deps';

// ============================================================================
// Mock HTTP Client
// ============================================================================

export class MockHttpClient implements HttpClient {
  private responses: Map<string, HttpResponse> = new Map();

  setResponse(url: string, response: HttpResponse): void {
    this.responses.set(url, response);
  }

  setJsonResponse(url: string, data: unknown, status = 200): void {
    this.responses.set(url, {
      ok: status >= 200 && status < 300,
      status,
      out: JSON.stringify(data),
    });
  }

  setErrorResponse(url: string, message: string): void {
    this.responses.set(url, {
      ok: false,
      status: 0,
      out: message,
    });
  }

  async get(url: string, _headers?: Record<string, string>): Promise<HttpResponse> {
    const response = this.responses.get(url);
    if (response !== undefined) {
      return response;
    }

    // Default 404 response for unmocked URLs
    return {
      ok: false,
      status: 404,
      out: 'Not Found',
    };
  }

  clear(): void {
    this.responses.clear();
  }
}

// ============================================================================
// Mock File System
// ============================================================================

export class MockFileSystem implements FileSystem {
  private files: Map<string, string> = new Map();

  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  async readFile(path: string, _encoding: BufferEncoding): Promise<string> {
    const content = this.files.get(path);
    if (content !== undefined) {
      return content;
    }
    throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  }

  clear(): void {
    this.files.clear();
  }
}

// ============================================================================
// Mock Docker Client
// ============================================================================

export class MockDockerClient implements DockerClient {
  private containers: ContainerInfo[] = [];
  private inspectData: Map<string, ContainerInspect> = new Map();
  private logs: Map<string, string> = new Map();
  private execResults: Map<string, { out: string; err: string }> = new Map();

  setContainers(containers: ContainerInfo[]): void {
    this.containers = containers;
  }

  setInspectData(name: string, data: ContainerInspect): void {
    this.inspectData.set(name, data);
  }

  setLogs(containerName: string, logs: string): void {
    this.logs.set(containerName, logs);
  }

  setExecResult(containerName: string, cmd: string, result: { out: string; err: string }): void {
    const key = `${containerName}:${cmd}`;
    this.execResults.set(key, result);
  }

  async listContainers(): Promise<ContainerInfo[]> {
    return this.containers;
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const data = this.inspectData.get(id);
    if (data !== undefined) {
      return data;
    }
    throw new Error(`Container ${id} not found`);
  }

  async getContainerLogs(containerName: string, _since?: number): Promise<string> {
    return this.logs.get(containerName) ?? '';
  }

  async execInContainer(
    containerName: string,
    cmd: string[]
  ): Promise<{ out: string; err: string }> {
    const key = `${containerName}:${cmd.join(' ')}`;
    const result = this.execResults.get(key);
    if (result !== undefined) {
      return result;
    }
    return { out: '', err: 'command not mocked' };
  }

  clear(): void {
    this.containers = [];
    this.inspectData.clear();
    this.logs.clear();
    this.execResults.clear();
  }
}

// ============================================================================
// Test Fixtures
// ============================================================================

export const fixtures = {
  sonarrStatus: {
    version: '4.0.0.738',
    packageVersion: '',
    packageAuthor: '',
    packageUpdateMechanism: 'docker',
  },

  radarrStatus: {
    version: '5.2.0.8041',
    packageVersion: '',
    packageAuthor: '',
    packageUpdateMechanism: 'docker',
  },

  prowlarrStatus: {
    version: '1.10.0.4280',
    packageVersion: '',
    packageAuthor: '',
    packageUpdateMechanism: 'docker',
  },

  bazarrStatus: {
    version: '1.4.0',
  },

  qbitPreferences: {
    listen_port: 6881,
  },

  qbitTransferInfo: {
    dl_info_speed: 1048576, // 1 MB/s
    up_info_speed: 524288,  // 512 KB/s
  },

  qbitTorrents: [
    { name: 'Test Torrent 1', state: 'downloading' },
    { name: 'Test Torrent 2', state: 'seeding' },
  ],

  gluetunContainer: {
    Names: ['/gluetun'],
    State: 'running',
    Status: 'Up 2 hours (healthy)',
    Ports: [
      { PublicPort: 8080, PrivatePort: 8000, Type: 'tcp' },
    ],
  },

  healthyContainerInspect: {
    State: {
      Health: {
        Status: 'healthy',
      },
    },
  },
};
