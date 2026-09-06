// Assemble une démo mono-fichier (pour publication en Artifact/aperçu rapide)
// à partir des modules ES du vrai projet, en :
//  - supprimant les lignes import/export (un seul <script> global) ;
//  - remplaçant charts.js (Chart.js/CDN) par un mini graphique SVG maison,
//    car l'environnement d'aperçu bloque les scripts externes ;
//  - remplaçant le <canvas> du graphique par un <svg> dans card.js ;
//  - retirant le service worker / l'invite d'installation (non pertinents
//    dans un aperçu en sandbox).
// Le vrai projet (js/*.js séparés, Chart.js, manifest, service worker)
// n'est pas modifié : ce script ne fait que lire ces fichiers.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, '..', '..', 'demo.html');

function readJs(name) {
  let src = fs.readFileSync(path.join(ROOT, 'js', name), 'utf8');
  src = src.replace(/^import .*\n/gm, '');
  src = src.replace(/^export (const|function|class|async function)/gm, '$1');
  return src.trim();
}

const config = readJs('config.js');
const timeUtils = readJs('time-utils.js');
const storage = readJs('storage.js');
const delayCalc = readJs('delay-calc.js');
const sheetsSync = readJs('sheets-sync.js');
const splitflap = readJs('splitflap.js');
const stopwatch = readJs('stopwatch.js');

let card = readJs('card.js');
card = card.replace(
  '<canvas data-role="chart"></canvas>',
  '<svg data-role="chart" viewBox="0 0 300 140" preserveAspectRatio="none" role="img" aria-label="Évolution du retard"></svg>'
);

let app = readJs('app.js');
// Le service worker et l'invite d'installation PWA n'ont pas de sens dans
// un aperçu en sandbox (origine différente à chaque publication).
app = app.replace(/function registerServiceWorker[\s\S]*?\n}\n/, '');
app = app.replace(/registerServiceWorker\(\);\n/, '');
app = app.replace(/function wireInstallPrompt[\s\S]*?\n}\n/, '');
app = app.replace(/wireInstallPrompt\(\);\n/, '');

const chartsDemo = `
// Mini graphique SVG (remplace Chart.js pour cet aperçu autonome, qui ne
// peut pas charger de script externe). Deux lignes en heure absolue
// (théorique / réel), comme la version Chart.js du vrai projet.
function minutesOfDaySvg(hhmm) {
  const parsed = parseHHMM(hhmm);
  return parsed ? parsed.h * 60 + parsed.m : null;
}
function formatMinutesOfDaySvg(v) {
  const total = Math.round(v);
  const h = Math.floor(total / 60) % 24;
  const m = ((total % 60) + 60) % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function buildChartData(train) {
  const delays = computeAllStepDelays(train);
  const labels = train.steps.map((s) => s.label);
  const theoretical = train.steps.map((s) => minutesOfDaySvg(s.theoretical));
  const real = delays.map((d) => (d.realDate ? d.realDate.getHours() * 60 + d.realDate.getMinutes() : null));
  const diffs = delays.map((d) => (d.status === 'recorded' ? d.diffMin : null));
  return { labels, theoretical, real, diffs };
}
function toneColorSvg(diffMin) {
  if (diffMin === null || diffMin === undefined) return '#94a3b8';
  if (diffMin < 0) return '#38bdf8';
  if (Math.abs(diffMin) < 1) return '#22c55e';
  if (diffMin >= 10) return '#ef4444';
  if (diffMin >= 5) return '#f59e0b';
  return '#eab308';
}
function escapeXml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pathFor(values, xScale, yScale) {
  let d = '';
  values.forEach((v, i) => {
    if (v === null || v === undefined) return;
    const x = xScale(i), y = yScale(v);
    d += (d === '' ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
  });
  return d;
}
function drawSvgChart(svgEl, train) {
  const { labels, theoretical, real, diffs } = buildChartData(train);
  const w = 300, h = 150, padL = 30, padR = 8, padT = 10, padB = 18;
  const allValues = [...theoretical, ...real].filter((v) => v !== null && v !== undefined);
  const yMin = allValues.length ? Math.min(...allValues) - 10 : 0;
  const yMax = allValues.length ? Math.max(...allValues) + 10 : 1440;
  const xStep = labels.length > 1 ? (w - padL - padR) / (labels.length - 1) : 0;
  const xScale = (i) => padL + i * xStep;
  const yScale = (v) => padT + (h - padT - padB) * (1 - (v - yMin) / (yMax - yMin || 1));

  const realPath = pathFor(real, xScale, yScale);
  const theoPath = pathFor(theoretical, xScale, yScale);
  let realCircles = '';
  real.forEach((v, i) => {
    if (v === null || v === undefined) return;
    realCircles += \`<circle cx="\${xScale(i).toFixed(1)}" cy="\${yScale(v).toFixed(1)}" r="3.5" fill="\${toneColorSvg(diffs[i])}" stroke="var(--surface)" stroke-width="1"></circle>\`;
  });
  let theoCircles = '';
  theoretical.forEach((v, i) => {
    if (v === null || v === undefined) return;
    theoCircles += \`<circle cx="\${xScale(i).toFixed(1)}" cy="\${yScale(v).toFixed(1)}" r="2.5" fill="currentColor" opacity="0.7"></circle>\`;
  });

  const ticks = labels.map((l, i) => \`<text x="\${xScale(i).toFixed(1)}" y="\${h - 4}" font-size="7" text-anchor="middle" fill="currentColor" opacity="0.65">\${escapeXml(l.slice(0, 6))}</text>\`).join('');
  const yTickCount = 4;
  let yTicks = '';
  for (let t = 0; t <= yTickCount; t++) {
    const v = yMin + ((yMax - yMin) * t) / yTickCount;
    yTicks += \`<text x="2" y="\${(yScale(v) + 3).toFixed(1)}" font-size="6.5" fill="currentColor" opacity="0.6">\${formatMinutesOfDaySvg(v)}</text>\`;
  }

  svgEl.setAttribute('viewBox', \`0 0 \${w} \${h}\`);
  svgEl.innerHTML = \`
    \${yTicks}
    \${theoPath ? \`<path d="\${theoPath}" fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round"/>\` : ''}
    \${realPath ? \`<path d="\${realPath}" fill="none" stroke="#2563eb" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>\` : ''}
    \${theoCircles}
    \${realCircles}
    \${ticks}
  \`;
}
function createDelayChart(svgEl, train) {
  drawSvgChart(svgEl, train);
  return { svgEl, destroy() {} };
}
function updateDelayChart(chart, train) {
  drawSvgChart(chart.svgEl, train);
}
`.trim();

const bundle = [
  '"use strict";',
  '// ---- config.js ----',
  config,
  '// ---- time-utils.js ----',
  timeUtils,
  '// ---- storage.js ----',
  storage,
  '// ---- delay-calc.js ----',
  delayCalc,
  '// ---- sheets-sync.js ----',
  sheetsSync,
  '// ---- splitflap.js ----',
  splitflap,
  '// ---- stopwatch.js ----',
  stopwatch,
  '// ---- charts.js (version SVG autonome pour cet aperçu) ----',
  chartsDemo,
  '// ---- card.js ----',
  card,
  '// ---- app.js ----',
  app,
].join('\n\n');

const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

const html = `<!doctype html>
<title>Suivi Trains — Démo</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${css}

.chart-canvas-holder svg { width: 100%; height: 100%; display: block; color: var(--text-faint); }
.demo-banner {
  max-width: 1600px;
  margin: 0.75rem auto 0;
  padding: 0 1.25rem;
}
.demo-banner p {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.65rem 0.9rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  line-height: 1.5;
}
</style>

<a class="skip-link" href="#mainContent">Aller au contenu</a>

<header class="app-header">
  <div class="app-header-left">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">🚄</span>
      <span class="brand-name">Suivi&nbsp;Trains</span>
    </div>
    <div class="date-clock">
      <span id="currentDateLabel" class="current-date"></span>
      <span id="clock" class="clock" aria-label="Heure actuelle">--:--:--</span>
    </div>
  </div>

  <div class="app-header-right">
    <div class="sync-indicator" title="État de la synchronisation Google Sheets">
      <button type="button" id="btnSyncHeader" class="icon-btn" aria-label="Synchroniser maintenant">
        <span id="syncDot" class="sync-dot sync-none" aria-hidden="true"></span>
      </button>
      <span id="syncLabel" class="sync-label">Google Sheets non configuré</span>
    </div>
    <button type="button" id="btnInstall" class="btn btn-outline" hidden>Installer l'app</button>
    <button type="button" id="btnHistory" class="btn btn-ghost">📅 Calendrier</button>
    <button type="button" id="btnSettings" class="icon-btn" aria-label="Réglages">⚙</button>
    <button type="button" id="btnAddTrain" class="btn btn-primary">+ Ajouter un train</button>
  </div>
</header>

<div class="demo-banner">
  <p>Démo autonome pour test rapide — identique à l'application réelle, à deux différences près propres à cet aperçu : le graphique est ici en SVG simple (pas de Chart.js, bloqué par le bac à sable), et il n'y a pas de PWA/Service Worker. Le projet complet (à publier sur GitHub Pages) est dans l'archive fournie.</p>
</div>

<section class="stopwatch-bar" id="stopwatchWidget" aria-label="Chronomètre de pause">
  <div class="stopwatch-card">
    <div class="stopwatch-title"><span aria-hidden="true">⏱</span> Temps de pause</div>
    <div class="stopwatch-lights" aria-hidden="true">
      <span class="stopwatch-light tone-red" data-role="light-red"></span>
      <span class="stopwatch-light tone-orange" data-role="light-orange"></span>
      <span class="stopwatch-light tone-green" data-role="light-green"></span>
    </div>
    <div class="stopwatch-display" data-role="stopwatch-display" aria-live="polite">00:00:00</div>
    <div class="stopwatch-controls">
      <button type="button" class="btn btn-primary" data-action="stopwatch-start">▶ Démarrer</button>
      <button type="button" class="btn btn-outline" data-action="stopwatch-stop">⏸ Arrêter</button>
      <button type="button" class="btn btn-ghost" data-action="stopwatch-reset">↺ Réinitialiser</button>
    </div>
  </div>
</section>

<main id="mainContent" class="app-main">
  <div id="trainsGrid" class="trains-grid" aria-live="polite"></div>
</main>

<footer class="app-footer">
  <span>Suivi Trains — tableau de bord de suivi ferroviaire.</span>
</footer>

<div id="modalRoot" class="modal-root" aria-hidden="true"></div>
<div id="toastContainer" class="toast-container" aria-live="assertive"></div>

<script>
${bundle}
</script>
`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('Démo générée :', OUT, `(${(html.length / 1024).toFixed(0)} Ko)`);
