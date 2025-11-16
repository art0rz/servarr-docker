import { Chart, LineController, LineElement, PointElement, LinearScale, TimeScale, Title, Tooltip, Legend, Filler, type ChartConfiguration } from 'chart.js';
import type { ChartDataPoint } from './types';

// Register Chart.js components
Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Title, Tooltip, Legend, Filler);

let chartInstance: Chart | null = null;

export function initChart(canvasElement: HTMLCanvasElement) {
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
          beginAtZero: true,
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

  chartInstance = new Chart(canvasElement, config);
  return chartInstance;
}

export function updateChart(data: Array<ChartDataPoint>) {
  if (chartInstance === null) return;

  // Convert data to Chart.js format
  const downloadData = data.map((point, index) => ({
    x: index,
    y: point.downloadRate / 1024 / 1024, // Convert bytes to MB
  }));

  const uploadData = data.map((point, index) => ({
    x: index,
    y: point.uploadRate / 1024 / 1024, // Convert bytes to MB
  }));

  const downloadDataset = chartInstance.data.datasets[0];
  const uploadDataset = chartInstance.data.datasets[1];

  if (downloadDataset !== undefined && uploadDataset !== undefined) {
    downloadDataset.data = downloadData;
    uploadDataset.data = uploadData;
    chartInstance.update('none'); // Update without animation for smooth real-time updates
  }
}
