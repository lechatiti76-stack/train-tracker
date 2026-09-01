// Graphique d'évolution du retard/avance, étape par étape (Chart.js).
// Chart.js est chargé globalement via <script> dans index.html (UMD),
// et mis en cache par le Service Worker pour un fonctionnement hors-ligne.
import { computeAllStepDelays } from './delay-calc.js';

function toneColor(diffMin) {
  if (diffMin === null || diffMin === undefined) return '#94a3b8';
  if (diffMin < 0) return '#38bdf8';
  if (Math.abs(diffMin) < 1) return '#22c55e';
  if (diffMin >= 10) return '#ef4444';
  if (diffMin >= 5) return '#f59e0b';
  return '#eab308';
}

export function buildChartData(train) {
  const delays = computeAllStepDelays(train);
  const labels = train.steps.map((s) => s.label);
  const data = delays.map((d) => (d.status === 'recorded' ? d.diffMin : null));
  const pointColors = data.map((v) => toneColor(v));
  return { labels, data, pointColors };
}

export function createDelayChart(canvas, train) {
  const { labels, data, pointColors } = buildChartData(train);
  const isDark = document.documentElement.classList.contains('theme-dark');
  const gridColor = isDark ? 'rgba(148,163,184,0.15)' : 'rgba(100,116,139,0.15)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Écart (min)',
          data,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.12)',
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          pointRadius: 5,
          pointHoverRadius: 7,
          borderWidth: 2.5,
          tension: 0.35,
          spanGaps: true,
          fill: true,
        },
        {
          label: 'À l\'heure',
          data: labels.map(() => 0),
          borderColor: gridColor,
          borderDash: [4, 4],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 450, easing: 'easeOutQuart' },
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.datasetIndex === 1) return null;
              const v = ctx.raw;
              if (v === null || v === undefined) return 'Non enregistré';
              if (Math.abs(v) < 1) return "À l'heure";
              return v > 0 ? `Retard : +${v} min` : `Avance : ${v} min`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 10 } },
        },
        y: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 10 }, callback: (v) => `${v} min` },
        },
      },
    },
  });
}

export function updateDelayChart(chart, train) {
  const { labels, data, pointColors } = buildChartData(train);
  chart.data.labels = labels;
  chart.data.datasets[0].data = data;
  chart.data.datasets[0].pointBackgroundColor = pointColors;
  chart.data.datasets[0].pointBorderColor = pointColors;
  chart.data.datasets[1].data = labels.map(() => 0);
  chart.update();
}
