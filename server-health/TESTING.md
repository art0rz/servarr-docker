# Testing Guide

This project uses [Vitest](https://vitest.dev/) for unit and integration testing.

## Running Tests

```bash
# Run tests in watch mode (interactive)
npm test

# Run tests once and exit
npm run test:run

# Run tests with UI (browser-based test runner)
npm run test:ui

# Run tests with coverage report
npm run test:coverage
```

## Test Structure

Tests are organized alongside the code they test using the `__tests__` directory pattern:

```
lib/
  __tests__/
    config.test.ts          # Configuration file parsing tests
    docker-probes.test.ts   # Docker integration tests
    http-probes.test.ts     # HTTP probe tests
    mocks.ts               # Mock implementations and fixtures
  config.ts
  docker.ts
  probes.ts

src/client/
  __tests__/
    components.test.ts      # Component rendering tests
    data.test.ts           # Data transformation tests
  components.ts
  main.ts
```

## Backend Testing

### Mock Implementations

The project provides mock implementations of all external dependencies in `lib/__tests__/mocks.ts`:

- **MockHttpClient**: Mock HTTP requests and responses
- **MockFileSystem**: Mock file system operations
- **MockDockerClient**: Mock Docker API interactions

### Example: Testing HTTP Probes

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MockHttpClient, fixtures } from './mocks';

describe('Sonarr Probe', () => {
  let mockHttp: MockHttpClient;

  beforeEach(() => {
    mockHttp = new MockHttpClient();
  });

  it('should successfully probe Sonarr', async () => {
    const url = 'http://172.18.0.5:8989';
    mockHttp.setJsonResponse(`${url}/api/v3/system/status`, fixtures.sonarrStatus);

    const response = await mockHttp.get(`${url}/api/v3/system/status`);

    expect(response.ok).toBe(true);
    const data = JSON.parse(response.out);
    expect(data.version).toBe('4.0.0.738');
  });
});
```

### Example: Testing Docker Operations

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MockDockerClient, fixtures } from './mocks';

describe('Gluetun VPN Probe', () => {
  let mockDocker: MockDockerClient;

  beforeEach(() => {
    mockDocker = new MockDockerClient();
  });

  it('should detect running and healthy Gluetun container', async () => {
    mockDocker.setContainers([fixtures.gluetunContainer]);
    mockDocker.setInspectData('/gluetun', fixtures.healthyContainerInspect);

    const containers = await mockDocker.listContainers();
    const gluetun = containers.find(c => c.Names.some(n => n.includes('gluetun')));

    expect(gluetun).toBeDefined();
    expect(gluetun?.State).toBe('running');
  });
});
```

### Example: Testing File System Operations

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MockFileSystem } from './mocks';

describe('Config File Parsing', () => {
  let mockFs: MockFileSystem;

  beforeEach(() => {
    mockFs = new MockFileSystem();
  });

  it('should extract API key from XML config', async () => {
    const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<Config>
  <ApiKey>test-api-key-12345</ApiKey>
</Config>`;

    mockFs.setFile('/config/sonarr/config.xml', xmlContent);
    const content = await mockFs.readFile('/config/sonarr/config.xml', 'utf-8');

    const apiKeyRegex = /<ApiKey>([^<]+)<\/ApiKey>/i;
    const match = apiKeyRegex.exec(content);

    expect(match?.[1]).toBe('test-api-key-12345');
  });
});
```

## Frontend Testing

### Testing Component Rendering

Components are tested by calling the render functions and asserting on the generated HTML:

```typescript
import { describe, it, expect } from 'vitest';
import { renderServiceCard } from '../components';
import type { ServiceProbeResult } from '../types';

describe('renderServiceCard', () => {
  it('should render healthy service', () => {
    const service: ServiceProbeResult = {
      name: 'Sonarr',
      url: 'http://172.18.0.5:8989',
      ok: true,
      version: '4.0.0.738',
      queue: 3,
    };

    const html = renderServiceCard(service);

    expect(html).toContain('Sonarr');
    expect(html).toContain('v4.0.0.738');
    expect(html).toContain('Queue: 3');
    expect(html).toContain('status ok');
  });
});
```

### Testing Data Transformations

Data transformation functions can be tested in isolation:

```typescript
import { describe, it, expect } from 'vitest';
import type { CompactChartData } from '../types';

describe('decompressChartData', () => {
  it('should decompress compact chart data', () => {
    const compact: CompactChartData = {
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      services: ['Sonarr', 'Radarr'],
      containers: ['qbittorrent'],
      series: {
        '1h': {
          dataPoints: 3,
          timestamps: [1700000000000, 1700000001000, 1700000002000],
          downloadRate: [1048576, 2097152, 1572864],
          uploadRate: [524288, 1048576, 786432],
          load1: [0.5, 0.75, 0.6],
          responseTimes: {
            'Sonarr': [10, 12, 11],
            'Radarr': [15, 14, 16],
          },
          memoryUsage: {
            'qbittorrent': [512, 520, 518],
          },
          samples: [1, 1, 1],
        },
      },
    };

    const store = decompressChartData(compact);
    const series = store['1h'] ?? [];

    expect(series).toHaveLength(3);
    expect(series[0]?.point.timestamp).toBe(1700000000000);
    expect(series[0]?.point.downloadRate).toBe(1048576);
  });
});
```

## Test Fixtures

Common test data is available in `lib/__tests__/mocks.ts` under the `fixtures` object:

```typescript
export const fixtures = {
  sonarrStatus: {
    version: '4.0.0.738',
    packageUpdateMechanism: 'docker',
  },
  radarrStatus: { /* ... */ },
  prowlarrStatus: { /* ... */ },
  bazarrStatus: { /* ... */ },
  qbitPreferences: { /* ... */ },
  qbitTransferInfo: { /* ... */ },
  gluetunContainer: { /* ... */ },
  healthyContainerInspect: { /* ... */ },
};
```

## Dependency Injection

The backend uses dependency injection to make code testable. Interfaces are defined in `lib/deps.ts`:

- **HttpClient**: Interface for HTTP requests
- **FileSystem**: Interface for file operations
- **DockerClient**: Interface for Docker operations

Production implementations:
- `FetchHttpClient`: Uses native fetch
- `NodeFileSystem`: Uses Node.js fs/promises
- `DockerodeClient`: Uses dockerode library

Mock implementations are available in `lib/__tests__/mocks.ts`.

## Best Practices

### 1. Use `beforeEach` to Reset Mocks

```typescript
describe('MyTest', () => {
  let mockHttp: MockHttpClient;

  beforeEach(() => {
    mockHttp = new MockHttpClient();
  });

  // Tests...
});
```

### 2. Test Both Success and Failure Cases

```typescript
it('should handle success', async () => {
  mockHttp.setJsonResponse(url, { status: 'ok' });
  // Test success path
});

it('should handle failure', async () => {
  mockHttp.setErrorResponse(url, 'Connection refused');
  // Test error handling
});
```

### 3. Use Type-Safe Fixtures

```typescript
import type { ServiceProbeResult } from '../types';

const service: ServiceProbeResult = {
  name: 'Test',
  ok: true,
};
```

### 4. Test Edge Cases

```typescript
it('should handle empty data', () => {
  const result = decompressChartData({
    startTime: 0,
    interval: 1000,
    dataPoints: 0,
    services: [],
    downloadRate: [],
    uploadRate: [],
    load1: [],
    responseTimes: {},
  });

  expect(result).toHaveLength(0);
});
```

### 5. Verify HTML Escaping

Always test that user-provided content is properly escaped to prevent XSS:

```typescript
it('should escape HTML in service details', () => {
  const service: ServiceProbeResult = {
    name: 'Test<script>alert("xss")</script>',
    ok: false,
  };

  const html = renderServiceCard(service);

  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;');
  expect(html).toContain('&gt;');
});
```

## CI Integration

Tests run automatically in CI. To ensure tests pass before committing:

```bash
npm run check    # Runs linting and type checking
npm run test:run # Runs all tests
```

## Coverage

Generate a coverage report to see which code is tested:

```bash
npm run test:coverage
```

Coverage reports are generated in the `coverage/` directory and include:
- Text summary in terminal
- HTML report in `coverage/index.html`
- JSON report for CI tools

## Debugging Tests

### Run Specific Test File

```bash
npx vitest lib/__tests__/config.test.ts
```

### Run Tests Matching Pattern

```bash
npx vitest -t "Sonarr"
```

### Enable Debug Output

```bash
DEBUG=* npm test
```

### Use Vitest UI for Debugging

```bash
npm run test:ui
```

This opens a browser-based UI where you can:
- See test results visually
- Re-run individual tests
- View source code and console output
- Debug failing tests interactively

## Writing New Tests

1. Create a test file in the `__tests__` directory next to the code you're testing
2. Import the necessary mocks and fixtures from `mocks.ts`
3. Write descriptive test names using the "should" pattern
4. Use `beforeEach` to set up fresh mocks
5. Test both happy path and error cases
6. Verify edge cases and boundary conditions
7. Run tests to ensure they pass

Example template:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MockHttpClient, fixtures } from './mocks';

describe('MyFeature', () => {
  let mockHttp: MockHttpClient;

  beforeEach(() => {
    mockHttp = new MockHttpClient();
  });

  it('should handle success case', async () => {
    // Arrange
    mockHttp.setJsonResponse('/api/endpoint', { result: 'ok' });

    // Act
    const response = await mockHttp.get('/api/endpoint');

    // Assert
    expect(response.ok).toBe(true);
  });

  it('should handle error case', async () => {
    // Arrange
    mockHttp.setErrorResponse('/api/endpoint', 'Server error');

    // Act
    const response = await mockHttp.get('/api/endpoint');

    // Assert
    expect(response.ok).toBe(false);
  });
});
```
