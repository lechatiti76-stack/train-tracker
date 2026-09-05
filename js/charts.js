// Graphique théorique / réel, étape par étape (Chart.js). Les deux lignes
// sont tracées en heure absolue (comme un graphique horaire ferroviaire) :
// l'écart visuel entre les deux EST le retard/l'avance, en plus d'être
// affiché numériquement ailleurs dans la vignette.
// Chart.js est chargé globalement via <script> dans index.html (UMD),
// et mis en cache par le Service Worker pour un fonctionnement hors-ligne.
import { computeAllStepDelays } from './delay-calc.js';
import { parseHHMM } from './time-utils.js';

function toneColor(diffMin) {
  if (diffMin === null || diffMin === undefined) return '#94a3b8';
  if (diffMin < 0) return '#38bdf8';
  if (Math.abs(diffMin) < 1) return '#22c55e';
  if (diffMin >= 10) return '#ef4444';
  if (diffMin >= 5) return '#f59e0b';
  return '#eab308';
}

// Minutes depuis minuit (0..1439). Ne gère pas l'affichage d'un sillon qui
// franchit minuit sur ce graphique (limite mineure, connue) : le calcul de
// l'écart lui-même (delay-calc.js) reste correct dans ce cas.
function minutesOfDay(hhmm) {
  const parsed = parseHHMM(hhmm);
  return parsed ? parsed.h * 60 + parsed.m : null;
}

function formatMinutesOfDay(v) {
  const total = Math.round(v);
  const h = Math.floor(total / 60) % 24;
  const m = ((total % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function buildChartData(train) {
  const delays = computeAllStepDelays(train);
  const labels = train.steps.map((s) => s.label);
  const theoretical = train.steps.map((s) => minutesOfDay(s.theoretical));
  const real = delays.map((d) => (d.realDate ? d.realDate.getHours() * 60 + d.realDate.getMinutes() : null));
  const diffs = delays.map((d) => (d.status === 'recorded' ? d.diffMin : null));
  const pointColors = diffs.map((v) => toneColor(v));
  return { labels, theoretical, real, pointColors };
}

export function createDelayChart(canvas, train) {
  const { labels, theoretical, real, pointColors } = buildChartData(train);
  const isDark = document.documentElement.classList.contains('theme-dark');
  const gridColor = isDark ? 'rgba(148,163,184,0.15)' : 'rgba(100,116,139,0.15)';
  const textColor = isDark ? '#94a3b8' : '#64748b';
  const theoreticalColor = isDark ? '#8291ac' : '#94a3b8';

  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Réel',
          data: real,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.12)',
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          pointRadius: 5,
          pointHoverRadius: 7,
          borderWidth: 2.5,
          tension: 0.3,
          spanGaps: true,
          fill: false,
        },
        {
          label: 'Théorique',
          data: theoretical,
          borderColor: theoreticalColor,
          backgroundColor: theoreticalColor,
          pointBackgroundColor: theoreticalColor,
          pointBorderColor: theoreticalColor,
          pointRadius: 3,
          borderWidth: 2,
          borderDash: [5, 4],
          tension: 0.3,
          spanGaps: true,
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
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: { color: textColor, boxWidth: 12, usePointStyle: true, font: { size: 10 } },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.raw;
              if (v === null || v === undefined) return `${ctx.dataset.label} : non renseigné`;
              return `${ctx.dataset.label} : ${formatMinutesOfDay(v)}`;
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
          ticks: { color: textColor, font: { size: 10 }, callback: (v) => formatMinutesOfDay(v) },
        },
      },
    },
  });
}

export function updateDelayChart(chart, train) {
  const { labels, theoretical, real, pointColors } = buildChartData(train);
  chart.data.labels = labels;
  chart.data.datasets[0].data = real;
  chart.data.datasets[0].pointBackgroundColor = pointColors;
  chart.data.datasets[0].pointBorderColor = pointColors;
  chart.data.datasets[1].data = theoretical;
  chart.update();
}
