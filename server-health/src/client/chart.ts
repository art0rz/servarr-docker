import { Chart, LineController, LineElement, PointElement, LinearScale, TimeScale, Title, Tooltip, Legend, Filler, type ChartConfiguration } from 'chart.js';
import 'chartjs-adapter-date-fns';
import type { ChartDataPoint } from './types';

// Register Chart.js components
Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Title, Tooltip, Legend, Filler);

let networkChartInstance: Chart | null = null;
let loadChartInstance: Chart | null = null;
let responseTimeChartInstance: Chart | null = null;

export type TimeResolution = '1h' | '1d' | '1w' | '1m';
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

export function initNetworkChart(canvasElement: HTMLCanvasElement) {
  const config: ChartConfiguration = {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Download (MB/s)',
          data: [],
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          fill: true,
          tension: 0.4,
        },
        {
          label: 'Upload (MB/s)',
          data: [],
          borderColor: 'rgb(255, 99, 132)',
          backgroundColor: 'rgba(255, 99, 132, 0.2)',
          fill: true,
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      scales: {
        x: {
          type: 'time',
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
        },
        y: {
          type: 'linear',
          beginAtZero: true,
          title: {
            display: true,
            text: 'MB/s',
            color: '#c9d1d9',
          },
          ticks: {
            color: '#c9d1d9',
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.1)',
          },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: '#c9d1d9',
          },
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const label = context.dataset.label ?? '';
              const value = context.parsed.y;
              if (value === null) return label;
              return `${label}: ${value.toFixed(2)} MB/s`;
            },
          },
        },
      },
    },
  };

  networkChartInstance = new Chart(canvasElement, config);
  return networkChartInstance;
}

export function initLoadChart(canvasElement: HTMLCanvasElement) {
  const config: ChartConfiguration = {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Load (1m)',
          data: [],
          borderColor: 'rgb(255, 206, 86)',
          backgroundColor: 'rgba(255, 206, 86, 0.2)',
          fill: true,
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      scales: {
        x: {
          type: 'time',
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
        },
        y: {
          type: 'linear',
          beginAtZero: true,
          title: {
            display: true,
            text: 'Load Average',
            color: '#c9d1d9',
          },
          ticks: {
            color: '#c9d1d9',
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.1)',
          },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: '#c9d1d9',
          },
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const label = context.dataset.label ?? '';
              const value = context.parsed.y;
              if (value === null) return label;
              return `${label}: ${value.toFixed(2)}`;
            },
          },
        },
      },
    },
  };

  loadChartInstance = new Chart(canvasElement, config);
  return loadChartInstance;
}

export function initResponseTimeChart(canvasElement: HTMLCanvasElement) {
  const config: ChartConfiguration = {
    type: 'line',
    data: {
      datasets: [],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index',
      },
      scales: {
        x: {
          type: 'time',
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
        },
        y: {
          type: 'linear',
          beginAtZero: true,
          title: {
            display: true,
            text: 'Response Time (ms)',
            color: '#c9d1d9',
          },
          ticks: {
            color: '#c9d1d9',
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.1)',
          },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: '#c9d1d9',
          },
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const label = context.dataset.label ?? '';
              const value = context.parsed.y;
              if (value === null) return label;
              return `${label}: ${value.toFixed(0)}ms`;
            },
          },
        },
      },
    },
  };

  responseTimeChartInstance = new Chart(canvasElement, config);
  return responseTimeChartInstance;
}

function aggregateData(data: Array<ChartDataPoint>, resolution: TimeResolution): Array<ChartDataPoint> {
  if (resolution === '1h') {
    // For 1 hour, use all data points (we have up to 3600)
    return data;
  }

  // Calculate bucket size in seconds
  const bucketSize = resolution === '1d' ? 60 : resolution === '1w' ? 300 : 1800; // 1min, 5min, 30min
  const now = Date.now();
  const timeRange = resolution === '1d' ? 86400000 : resolution === '1w' ? 604800000 : 2592000000; // 1d, 1w, 1m in ms
  const startTime = now - timeRange;

  // Filter data to the time range
  const filteredData = data.filter(point => point.timestamp >= startTime);

  // Group into buckets and aggregate
  const buckets = new Map<number, Array<ChartDataPoint>>();

  for (const point of filteredData) {
    const bucketKey = Math.floor((point.timestamp - startTime) / (bucketSize * 1000));
    const existing = buckets.get(bucketKey);
    if (existing !== undefined) {
      existing.push(point);
    } else {
      buckets.set(bucketKey, [point]);
    }
  }

  // Average each bucket
  const aggregated: Array<ChartDataPoint> = [];
  for (const points of buckets.values()) {
    if (points.length === 0) continue;

    // Aggregate response times
    const allServices = new Set<string>();
    for (const point of points) {
      for (const service of Object.keys(point.responseTimes)) {
        allServices.add(service);
      }
    }
    const avgResponseTimes: Record<string, number> = {};
    for (const service of allServices) {
      const serviceTimes = points.map(p => p.responseTimes[service] ?? 0).filter(t => t > 0);
      avgResponseTimes[service] = serviceTimes.length > 0
        ? serviceTimes.reduce((sum, t) => sum + t, 0) / serviceTimes.length
        : 0;
    }

    const avg = points.reduce((acc, p) => ({
      timestamp: p.timestamp,
      downloadRate: acc.downloadRate + p.downloadRate / points.length,
      uploadRate: acc.uploadRate + p.uploadRate / points.length,
      load1: acc.load1 + p.load1 / points.length,
      load5: acc.load5 + p.load5 / points.length,
      load15: acc.load15 + p.load15 / points.length,
      responseTimes: avgResponseTimes,
    }), { timestamp: points[0]?.timestamp ?? Date.now(), downloadRate: 0, uploadRate: 0, load1: 0, load5: 0, load15: 0, responseTimes: avgResponseTimes });
    aggregated.push(avg);
  }

  return aggregated.sort((a, b) => a.timestamp - b.timestamp);
}

export function setResolution(resolution: TimeResolution) {
  currentResolution = resolution;
}

export function updateCharts(data: Array<ChartDataPoint>) {
  if (networkChartInstance === null || loadChartInstance === null || responseTimeChartInstance === null) return;

  const aggregated = aggregateData(data, currentResolution);

  // Calculate time range for x-axis bounds
  const now = Date.now();
  const timeRange = currentResolution === '1h' ? 3600000 :
                    currentResolution === '1d' ? 86400000 :
                    currentResolution === '1w' ? 604800000 : 2592000000;
  const minTime = now - timeRange;

  // Convert data to Chart.js format with timestamps
  const downloadData = aggregated.map((point) => ({
    x: point.timestamp,
    y: point.downloadRate / 1024 / 1024, // Convert bytes to MB
  }));

  const uploadData = aggregated.map((point) => ({
    x: point.timestamp,
    y: point.uploadRate / 1024 / 1024, // Convert bytes to MB
  }));

  const loadData = aggregated.map((point) => ({
    x: point.timestamp,
    y: point.load1, // 1-minute load average
  }));

  // Update network and load charts
  const downloadDataset = networkChartInstance.data.datasets[0];
  const uploadDataset = networkChartInstance.data.datasets[1];
  const loadDataset = loadChartInstance.data.datasets[0];

  if (downloadDataset !== undefined && uploadDataset !== undefined && loadDataset !== undefined) {
    downloadDataset.data = downloadData;
    uploadDataset.data = uploadData;
    loadDataset.data = loadData;

    // Update x-axis bounds
    if (networkChartInstance.options.scales?.x !== undefined) {
      networkChartInstance.options.scales.x.min = minTime;
      networkChartInstance.options.scales.x.max = now;
    }
    if (loadChartInstance.options.scales?.x !== undefined) {
      loadChartInstance.options.scales.x.min = minTime;
      loadChartInstance.options.scales.x.max = now;
    }

    networkChartInstance.update('none');
    loadChartInstance.update('none');
  }

  // Update response time chart
  const allServices = new Set<string>();
  for (const point of aggregated) {
    for (const service of Object.keys(point.responseTimes)) {
      allServices.add(service);
    }
  }

  // Create datasets for each service
  const responseTimeDatasets = Array.from(allServices).map(service => {
    const color = serviceColors[service] ?? { border: 'rgb(100, 100, 100)', background: 'rgba(100, 100, 100, 0.2)' };
    return {
      label: service,
      data: aggregated.map((point) => ({
        x: point.timestamp,
        y: point.responseTimes[service] ?? 0,
      })),
      borderColor: color.border,
      backgroundColor: color.background,
      fill: false,
      tension: 0.4,
    };
  });

  responseTimeChartInstance.data.datasets = responseTimeDatasets;

  // Update x-axis bounds
  if (responseTimeChartInstance.options.scales?.x !== undefined) {
    responseTimeChartInstance.options.scales.x.min = minTime;
    responseTimeChartInstance.options.scales.x.max = now;
  }

  responseTimeChartInstance.update('none');
}
