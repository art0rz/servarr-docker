import { Chart, LineController, LineElement, PointElement, LinearScale, TimeScale, Title, Tooltip, Legend, Filler, type ChartConfiguration, type TooltipItem } from 'chart.js';
import 'chartjs-adapter-date-fns';
import type { ChartDataPoint, TimeResolution } from './types';
export type { TimeResolution } from './types';
import { formatScaledRate, prepareChartSeries, DEFAULT_RATE_SCALE } from './chart-data';
import type { RateScale } from './chart-data';

interface TooltipDatasetMeta {
  label?: string;
}

interface TooltipParsedMeta {
  y?: number;
}

// Register Chart.js components
Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Title, Tooltip, Legend, Filler);

let networkChartInstance: Chart | null = null;
let loadChartInstance: Chart | null = null;
let responseTimeChartInstance: Chart | null = null;
let memoryChartInstance: Chart | null = null;

function createChartInstance(
  existing: Chart | null,
  canvasElement: HTMLCanvasElement,
  config: ChartConfiguration
): Chart {
  if (existing !== null) {
    existing.destroy();
  }
  return new Chart(canvasElement, config);
}

let currentRateScale: RateScale = DEFAULT_RATE_SCALE; // Default to MB/s
interface AxisWithOptionalTitle {
  title?: { display?: boolean; text?: string; color?: string };
}

let currentResolution: TimeResolution = '1h';

const serviceColors: Record<string, { border: string; background: string }> = {
  'Sonarr': { border: 'rgb(52, 152, 219)', background: 'rgba(52, 152, 219, 0.2)' },
  'Radarr': { border: 'rgb(241, 196, 15)', background: 'rgba(241, 196, 15, 0.2)' },
  'Prowlarr': { border: 'rgb(230, 126, 34)', background: 'rgba(230, 126, 34, 0.2)' },
  'Bazarr': { border: 'rgb(155, 89, 182)', background: 'rgba(155, 89, 182, 0.2)' },
  'qBittorrent': { border: 'rgb(46, 204, 113)', background: 'rgba(46, 204, 113, 0.2)' },
  'Cross-Seed': { border: 'rgb(231, 76, 60)', background: 'rgba(231, 76, 60, 0.2)' },
  'FlareSolverr': { border: 'rgb(149, 165, 166)', background: 'rgba(149, 165, 166, 0.2)' },
  'Recyclarr': { border: 'rgb(127, 140, 141)', background: 'rgba(127, 140, 141, 0.2)' },
};

const containerColors: Record<string, { border: string; background: string }> = {
  'qbittorrent': { border: 'rgb(46, 204, 113)', background: 'rgba(46, 204, 113, 0.2)' },
  'sonarr': { border: 'rgb(52, 152, 219)', background: 'rgba(52, 152, 219, 0.2)' },
  'radarr': { border: 'rgb(241, 196, 15)', background: 'rgba(241, 196, 15, 0.2)' },
  'prowlarr': { border: 'rgb(230, 126, 34)', background: 'rgba(230, 126, 34, 0.2)' },
  'bazarr': { border: 'rgb(155, 89, 182)', background: 'rgba(155, 89, 182, 0.2)' },
  'cross-seed': { border: 'rgb(231, 76, 60)', background: 'rgba(231, 76, 60, 0.2)' },
  'flaresolverr': { border: 'rgb(149, 165, 166)', background: 'rgba(149, 165, 166, 0.2)' },
  'gluetun': { border: 'rgb(100, 181, 246)', background: 'rgba(100, 181, 246, 0.2)' },
};

type LineChartConfig = ChartConfiguration<'line'>;
type LineTooltipItem = TooltipItem<'line'>;
type TooltipFormatter = (context: LineTooltipItem) => string;

function createTimeScaleOptions() {
  return {
    type: 'time' as const,
    time: {
      displayFormats: {
        minute: 'HH:mm',
        hour: 'HH:mm',
        day: 'MMM d',
      },
    },
    ticks: {
      color: '#c9d1d9',
      maxRotation: 0,
      autoSkip: true,
      autoSkipPadding: 20,
    },
    grid: {
      color: 'rgba(255, 255, 255, 0.1)',
    },
  };
}

function createLinearScaleOptions(title: string) {
  return {
    type: 'linear' as const,
    beginAtZero: true,
    title: {
      display: true,
      text: title,
      color: '#c9d1d9',
    },
    ticks: {
      color: '#c9d1d9',
    },
    grid: {
      color: 'rgba(255, 255, 255, 0.1)',
    },
  };
}

function createTooltipFormatter(formatValue: (value: number) => string): TooltipFormatter {
  return (context: LineTooltipItem) => {
    const meta = context as unknown as {
      dataset?: TooltipDatasetMeta;
      parsed?: TooltipParsedMeta;
    };
    const datasetLabel = typeof meta.dataset?.label === 'string' ? meta.dataset.label : '';
    const parsedY = typeof meta.parsed?.y === 'number' ? meta.parsed.y : undefined;
    if (parsedY === undefined) return datasetLabel;
    const formatted = formatValue(parsedY);
    return `${datasetLabel}: ${formatted}`;
  };
}

function createLineChartConfig(params: {
  datasets: LineChartConfig['data']['datasets'];
  yTitle: string;
  tooltipFormatter: TooltipFormatter;
}): LineChartConfig {
  return {
    type: 'line',
    data: {
      datasets: params.datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      scales: {
        x: createTimeScaleOptions(),
        y: createLinearScaleOptions(params.yTitle),
      },
      plugins: {
        legend: {
          labels: {
            color: '#c9d1d9',
          },
        },
        tooltip: {
          callbacks: {
            label: params.tooltipFormatter,
          },
        },
      },
    },
  };
}

export function initNetworkChart(canvasElement: HTMLCanvasElement) {
  const config = createLineChartConfig({
    datasets: [
      {
        label: `Download (${currentRateScale.unit})`,
        data: [],
        borderColor: 'rgb(75, 192, 192)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 8,
      },
      {
        label: `Upload (${currentRateScale.unit})`,
        data: [],
        borderColor: 'rgb(255, 99, 132)',
        backgroundColor: 'rgba(255, 99, 132, 0.2)',
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 8,
      },
    ],
    yTitle: currentRateScale.unit,
    tooltipFormatter: createTooltipFormatter((value) => `${formatScaledRate(value)} ${currentRateScale.unit}`),
  });
  networkChartInstance = createChartInstance(networkChartInstance, canvasElement, config);
  return networkChartInstance;
}

export function initLoadChart(canvasElement: HTMLCanvasElement) {
  const config = createLineChartConfig({
    datasets: [
      {
        label: 'Load (1m)',
        data: [],
        borderColor: 'rgb(255, 206, 86)',
        backgroundColor: 'rgba(255, 206, 86, 0.2)',
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 8,
      },
    ],
    yTitle: 'Load Average',
    tooltipFormatter: createTooltipFormatter((value) => value.toFixed(2)),
  });
  loadChartInstance = createChartInstance(loadChartInstance, canvasElement, config);
  return loadChartInstance;
}

export function initResponseTimeChart(canvasElement: HTMLCanvasElement) {
  const config = createLineChartConfig({
    datasets: [],
    yTitle: 'Response Time (ms)',
    tooltipFormatter: createTooltipFormatter((value) => `${value.toFixed(0)}ms`),
  });
  responseTimeChartInstance = createChartInstance(responseTimeChartInstance, canvasElement, config);
  return responseTimeChartInstance;
}

export function initMemoryChart(canvasElement: HTMLCanvasElement) {
  const config = createLineChartConfig({
    datasets: [],
    yTitle: 'Memory Usage (MB)',
    tooltipFormatter: createTooltipFormatter((value) => `${value.toFixed(0)} MB`),
  });
  memoryChartInstance = createChartInstance(memoryChartInstance, canvasElement, config);
  return memoryChartInstance;
}

export function setResolution(resolution: TimeResolution) {
  currentResolution = resolution;
}

export function updateCharts(data: Array<ChartDataPoint>) {
  if (networkChartInstance === null || loadChartInstance === null || responseTimeChartInstance === null || memoryChartInstance === null) return;

  const prepared = prepareChartSeries(data, currentResolution);
  const previousScale = currentRateScale;
  currentRateScale = prepared.rateScale;

  // Update network and load charts
  const downloadDataset = networkChartInstance.data.datasets[0];
  const uploadDataset = networkChartInstance.data.datasets[1];
  const loadDataset = loadChartInstance.data.datasets[0];

  if (downloadDataset !== undefined && uploadDataset !== undefined && loadDataset !== undefined) {
    downloadDataset.data = prepared.download;
    uploadDataset.data = prepared.upload;
    downloadDataset.label = `Download (${currentRateScale.unit})`;
    uploadDataset.label = `Upload (${currentRateScale.unit})`;
    loadDataset.data = prepared.load;

    // Update x-axis bounds
    if (networkChartInstance.options.scales?.['x'] !== undefined) {
      networkChartInstance.options.scales['x'].min = prepared.xBounds.min;
      networkChartInstance.options.scales['x'].max = prepared.xBounds.max;
    }
    if (loadChartInstance.options.scales?.['x'] !== undefined) {
      loadChartInstance.options.scales['x'].min = prepared.xBounds.min;
      loadChartInstance.options.scales['x'].max = prepared.xBounds.max;
    }

    const yScale = networkChartInstance.options.scales?.['y'] as AxisWithOptionalTitle | undefined;
    if (yScale !== undefined) {
      if (yScale.title === undefined) {
        yScale.title = { display: true, text: currentRateScale.unit, color: '#c9d1d9' };
      } else {
        yScale.title.text = currentRateScale.unit;
      }
    }

    const unitChanged = previousScale.unit !== currentRateScale.unit;
    if (unitChanged) {
      const previousAnimation = networkChartInstance.options.animation;
      networkChartInstance.options.animation = false;
      networkChartInstance.update();
      networkChartInstance.options.animation = previousAnimation;
    } else {
      networkChartInstance.update('none');
    }
    loadChartInstance.update('none');
  }

  // Update response time chart
  // Create datasets for each service
  const responseTimeDatasets = prepared.services.map(service => {
    const color = serviceColors[service] ?? { border: 'rgb(100, 100, 100)', background: 'rgba(100, 100, 100, 0.2)' };
    return {
      label: service,
      data: prepared.responseTimes[service] ?? [],
      borderColor: color.border,
      backgroundColor: color.background,
      fill: false,
      tension: 0.4,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 8,
    };
  });

  responseTimeChartInstance.data.datasets = responseTimeDatasets;

  // Update x-axis bounds
  if (responseTimeChartInstance.options.scales?.['x'] !== undefined) {
    responseTimeChartInstance.options.scales['x'].min = prepared.xBounds.min;
    responseTimeChartInstance.options.scales['x'].max = prepared.xBounds.max;
  }

  responseTimeChartInstance.update('none');

  // Update memory chart
  // Create datasets for each container
  const memoryDatasets = prepared.containers.map(container => {
    const color = containerColors[container] ?? { border: 'rgb(100, 100, 100)', background: 'rgba(100, 100, 100, 0.2)' };
    return {
      label: container,
      data: prepared.memoryUsage[container] ?? [], // Memory in MB
      borderColor: color.border,
      backgroundColor: color.background,
      fill: false,
      tension: 0.4,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 8,
    };
  });

  memoryChartInstance.data.datasets = memoryDatasets;

  // Update x-axis bounds
  if (memoryChartInstance.options.scales?.['x'] !== undefined) {
    memoryChartInstance.options.scales['x'].min = prepared.xBounds.min;
    memoryChartInstance.options.scales['x'].max = prepared.xBounds.max;
  }

  memoryChartInstance.update('none');
}
