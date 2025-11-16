import { Chart, LineController, LineElement, PointElement, LinearScale, TimeScale, Title, Tooltip, Legend, Filler, type ChartConfiguration } from 'chart.js';
import type { ChartDataPoint } from './types';

// Register Chart.js components
Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Title, Tooltip, Legend, Filler);

let networkChartInstance: Chart | null = null;
let loadChartInstance: Chart | null = null;

export type TimeResolution = '1h' | '1d' | '1w' | '1m';
let currentResolution: TimeResolution = '1h';

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
      scales: {
        x: {
          type: 'linear',
          display: false,
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
      scales: {
        x: {
          type: 'linear',
          display: false,
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
    const avg = points.reduce((acc, p) => ({
      timestamp: p.timestamp,
      downloadRate: acc.downloadRate + p.downloadRate / points.length,
      uploadRate: acc.uploadRate + p.uploadRate / points.length,
      load1: acc.load1 + p.load1 / points.length,
      load5: acc.load5 + p.load5 / points.length,
      load15: acc.load15 + p.load15 / points.length,
    }), { timestamp: points[0]?.timestamp ?? Date.now(), downloadRate: 0, uploadRate: 0, load1: 0, load5: 0, load15: 0 });
    aggregated.push(avg);
  }

  return aggregated.sort((a, b) => a.timestamp - b.timestamp);
}

export function setResolution(resolution: TimeResolution) {
  currentResolution = resolution;
}

export function updateCharts(data: Array<ChartDataPoint>) {
  if (networkChartInstance === null || loadChartInstance === null) return;

  const aggregated = aggregateData(data, currentResolution);

  // Convert data to Chart.js format
  const downloadData = aggregated.map((point, index) => ({
    x: index,
    y: point.downloadRate / 1024 / 1024, // Convert bytes to MB
  }));

  const uploadData = aggregated.map((point, index) => ({
    x: index,
    y: point.uploadRate / 1024 / 1024, // Convert bytes to MB
  }));

  const loadData = aggregated.map((point, index) => ({
    x: index,
    y: point.load1, // 1-minute load average
  }));

  const downloadDataset = networkChartInstance.data.datasets[0];
  const uploadDataset = networkChartInstance.data.datasets[1];
  const loadDataset = loadChartInstance.data.datasets[0];

  if (downloadDataset !== undefined && uploadDataset !== undefined && loadDataset !== undefined) {
    downloadDataset.data = downloadData;
    uploadDataset.data = uploadData;
    loadDataset.data = loadData;
    networkChartInstance.update('none'); // Update without animation for smooth real-time updates
    loadChartInstance.update('none');
  }
}
