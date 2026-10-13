// Point d'entrée de l'application. Gère l'état en mémoire, le rendu et
// tous les événements utilisateur. Les modules importés ne touchent ni au
// DOM (delay-calc, time-utils, storage, sheets-sync) ni à l'état global
// (card, charts, splitflap), ce qui garde ce fichier comme seul chef
// d'orchestre.
import { DELAY_THRESHOLDS, DELAY_THRESHOLDS_DEFAULTS, SHUTTLE_GROUPS, SHUTTLE_DEFAULT_IMMINENT_MIN, ARRIVAL_GROUPS, ARRIVAL_DEFAULT_IMMINENT_MIN, QUICK_TRAIN_OPERATOR_COLORS, DEFAULT_SETTINGS } from './config.js';
import { loadTrains, saveTrains, loadSettings, saveSettings, createEmptyTrain, todayISO, seedDemoTrains, loadShuttles, saveShuttles, loadShuttleReserves, saveShuttleReserves, loadArrivals, saveArrivals } from './storage.js';
import { computeAllStepDelays, computeStepDelay, computeMainCause, computeTrainStatus, applyOffsetSteps, applySillonSequence, suggestCauseForLabel } from './delay-calc.js';
import { formatHHMM, formatHHMMSS, formatDelayLabel, nowLocalISOWithSeconds, parseHHMM, diffMinutes, delayTone, pad2 } from './time-utils.js';
import { fetchTheoreticalFromSheet, mergeSheetRowsIntoTrains, pushStepToSheet, pushAllStepsToSheet, pushShuttleLogToSheet } from './sheets-sync.js';
import { SplitFlapDisplay } from './splitflap.js';
import { createDelayChart, updateDelayChart } from './charts.js';
import { trainCardTemplate, updateCardDynamicParts, escapeHtml, formatCompositionSummary, formatSlotSummary } from './card.js';
import { initStopwatch } from './stopwatch.js';
import { saveArchivePdf, listArchivePdfs, getArchivePdf, deleteArchivePdf, pruneOldArchives } from './archives.js';

let settings = loadSettings();
// Applique les seuils de retard personnalisés (settings.delayThresholds,
// réglables dans Réglages) par-dessus DELAY_THRESHOLDS_DEFAULTS, en
// mutant DELAY_THRESHOLDS en place (voir le commentaire sur cet objet dans
// config.js) : tous les modules qui l'importent (delay-calc.js, card.js)
// voient le changement sans code supplémentaire de leur côté. Un seuil non
// renseigné (null/undefined/<=0) retombe sur la valeur par défaut.
function applyEffectiveDelayThresholds() {
  const override = settings.delayThresholds || {};
  const moderate = Number(override.moderate);
  const severe = Number(override.severe);
  DELAY_THRESHOLDS.onTime = DELAY_THRESHOLDS_DEFAULTS.onTime;
  DELAY_THRESHOLDS.moderate = Number.isFinite(moderate) && moderate > 0 ? moderate : DELAY_THRESHOLDS_DEFAULTS.moderate;
  DELAY_THRESHOLDS.severe = Number.isFinite(severe) && severe > 0 ? severe : DELAY_THRESHOLDS_DEFAULTS.severe;
}
applyEffectiveDelayThresholds();
let trains = loadTrains();
let currentDate = todayISO();
let shuttles = loadShuttles();
// Tableau rapide des départs navettes (à côté des vignettes navettes) : une
// case "Réserve" par famille LF/LN/LA, indépendante des vignettes elles-
// mêmes — voir renderShuttleQuickboard/wireShuttleQuickboard plus bas.
let shuttleReserves = loadShuttleReserves();
let arrivals = loadArrivals();

const chartsByTrainId = new Map();
const flapsByTrainId = new Map();
let deferredInstallPrompt = null;

const el = (id) => document.getElementById(id);

// ---------- Persistance ----------
function persist() {
  saveTrains(trains);
}
function findTrain(id) {
  return trains.find((t) => t.id === id);
}
function getTodayTrains() {
  return trains.filter((t) => t.date === currentDate).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ---------- Thème ----------
function computeIsDark() {
  if (settings.theme === 'dark') return true;
  if (settings.theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme() {
  document.documentElement.classList.toggle('theme-dark', computeIsDark());
}

// ---------- Dates ----------
function formatDateFR(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}
function formatDateLongFR(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const str = new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return str.charAt(0).toUpperCase() + str.slice(1);
}
function updateDateLabel() {
  el('currentDateLabel').textContent = formatDateLongFR(currentDate);
}

// ---------- Toasts ----------
function showToast(message, type = 'success', durationMs = 2600) {
  const container = el('toastContainer');
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.textContent = message;
  container.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 300);
  }, durationMs);
}

// ---------- Rendu de la grille ----------
function destroyAllCharts() {
  for (const chart of chartsByTrainId.values()) chart.destroy();
  chartsByTrainId.clear();
}

function renderGrid() {
  destroyAllCharts();
  flapsByTrainId.clear();
  const grid = el('trainsGrid');
  const todays = getTodayTrains();

  if (todays.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <p>Aucun train pour aujourd'hui (${formatDateFR(currentDate)}).</p>
        <button type="button" class="btn btn-primary" data-action="add-train-empty">+ Ajouter un train</button>
          </div>`;
    renderQuickTrainsBar();
    return;
  }

  grid.innerHTML = todays.map((t) => trainCardTemplate(t, { readOnly: false, destination: getQuickTrainDestination(t.number) })).join('');
  for (const train of todays) mountCardExtras(train);
  renderQuickTrainsBar();
}

// Destination affichée à côté du numéro sur la vignette (ex : "TRAIN 50238 —
// à destination de Vénissieux"), reprise des trains à accès rapide déjà
// configurés dans Réglages (settings.quickTrains) — pas de nouveau champ à
// saisir, juste une lecture par numéro de train.
function getQuickTrainDestination(number) {
  const found = (settings.quickTrains || []).find((t) => t.number === number);
  return found?.destination || null;
}

// Couleur de cadre par opérateur (NAVILAND = violet, FERROVERGNE = orange),
// calculée dynamiquement à partir du champ `operator` — voir
// QUICK_TRAIN_OPERATOR_COLORS dans config.js.
function quickTrainOperatorColor(operator) {
  return QUICK_TRAIN_OPERATOR_COLORS[(operator || '').trim().toUpperCase()] || null;
}

// ---------- Trains à accès rapide (circule / ne circule pas aujourd'hui) ----------
function renderQuickTrainsBar() {
  const container = el('quickTrainsBar');
  if (!container) return;
  const quickTrains = settings.quickTrains || [];
  if (quickTrains.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = quickTrains.map(({ number, operator, destination }) => {
    const exists = trains.some((t) => t.date === currentDate && t.number === number);
    const meta = [operator, destination].filter(Boolean).join(' · ');
    const color = quickTrainOperatorColor(operator);
    return `
      <button type="button" class="btn quick-train-btn ${exists ? 'btn-primary' : 'btn-outline'}${color ? ' has-operator-color' : ''}" ${color ? `style="--quick-train-color:${color}"` : ''} data-quick-train="${escapeHtml(number)}" aria-pressed="${exists}">
        ${meta ? `<span class="quick-train-meta">${escapeHtml(meta)}</span>` : ''}
        <span class="quick-train-number">${exists ? '● ' : '○ '}${escapeHtml(number)}</span>
      </button>`;
  }).join('');
}

function toggleQuickTrain(number) {
  const existing = trains.find((t) => t.date === currentDate && t.number === number);
  if (existing) {
    const hasRecorded = existing.steps.some((s) => s.real);
    if (hasRecorded && !confirm(`Le train ${number} a déjà des heures enregistrées aujourd'hui. Le retirer quand même (ne circule pas) ?`)) return;
    trains = trains.filter((t) => t.id !== existing.id);
    persist();
    renderGrid();
    showToast(`Train ${number} retiré — ne circule pas aujourd'hui`);
    return;
  }
  let maxOrder = trains.reduce((m, t) => Math.max(m, t.order || 0), -1);
  const newTrain = createEmptyTrain({ number, date: currentDate, stepLabels: settings.defaultStepLabels, order: ++maxOrder, source: 'manual' });
  trains.push(newTrain);
  persist();
  renderGrid();
  showToast(`Train ${number} ajouté — circule aujourd'hui`);
}

function wireQuickTrainsBar() {
  const container = el('quickTrainsBar');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick-train]');
    if (btn) toggleQuickTrain(btn.dataset.quickTrain);
  });
}

function mountCardExtras(train) {
  const cardEl = grid_cardEl(train.id);
  if (!cardEl) return;

  const canvas = cardEl.querySelector('[data-role="chart"]');
  chartsByTrainId.set(train.id, createDelayChart(canvas, train));

  const causeFlap = new SplitFlapDisplay(cardEl.querySelector('[data-role="flap-cause"]'), { maxLength: 28, minLength: 10 });
  const amountFlap = new SplitFlapDisplay(cardEl.querySelector('[data-role="flap-amount"]'), { maxLength: 14, minLength: 6 });
  flapsByTrainId.set(train.id, { cause: causeFlap, amount: amountFlap });

  const mainCause = computeMainCause(train);
  causeFlap.setText(mainCause.cause);
  amountFlap.setText(mainCause.amountLabel === '--' ? '' : mainCause.amountLabel);
}

function grid_cardEl(trainId) {
  return document.querySelector(`.train-card[data-train-id="${trainId}"]`);
}

function refreshTrainCard(train) {
  const cardEl = grid_cardEl(train.id);
  if (!cardEl) return;
  updateCardDynamicParts(cardEl, train);

  const chart = chartsByTrainId.get(train.id);
  if (chart) updateDelayChart(chart, train);

  const flaps = flapsByTrainId.get(train.id);
  if (flaps) {
    const mainCause = computeMainCause(train);
    flaps.cause.setText(mainCause.cause);
    flaps.amount.setText(mainCause.amountLabel === '--' ? '' : mainCause.amountLabel);
  }
}

// ---------- Actions sur une vignette ----------
// Réduit/agrandit une vignette (voir train.collapsed, .train-card.is-
// collapsed dans style.css, et trainCardTemplate/updateCardDynamicParts
// dans card.js). Le contenu complet (steps-list, graphique, flap-boards...)
// reste en place dans le DOM, simplement masqué via l'attribut `hidden` :
// refreshTrainCard (updateCardDynamicParts) suffit donc à basculer
// l'affichage, sans recréer le graphique ni les flap-boards.
function setCardCollapsed(train, collapsed) {
  train.collapsed = collapsed;
  persist();
  refreshTrainCard(train);
}

// Une fois la dernière étape ("Départ pour la ligne" par défaut, bouton 7)
// validée, la vignette se réduit automatiquement à une ligne pour
// désencombrer le tableau — voir .train-card.is-collapsed dans style.css.
// Un clic dessus (ou le bouton ▾ de l'en-tête) la ré-ouvre/la réduit à
// nouveau manuellement ensuite.
function maybeCollapseAfterLastStep(train, stepIndex) {
  if (stepIndex === train.steps.length - 1) setCardCollapsed(train, true);
}

// Applique automatiquement la suggestion de cause (même logique que le
// bouton 💡 du formulaire "Modifier", voir suggestCauseForLabel) dès qu'une
// étape est enregistrée ou corrigée et s'avère en retard — sur TOUS les
// trains (nouveaux comme déjà enregistrés), sans avoir besoin de passer par
// "Modifier". N'écrase jamais une cause déjà saisie (manuellement ou par un
// appel précédent de cette fonction) : purement additif.
function maybeAutoSuggestCause(train, stepIndex) {
  const step = train.steps[stepIndex];
  if (!step || step.cause) return;
  const delay = computeStepDelay(train, stepIndex);
  if (delay.status !== 'recorded' || !(delay.diffMin > 0)) return;
  const suggestion = suggestCauseForLabel(step.label);
  if (suggestion) step.cause = suggestion;
}

function recordStepNow(train, stepIndex) {
  const step = train.steps[stepIndex];
  step.real = nowLocalISOWithSeconds();
  maybeAutoSuggestCause(train, stepIndex);
  train.updatedAt = new Date().toISOString();
  persist();
  refreshTrainCard(train);
  pushStepIfConfigured(train, stepIndex);
  showToast(`${step.label} enregistré à ${formatHHMMSS(new Date(step.real))}`);
  maybeCollapseAfterLastStep(train, stepIndex);
}

function resetStepTime(train, stepIndex) {
  if (!confirm("Réinitialiser l'heure enregistrée pour cette étape ?")) return;
  train.steps[stepIndex].real = null;
  train.updatedAt = new Date().toISOString();
  if (stepIndex === train.steps.length - 1 && train.collapsed) {
    train.collapsed = false;
  }
  persist();
  refreshTrainCard(train);
  pushStepIfConfigured(train, stepIndex);
  showToast('Heure réinitialisée');
}

function resetAllStepsForTrain(train) {
  const recordedCount = train.steps.filter((s) => s.real).length;
  if (recordedCount === 0) {
    showToast('Aucune heure enregistrée à réinitialiser');
    return;
  }
  if (!confirm(`Réinitialiser les ${recordedCount} heure(s) enregistrée(s) pour le train ${train.number} ?`)) return;
  train.steps.forEach((s, i) => { s.real = null; pushStepIfConfigured(train, i); });
  train.collapsed = false;
  train.updatedAt = new Date().toISOString();
  persist();
  refreshTrainCard(train);
  showToast('Toutes les heures ont été réinitialisées');
}

function openStepTimeEditor(train, stepIndex) {
  const step = train.steps[stepIndex];
  const current = step.real ? new Date(step.real) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const value = `${pad(current.getHours())}:${pad(current.getMinutes())}:${pad(current.getSeconds())}`;

  openModal({
    title: `Corriger l'heure — ${escapeHtml(step.label)}`,
    bodyHTML: `
      <form id="timeForm" class="stacked-form">
        <label>Heure réelle
          <input type="time" id="fTime" step="1" value="${value}" required>
        </label>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Enregistrer</button>
        </div>
      </form>`,
    onMount: (panel) => {
      panel.querySelector('#timeForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const raw = panel.querySelector('#fTime').value;
        const [h, m, s] = raw.split(':').map(Number);
        const d = new Date(`${train.date}T00:00:00`);
        d.setHours(h || 0, m || 0, s || 0, 0);
        step.real = d.toISOString();
        maybeAutoSuggestCause(train, stepIndex);
        train.updatedAt = new Date().toISOString();
        persist();
        closeModal();
        refreshTrainCard(train);
        pushStepIfConfigured(train, stepIndex);
        showToast('Heure corrigée');
      });
    },
  });
}

// ---------- Composition du train (wagons / poids / longueur / traction) ----------
function openCompositionModal(train) {
  const comp = train.composition || {};
  openModal({
    title: `Composition — Train ${escapeHtml(train.number)}`,
    bodyHTML: `
      <form id="compositionForm" class="stacked-form">
        <label>Nombre de wagons
          <input type="number" id="fCompWagons" min="0" step="1" value="${comp.wagons ?? ''}" placeholder="ex : 18">
        </label>
        <label>Poids (tonnes)
          <input type="number" id="fCompWeight" min="0" step="0.1" value="${comp.weightTons ?? ''}" placeholder="ex : 950">
        </label>
        <label>Longueur (mètres)
          <input type="number" id="fCompLength" min="0" step="1" value="${comp.lengthM ?? ''}" placeholder="ex : 420">
        </label>
        <label>Traction
          <select id="fCompTraction">
            <option value="" ${!comp.traction ? 'selected' : ''}>—</option>
            <option value="electrique" ${comp.traction === 'electrique' ? 'selected' : ''}>Électrique</option>
            <option value="thermique" ${comp.traction === 'thermique' ? 'selected' : ''}>Thermique</option>
          </select>
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" id="btnClearComposition">Effacer</button>
          <button type="submit" class="btn btn-primary">Enregistrer</button>
        </div>
      </form>`,
    onMount: (panel) => {
      panel.querySelector('#compositionForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const wagons = panel.querySelector('#fCompWagons').value.trim();
        const weightTons = panel.querySelector('#fCompWeight').value.trim();
        const lengthM = panel.querySelector('#fCompLength').value.trim();
        const traction = panel.querySelector('#fCompTraction').value;
        const hasAny = wagons || weightTons || lengthM || traction;
        train.composition = hasAny ? {
          wagons: wagons ? Number(wagons) : null,
          weightTons: weightTons ? Number(weightTons) : null,
          lengthM: lengthM ? Number(lengthM) : null,
          traction: traction || null,
        } : null;
        train.updatedAt = new Date().toISOString();
        persist();
        closeModal();
        refreshTrainCard(train);
        showToast('Composition enregistrée');
      });
      panel.querySelector('#btnClearComposition').addEventListener('click', () => {
        train.composition = null;
        train.updatedAt = new Date().toISOString();
        persist();
        closeModal();
        refreshTrainCard(train);
        showToast('Composition effacée');
      });
    },
  });
}

// ---------- "Train complet" / "Train avec slots" (en plus de Composition) ----------
// Bascule à côté du bouton Composition. Un train "complet" suit la
// checklist classique (7 étapes) comme avant. Un train "avec slots" garde
// EN PLUS ces infos (voir openSlotModal ci-dessous) : SLOT TDF/TN/ATL,
// nombre de wagons, heure d'arrivée, heure de recomposition, et surtout
// le départ FA ou LHTE qui décide si la vignette reste suivie ou se réduit.
function setTrainType(train, type) {
  const normalized = type === 'slots' ? 'slots' : 'complet';
  if (train.trainType === normalized) return;
  train.trainType = normalized;
  train.updatedAt = new Date().toISOString();
  if (normalized === 'complet') {
    // Redevenu un train complet classique : les infos SLOT n'ont plus de
    // sens, on les efface. Si la vignette n'était réduite qu'à cause d'un
    // départ FA (pas encore de dernière étape enregistrée), on la rouvre.
    const wasSlotFA = train.slot?.departure === 'FA';
    train.slot = null;
    if (wasSlotFA && !train.steps[train.steps.length - 1]?.real) train.collapsed = false;
  }
  persist();
  refreshTrainCard(train);
  if (normalized === 'slots') openSlotModal(train);
}

// Fenêtre "Infos SLOT" : départ FA = le train complet repart de l'autre
// site ("chez eux") — ce n'est plus la responsabilité de l'utilisateur à
// partir de là, donc la vignette se réduit automatiquement, comme si la
// case 7 ("Départ pour la ligne") avait été validée. Départ LHTE = le train
// repart du site de l'utilisateur ("chez moi") — le suivi complet (7
// étapes + graphique) reste nécessaire ; ces infos s'affichent simplement
// EN PLUS, à côté de Composition (voir trainCardTemplate dans card.js).
function openSlotModal(train) {
  const slot = train.slot || {};
  openModal({
    title: `Infos SLOT — Train ${escapeHtml(train.number)}`,
    bodyHTML: `
      <form id="slotForm" class="stacked-form">
        <label>Type de SLOT
          <select id="fSlotType">
            <option value="" ${!slot.type ? 'selected' : ''}>—</option>
            <option value="TDF" ${slot.type === 'TDF' ? 'selected' : ''}>SLOT TDF</option>
            <option value="TN" ${slot.type === 'TN' ? 'selected' : ''}>SLOT TN</option>
            <option value="ATL" ${slot.type === 'ATL' ? 'selected' : ''}>SLOT ATL</option>
          </select>
        </label>
        <label>Nombre de wagons
          <input type="number" id="fSlotWagons" min="0" step="1" value="${slot.wagons ?? ''}" placeholder="ex : 12">
        </label>
        <label>Heure d'arrivée
          <input type="time" id="fSlotArrival" value="${slot.arrivalTime || ''}">
        </label>
        <label>Heure de recomposition
          <input type="time" id="fSlotRecomposition" value="${slot.recompositionTime || ''}">
        </label>
        <label>Départ
          <select id="fSlotDeparture">
            <option value="" ${!slot.departure ? 'selected' : ''}>—</option>
            <option value="FA" ${slot.departure === 'FA' ? 'selected' : ''}>FA — repart de chez eux (plus géré ici)</option>
            <option value="LHTE" ${slot.departure === 'LHTE' ? 'selected' : ''}>LHTE — repart de chez moi (suivi complet)</option>
          </select>
        </label>
        <p class="help-text">
          FA réduit automatiquement la vignette (comme la case 7) : le train
          repart de l'autre site, vous n'avez plus besoin de le suivre ici.
          LHTE garde le suivi complet (7 étapes + graphique) et affiche ces
          infos SLOT à côté de Composition.
        </p>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" id="btnClearSlot">Effacer</button>
          <button type="submit" class="btn btn-primary">Enregistrer</button>
        </div>
      </form>`,
    onMount: (panel) => {
      panel.querySelector('#slotForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const type = panel.querySelector('#fSlotType').value || null;
        const wagonsRaw = panel.querySelector('#fSlotWagons').value.trim();
        const arrivalTime = panel.querySelector('#fSlotArrival').value || null;
        const recompositionTime = panel.querySelector('#fSlotRecomposition').value || null;
        const departure = panel.querySelector('#fSlotDeparture').value || null;
        train.slot = { type, wagons: wagonsRaw ? Number(wagonsRaw) : null, arrivalTime, recompositionTime, departure };
        train.trainType = 'slots';
        train.updatedAt = new Date().toISOString();
        if (departure === 'FA') train.collapsed = true;
        persist();
        closeModal();
        refreshTrainCard(train);
        showToast(departure === 'FA' ? 'Train SLOT (FA) enregistré — vignette réduite, plus géré ici' : 'Infos SLOT enregistrées');
      });
      panel.querySelector('#btnClearSlot').addEventListener('click', () => {
        const wasSlotFA = train.slot?.departure === 'FA';
        train.slot = null;
        train.trainType = 'complet';
        if (wasSlotFA && !train.steps[train.steps.length - 1]?.real) train.collapsed = false;
        train.updatedAt = new Date().toISOString();
        persist();
        closeModal();
        refreshTrainCard(train);
        showToast('Infos SLOT effacées');
      });
    },
  });
}

function deleteTrain(train) {
  if (!confirm(`Supprimer définitivement le train ${train.number} ?`)) return;
  trains = trains.filter((t) => t.id !== train.id);
  persist();
  renderGrid();
  showToast('Train supprimé');
}

function moveTrain(train, direction) {
  const todays = getTodayTrains();
  const idx = todays.findIndex((t) => t.id === train.id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= todays.length) return;
  const a = todays[idx];
  const b = todays[swapIdx];
  const tmp = a.order ?? idx;
  a.order = b.order ?? swapIdx;
  b.order = tmp;
  persist();
  renderGrid();
}

// ---------- Email "style régulateur ferroviaire" (texte brut, emoji) ----------
// Format demandé : heure en lettres ("14 h 37", pas "14:37"), un petit
// pictogramme coloré par étape (🟢 en avance, ⚪ à l'heure, 🔴 en retard —
// quelle que soit l'ampleur du retard : pas de palier orange ici, le texte
// brut d'un mailto: ne permet aucune couleur réelle, donc on simplifie
// volontairement à 3 états plutôt que de réutiliser les 5 paliers internes),
// et les étapes reliées entre elles par une flèche "↓", comme sur un ordre
// de régulation ferroviaire. Une icône par étape est devinée à partir de
// mots-clés dans son libellé (reconnaît les 7 libellés par défaut, mais
// reste utile sur un libellé personnalisé grâce au repli générique).
function regulatorStepIcon(label) {
  const l = (label || '').toLowerCase();
  if (/conducteur|machine/.test(l)) return '👤';
  if (/mise en t[êe]te/.test(l)) return '🚂';
  if (/signal/.test(l)) return '🟢';
  if (/r[ée]gulateur/.test(l)) return '📻';
  if (/pr[êe]t|annonc|bon au d[ée]part/.test(l)) return '📢';
  if (/arriv[ée]e/.test(l)) return '🚉';
  if (/d[ée]part/.test(l)) return '🚆';
  return '🔹';
}

// Heure en lettres façon régulateur : "14 h 37" plutôt que "14:37".
function formatHeureLettre(date) {
  if (!date) return '--';
  return `${pad2(date.getHours())} h ${pad2(date.getMinutes())}`;
}

function regulatorToneEmoji(tone) {
  if (tone === 'onTime') return '⚪';
  if (tone === 'early') return '🟢';
  if (tone === 'late' || tone === 'moderate' || tone === 'severe') return '🔴';
  return '';
}

// "+04 min" / "-02 min" / "À l'heure" — variante en minuscules du format
// interne (formatDelayLabel renvoie "+04 MIN"/"À L'HEURE" en majuscules,
// utilisé ailleurs dans l'app, notamment la vignette et le mail "classique").
function regulatorEcartTexte(diffMin, onTimeThreshold) {
  if (diffMin === null || diffMin === undefined) return null;
  if (Math.abs(diffMin) < onTimeThreshold) return "À l'heure";
  const sign = diffMin > 0 ? '+' : '-';
  return `${sign}${pad2(Math.abs(diffMin))} min`;
}

function regulatorStepLine(step, delay) {
  const icon = regulatorStepIcon(step.label);
  if (delay.status !== 'recorded') return `${icon} ${step.label} — Non enregistré`;
  const heure = formatHeureLettre(delay.realDate);
  const emoji = regulatorToneEmoji(delay.tone);
  const ecart = regulatorEcartTexte(delay.diffMin, DELAY_THRESHOLDS.onTime);
  return `${icon} ${step.label} — ${heure} ${emoji} ${ecart}`;
}

function buildTrainReportText(train, destination) {
  const delays = computeAllStepDelays(train);
  const status = computeTrainStatus(train);
  const cause = computeMainCause(train);
  const lastIndex = train.steps.length - 1;
  const lastDelay = delays[lastIndex];

  const lines = [
    'Bonjour,',
    trainAnnouncementText(train, destination, delays),
    '',
    `🚆 TRAIN ${train.number}${destination ? ` → ${destination}` : ''}`,
  ];

  lines.push(lastDelay.status === 'recorded'
    ? `Départ effectif : ${formatHeureLettre(lastDelay.realDate)} ${regulatorToneEmoji(lastDelay.tone)} ${regulatorEcartTexte(lastDelay.diffMin, DELAY_THRESHOLDS.onTime)}`
    : 'Départ effectif : — (pas encore enregistré)');

  train.steps.forEach((step, i) => {
    lines.push(regulatorStepLine(step, delays[i]));
    if (i < lastIndex) lines.push('↓');
  });

  lines.push('');
  lines.push(`📅 Date : ${formatDateFR(train.date)}`);

  // Composition (wagons/poids/longueur/traction) : reprise uniquement si
  // elle a été renseignée (bouton "Composition" sur la vignette) — voir
  // openCompositionModal.
  const compositionSummary = formatCompositionSummary(train.composition);
  if (compositionSummary) lines.push(`🚃 Composition : ${compositionSummary}`);

  // Infos SLOT (uniquement pour un train "avec slots", voir openSlotModal) :
  // reprises en plus de la composition ci-dessus, jamais à sa place.
  const slotSummary = train.trainType === 'slots' ? formatSlotSummary(train.slot) : '';
  if (slotSummary) lines.push(`🎰 SLOT : ${slotSummary}`);

  lines.push('');
  lines.push(`⚠ Cause principale : ${cause.cause}${cause.amountLabel && cause.amountLabel !== '--' ? ` (${cause.amountLabel})` : ''}`);
  lines.push(`📊 Statut global : ${status.label}`);
  return lines.join('\n');
}

async function copyTrainData(train) {
  const text = buildTrainReportText(train, getQuickTrainDestination(train.number));
  try {
    await navigator.clipboard.writeText(text);
    showToast('Données copiées ✓');
    return;
  } catch (err) {
    // Repli pour contextes sans Clipboard API.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Données copiées ✓');
  } catch (err) {
    showToast('Impossible de copier automatiquement', 'error');
  }
}

// Étape la plus avancée ayant une heure réelle enregistrée (voir la même
// logique dans computeTrainStatus/delay-calc.js, non exportée telle
// quelle) : c'est elle qui alimente la phrase d'en-tête de l'email stylé
// ("... vient de faire l'étape « X » à ..."), pour rester correcte quel que
// soit l'avancement du train (pas forcément l'arrivée).
function lastRecordedStepInfo(train, delays) {
  for (let i = train.steps.length - 1; i >= 0; i--) {
    if (delays[i].status === 'recorded') return { index: i, step: train.steps[i], delay: delays[i] };
  }
  return null;
}

// ---------- Message de régulation (copie stylée + email Outlook) ----------
// Mise en page inspirée d'un "message de régulation – information
// circulation" : en-tête, phrase d'annonce ("Nous vous annonçons le départ
// du train..."), bloc départ effectif / état, séquence opérationnelle étape
// par étape (heure théorique, heure constatée, écart en pastille colorée),
// résumé + légende, pied de page. Fond clair (pas de fond noir) pour rester
// lisible dans n'importe quelle boîte mail. Tout en tableaux + styles en
// ligne : c'est la seule mise en forme qu'Outlook (moteur Word) respecte.
// Un lien mailto: ne peut transporter qu'un corps en texte brut : la version
// stylée passe donc par le presse-papiers (type MIME text/html), à coller
// avec Ctrl+V dans le corps du mail.
const MAIL_FONT = "font-family:'Segoe UI',Arial,Helvetica,sans-serif;";
const MAIL_INK = '#0f2a5f';
const MAIL_MUTED = '#5b6577';
const MAIL_BORDER = '#d7dce6';
const MAIL_ACCENT = '#1d4ed8';

// 3 états seulement dans le mail (comme la légende) : en avance (vert),
// à l'heure (gris), en retard (rouge), quelle que soit l'ampleur.
function mailEcart(delay) {
  if (!delay || delay.status !== 'recorded' || delay.diffMin === null || delay.diffMin === undefined) {
    return { label: '—', fg: MAIL_MUTED, bg: '#eef1f6', kind: 'none' };
  }
  if (Math.abs(delay.diffMin) < DELAY_THRESHOLDS.onTime) return { label: '0 min', fg: '#334155', bg: '#e2e8f0', kind: 'onTime' };
  if (delay.diffMin < 0) return { label: `-${pad2(delay.diffMin)} min`, fg: '#ffffff', bg: '#15803d', kind: 'early' };
  return { label: `+${pad2(delay.diffMin)} min`, fg: '#ffffff', bg: '#dc2626', kind: 'late' };
}

function mailPill(ecart, size = 13) {
  return `<span style="display:inline-block;padding:4px 10px;border-radius:6px;background:${ecart.bg};color:${ecart.fg};${MAIL_FONT}font-size:${size}px;font-weight:700;white-space:nowrap;">${escapeHtml(ecart.label)}</span>`;
}

// Situation du train pour l'en-tête du message : parti (dernière étape
// enregistrée), en cours (au moins une étape), en attente (aucune).
function trainMailSituation(train, delays) {
  const lastIndex = train.steps.length - 1;
  const last = lastRecordedStepInfo(train, delays);
  const departed = lastIndex >= 0 && delays[lastIndex]?.realDate;
  if (departed) return { kind: 'departed', label: 'PARTI', icon: '✅', color: '#15803d', last: { index: lastIndex, step: train.steps[lastIndex], delay: delays[lastIndex] } };
  if (last) return { kind: 'progress', label: 'EN COURS', icon: '⏳', color: '#d97706', last };
  return { kind: 'waiting', label: 'EN ATTENTE', icon: '🕓', color: MAIL_MUTED, last: null };
}

// Phrase d'annonce en tête du message (texte brut, sans mise en forme).
function trainAnnouncementText(train, destination, delays) {
  const situation = trainMailSituation(train, delays);
  const dest = destination ? ` à destination de ${destination}` : '';
  if (situation.kind === 'departed') {
    const d = situation.last.delay;
    const ecart = mailEcart(d);
    const prevu = train.steps[situation.last.index].theoretical;
    const suffix = ecart.kind === 'onTime' ? ", à l'heure prévue"
      : ecart.kind === 'late' ? `, soit un retard de ${ecart.label}${prevu ? ` (prévu ${prevu})` : ''}`
        : ecart.kind === 'early' ? `, soit une avance de ${ecart.label.slice(1)}${prevu ? ` (prévu ${prevu})` : ''}` : '';
    return `Nous vous annonçons le départ du train N° ${train.number}${dest} à ${formatHHMM(d.realDate)}${suffix}.`;
  }
  if (situation.kind === 'progress') {
    const d = situation.last.delay;
    const ecart = mailEcart(d);
    return `Nous vous informons que le train N° ${train.number}${dest} a effectué l'étape « ${situation.last.step.label} » à ${formatHHMM(d.realDate)}${ecart.kind !== 'none' ? ` (${ecart.label})` : ''}.`;
  }
  return `Nous vous informons du suivi du train N° ${train.number}${dest} : aucune étape n'a encore été enregistrée.`;
}

function buildTrainReportHTML(train, destination) {
  const delays = computeAllStepDelays(train);
  const cause = computeMainCause(train);
  const situation = trainMailSituation(train, delays);
  const compositionSummary = formatCompositionSummary(train.composition);
  const slotSummary = train.trainType === 'slots' ? formatSlotSummary(train.slot) : '';
  const lastIndex = train.steps.length - 1;
  const departDelay = delays[lastIndex];
  const departEcart = mailEcart(departDelay);
  const departPrevu = train.steps[lastIndex]?.theoretical || '--:--';
  const departReel = departDelay?.realDate ? formatHHMM(departDelay.realDate) : '--:--';
  const now = new Date();
  const dateLabel = (() => { const [y, m, d] = train.date.split('-'); return `${d}/${m}/${y}`; })();
  const F = MAIL_FONT;

  // Phrase d'annonce, avec numéro / destination / heure mis en valeur.
  const destHTML = destination ? ` à destination de <strong style="color:${MAIL_ACCENT};">${escapeHtml(destination)}</strong>` : '';
  const numberHTML = `<strong style="color:${MAIL_INK};">N° ${escapeHtml(train.number)}</strong>`;
  let announceHTML;
  if (situation.kind === 'departed') {
    const prevuTxt = departPrevu !== '--:--' ? ` (prévu ${escapeHtml(departPrevu)})` : '';
    const ecartTxt = departEcart.kind === 'onTime' ? ", à l'heure prévue"
      : departEcart.kind === 'late' ? `, soit un retard de ${mailPill(departEcart, 12)}${prevuTxt}`
        : departEcart.kind === 'early' ? `, soit une avance de ${mailPill({ ...departEcart, label: departEcart.label.slice(1) }, 12)}${prevuTxt}` : '';
    announceHTML = `Nous vous annonçons le départ du train ${numberHTML}${destHTML} à <strong style="color:${MAIL_INK};">${escapeHtml(departReel)}</strong>${ecartTxt}.`;
  } else if (situation.kind === 'progress') {
    const e = mailEcart(situation.last.delay);
    announceHTML = `Nous vous informons que le train ${numberHTML}${destHTML} a effectué l'étape « <strong>${escapeHtml(situation.last.step.label)}</strong> » à <strong style="color:${MAIL_INK};">${escapeHtml(formatHHMM(situation.last.delay.realDate))}</strong>${e.kind !== 'none' ? ` ${mailPill(e, 12)}` : ''}.`;
  } else {
    announceHTML = `Nous vous informons du suivi du train ${numberHTML}${destHTML} : aucune étape n'a encore été enregistrée.`;
  }

  const stepsRows = train.steps.map((step, i) => {
    const d = delays[i];
    const e = mailEcart(d);
    const isLast = i === lastIndex;
    const recorded = Boolean(d.realDate);
    const dot = e.kind === 'late' ? '#dc2626' : e.kind === 'early' ? '#15803d' : recorded ? '#16a34a' : '#cbd5e1';
    const iconBg = e.kind === 'late' ? '#fee2e2' : e.kind === 'early' || recorded ? '#dcfce7' : '#eef1f6';
    const labelColor = isLast ? (e.kind === 'late' ? '#dc2626' : MAIL_INK) : '#1f2937';
    const rowBg = isLast ? (e.kind === 'late' ? '#fff5f5' : '#f3f7ff') : '#ffffff';
    const real = recorded ? formatHHMM(d.realDate) : '--:--';
    const realBorder = isLast && e.kind === 'late' ? '#dc2626' : '#c7cfdc';
    return `
      <tr style="background:${rowBg};">
        <td width="18" style="padding:10px 0 10px 14px;border-bottom:1px solid #eef1f6;${F}font-size:16px;color:${dot};">●</td>
        <td width="40" style="padding:8px 6px;border-bottom:1px solid #eef1f6;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="32" height="32" align="center" valign="middle" style="width:32px;height:32px;border-radius:16px;background:${iconBg};font-size:16px;line-height:32px;">${regulatorStepIcon(step.label)}</td></tr></table>
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid #eef1f6;${F}font-size:13px;font-weight:${isLast ? 800 : 600};color:${labelColor};text-transform:uppercase;letter-spacing:.02em;">${escapeHtml(step.label)}</td>
        <td align="center" style="padding:10px 8px;border-bottom:1px solid #eef1f6;${F}font-size:14px;color:${isLast && e.kind === 'late' ? '#dc2626' : '#64748b'};">${escapeHtml(step.theoretical || '--:--')}</td>
        <td align="center" style="padding:8px;border-bottom:1px solid #eef1f6;">
          <span style="display:inline-block;min-width:58px;padding:5px 10px;border:1px solid ${realBorder};border-radius:6px;background:#ffffff;${F}font-size:15px;font-weight:800;color:${isLast && e.kind === 'late' ? '#dc2626' : MAIL_INK};">${escapeHtml(real)}</span>
        </td>
        <td align="center" style="padding:8px 14px 8px 8px;border-bottom:1px solid #eef1f6;">${mailPill(e)}</td>
      </tr>`;
  }).join('');

  const summaryRow = (icon, label, valueHTML) => `
    <tr>
      <td width="26" style="padding:5px 0;${F}font-size:14px;">${icon}</td>
      <td style="padding:5px 6px;${F}font-size:13px;color:#334155;">${label}</td>
      <td style="padding:5px 0;${F}font-size:13px;font-weight:700;color:${MAIL_INK};">${valueHTML}</td>
    </tr>`;
  const causeLabel = cause.cause ? `${escapeHtml(cause.cause)}${cause.amountLabel && cause.amountLabel !== '--' ? ` (${escapeHtml(cause.amountLabel)})` : ''}` : '';

  const legendRow = (ecart, text) => `
    <tr>
      <td width="40" style="padding:4px 0;">${mailPill(ecart, 12)}</td>
      <td style="padding:4px 8px;${F}font-size:13px;color:#334155;">${text}</td>
    </tr>`;

  return `<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%;border:1px solid ${MAIL_BORDER};border-radius:12px;border-collapse:separate;background:#ffffff;${F}">
  <tr>
    <td style="padding:12px 18px;background:#eef4ff;border-bottom:1px solid ${MAIL_BORDER};border-radius:12px 12px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="${F}font-size:12px;font-weight:700;letter-spacing:.05em;color:${MAIL_ACCENT};">📡 MESSAGE DE RÉGULATION – INFORMATION CIRCULATION</td>
        <td align="right" style="${F}font-size:12px;color:${MAIL_MUTED};white-space:nowrap;">Date : ${escapeHtml(dateLabel)} &nbsp;|&nbsp; ${escapeHtml(formatHHMM(now))}</td>
      </tr></table>
    </td>
  </tr>
  <tr>
    <td style="padding:16px 18px 6px;${F}font-size:14px;line-height:1.6;color:#1f2937;">
      Bonjour,<br>${announceHTML}
    </td>
  </tr>
  <tr>
    <td style="padding:10px 18px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${MAIL_BORDER};border-radius:10px;border-collapse:separate;">
        <tr>
          <td valign="middle" style="padding:14px 16px;">
            <div style="${F}font-size:24px;font-weight:800;color:${MAIL_INK};">🚆 TRAIN ${escapeHtml(train.number)}</div>
            ${destination ? `<div style="${F}font-size:14px;font-weight:700;color:${MAIL_ACCENT};margin-top:2px;">→ ${escapeHtml(destination.toUpperCase())}</div>` : ''}
          </td>
          <td valign="middle" style="padding:14px 16px;border-left:1px solid ${MAIL_BORDER};">
            <div style="${F}font-size:11px;font-weight:700;letter-spacing:.06em;color:${MAIL_MUTED};">DÉPART EFFECTIF</div>
            <div style="margin-top:2px;"><span style="${F}font-size:28px;font-weight:800;color:${MAIL_INK};vertical-align:middle;">${escapeHtml(departReel)}</span> ${departEcart.kind !== 'none' ? mailPill(departEcart, 15) : ''}</div>
            <div style="${F}font-size:12px;color:${MAIL_MUTED};margin-top:2px;">PRÉVU : ${escapeHtml(departPrevu)}</div>
          </td>
          <td valign="middle" align="center" style="padding:14px 16px;border-left:1px solid ${MAIL_BORDER};">
            <div style="${F}font-size:11px;font-weight:700;letter-spacing:.06em;color:${MAIL_MUTED};">ÉTAT</div>
            <div style="${F}font-size:20px;font-weight:800;color:${situation.color};margin-top:4px;white-space:nowrap;">${situation.label} ${situation.icon}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:0 18px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${MAIL_BORDER};border-radius:10px;border-collapse:separate;">
        <tr style="background:#f6f8fc;">
          <td colspan="3" style="padding:10px 14px;border-bottom:1px solid ${MAIL_BORDER};${F}font-size:12px;font-weight:800;letter-spacing:.05em;color:${MAIL_ACCENT};">📋 SÉQUENCE OPÉRATIONNELLE</td>
          <td align="center" style="padding:10px 8px;border-bottom:1px solid ${MAIL_BORDER};${F}font-size:11px;font-weight:700;color:${MAIL_MUTED};">HEURE THÉORIQUE</td>
          <td align="center" style="padding:10px 8px;border-bottom:1px solid ${MAIL_BORDER};${F}font-size:11px;font-weight:700;color:${MAIL_MUTED};">HEURE CONSTATÉE</td>
          <td align="center" style="padding:10px 14px 10px 8px;border-bottom:1px solid ${MAIL_BORDER};${F}font-size:11px;font-weight:700;color:${MAIL_MUTED};">ÉCART</td>
        </tr>
        ${stepsRows}
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:0 18px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="56%" valign="top" style="padding:12px 14px;border:1px solid ${MAIL_BORDER};border-radius:10px;">
          <div style="${F}font-size:12px;font-weight:800;letter-spacing:.05em;color:${MAIL_ACCENT};margin-bottom:6px;">RÉSUMÉ CIRCULATION</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${summaryRow('🚆', 'Train', escapeHtml(train.number))}
            ${destination ? summaryRow('📍', 'Destination', escapeHtml(destination)) : ''}
            ${summaryRow('🕒', 'Départ prévu', escapeHtml(departPrevu))}
            ${summaryRow('⏱', 'Départ réel', escapeHtml(departReel))}
            ${summaryRow('📈', 'Écart au départ', departEcart.kind !== 'none' ? mailPill(departEcart, 12) : '—')}
            ${summaryRow('✔', 'Statut', `<span style="color:${situation.color};">${situation.label} ${situation.icon}</span>`)}
            ${causeLabel ? summaryRow('⚠', 'Cause principale', causeLabel) : ''}
            ${compositionSummary ? summaryRow('🚃', 'Composition', escapeHtml(compositionSummary)) : ''}
            ${slotSummary ? summaryRow('🎰', 'SLOT', escapeHtml(slotSummary)) : ''}
          </table>
        </td>
        <td width="12">&nbsp;</td>
        <td valign="top" style="padding:12px 14px;border:1px solid ${MAIL_BORDER};border-radius:10px;">
          <div style="${F}font-size:12px;font-weight:800;letter-spacing:.05em;color:${MAIL_ACCENT};margin-bottom:6px;">LÉGENDE</div>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            ${legendRow({ label: '-', fg: '#ffffff', bg: '#15803d' }, 'En avance')}
            ${legendRow({ label: '0', fg: '#334155', bg: '#e2e8f0' }, "À l'heure")}
            ${legendRow({ label: '+', fg: '#ffffff', bg: '#dc2626' }, 'En retard')}
          </table>
          <div style="${F}font-size:12px;font-weight:800;letter-spacing:.05em;color:${MAIL_ACCENT};margin:10px 0 4px;">INFORMATION</div>
          <div style="${F}font-size:12px;line-height:1.5;color:${MAIL_MUTED};">Les écarts sont calculés par rapport à l'horaire théorique.<br>Heure affichée : HH:MM</div>
        </td>
      </tr></table>
    </td>
  </tr>
  <tr>
    <td style="padding:12px 18px;background:#f6f8fc;border-top:1px solid ${MAIL_BORDER};border-radius:0 0 12px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="${F}font-size:12px;color:${MAIL_MUTED};"><strong style="color:${MAIL_ACCENT};letter-spacing:.04em;">🛡 SERVICE RÉGULATION</strong><br>Merci de ne pas répondre à ce message.</td>
        <td align="right" style="${F}font-size:12px;font-weight:800;letter-spacing:.06em;color:${MAIL_INK};">LHTE<br><span style="font-weight:400;letter-spacing:0;color:${MAIL_MUTED};">Le Havre Terminal Exploitation</span></td>
      </tr></table>
    </td>
  </tr>
</table>`;
}

// Écrit le message dans le presse-papiers en version riche (HTML, pour
// Outlook/Gmail...) + texte brut de secours. Renvoie true si la version
// riche a pu être copiée.
async function writeRichClipboard(html, text) {
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return true;
    }
  } catch (err) {
    // Copie riche indisponible/refusée (ancien navigateur, contexte non
    // sécurisé...) : l'appelant se replie sur le texte brut.
  }
  return false;
}

async function copyTrainDataStyled(train) {
  const destination = getQuickTrainDestination(train.number);
  const ok = await writeRichClipboard(buildTrainReportHTML(train, destination), buildTrainReportText(train, destination));
  if (ok) {
    showToast('Message stylé copié ✓ (collez-le dans votre email)');
    return;
  }
  await copyTrainData(train);
}

// ---------- Destinataires des emails (Réglages) ----------
// Par train à accès rapide : champs "À" et "Cci" (destinataires
// invisibles). Un champ laissé vide reprend la liste par défaut
// (Réglages → "Destinataires par défaut"). Adresses séparées par ; , ou
// des espaces — ressorties séparées par ";" (format accepté par Outlook).
function normalizeRecipients(raw) {
  return (raw || '')
    .split(/[;,\s]+/)
    .map((a) => a.trim())
    .filter((a) => a.includes('@'))
    .join(';');
}

function getTrainRecipients(number) {
  const quickTrain = (settings.quickTrains || []).find((t) => t.number === number);
  const to = normalizeRecipients(quickTrain?.mailTo) || normalizeRecipients(settings.mailDefaultTo);
  const bcc = normalizeRecipients(quickTrain?.mailBcc) || normalizeRecipients(settings.mailDefaultBcc);
  return { to, bcc };
}

function encodeMailAddresses(list) {
  return list.split(';').filter(Boolean).map((a) => encodeURIComponent(a).replace(/%40/g, '@')).join(';');
}

function trainMailSubject(train, destination) {
  const delays = computeAllStepDelays(train);
  const situation = trainMailSituation(train, delays);
  const dest = destination ? ` → ${destination}` : '';
  if (situation.kind === 'departed') {
    const e = mailEcart(situation.last.delay);
    return `Départ train ${train.number}${dest} — ${formatHHMM(situation.last.delay.realDate)}${e.kind !== 'none' ? ` (${e.kind === 'onTime' ? "à l'heure" : e.label})` : ''}`;
  }
  return `Suivi train ${train.number}${dest} — ${formatDateFR(train.date)}`;
}

// Bouton "Email" : copie le message stylé dans le presse-papiers puis ouvre
// la messagerie (Outlook) avec destinataires, Cci et objet déjà remplis —
// il ne reste qu'à cliquer dans le corps du mail, Ctrl+V, puis Envoyer. Si
// la copie riche est impossible, le texte brut est mis directement dans le
// corps du mail à la place.
async function emailTrainData(train) {
  const destination = getQuickTrainDestination(train.number);
  const text = buildTrainReportText(train, destination);
  const copied = await writeRichClipboard(buildTrainReportHTML(train, destination), text);
  const { to, bcc } = getTrainRecipients(train.number);
  const params = [`subject=${encodeURIComponent(trainMailSubject(train, destination))}`];
  if (bcc) params.push(`bcc=${encodeMailAddresses(bcc)}`);
  if (!copied) params.push(`body=${encodeURIComponent(text)}`);
  window.location.href = `mailto:${encodeMailAddresses(to)}?${params.join('&')}`;
  if (copied) {
    showToast('Message stylé copié ✓ — dans Outlook, cliquez dans le corps du mail puis Ctrl+V', 'success', 7000);
  } else if (!to) {
    showToast('Aucun destinataire réglé pour ce train (Réglages → Trains à accès rapide)', 'error');
  }
}

// ---------- Délégation d'événements sur la grille ----------
function onGridClick(e) {
  const emptyBtn = e.target.closest('[data-action="add-train-empty"]');
  if (emptyBtn) {
    openTrainModal(null);
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const cardEl = btn.closest('.train-card');
  if (!cardEl) return;
  const train = findTrain(cardEl.dataset.trainId);
  if (!train) return;
  const stepRow = btn.closest('[data-step-index]');
  const stepIndex = stepRow ? Number(stepRow.dataset.stepIndex) : null;

  switch (btn.dataset.action) {
    case 'record-step': recordStepNow(train, stepIndex); break;
    case 'edit-step-time': openStepTimeEditor(train, stepIndex); break;
    case 'reset-step-time': resetStepTime(train, stepIndex); break;
    case 'reset-all-steps': resetAllStepsForTrain(train); break;
    case 'copy-train': copyTrainData(train); break;
    case 'copy-html-train': copyTrainDataStyled(train); break;
    case 'email-train': emailTrainData(train); break;
    case 'edit-train': openTrainModal(train); break;
    case 'delete-train': deleteTrain(train); break;
    case 'move-left': moveTrain(train, -1); break;
    case 'move-right': moveTrain(train, 1); break;
    case 'apply-sillon': {
      const input = cardEl.querySelector('[data-role="sillon-time"]');
      applySillonQuickFill(train, input?.value);
      break;
    }
    case 'open-composition': openCompositionModal(train); break;
    case 'set-train-type': setTrainType(train, btn.dataset.type); break;
    case 'open-slot': openSlotModal(train); break;
    case 'collapse-card': setCardCollapsed(train, true); break;
    case 'expand-card': setCardCollapsed(train, false); break;
    default: break;
  }
}

function wireSillonInputs(grid) {
  grid.addEventListener('change', (e) => {
    const input = e.target.closest('[data-role="sillon-time"]');
    if (!input) return;
    const cardEl = input.closest('.train-card');
    const train = findTrain(cardEl?.dataset.trainId);
    if (!train) return;
    train.sillonTime = input.value || null;
    persist();
  });
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('[data-role="sillon-time"]');
    if (!input) return;
    e.preventDefault();
    const cardEl = input.closest('.train-card');
    const train = findTrain(cardEl?.dataset.trainId);
    if (train) applySillonQuickFill(train, input.value);
  });
}

function applySillonQuickFill(train, sillonTime) {
  if (!sillonTime) return;
  applySillonSequence(train, sillonTime, settings.sillonStepOffsets);
  train.sillonTime = sillonTime;
  train.updatedAt = new Date().toISOString();
  persist();
  refreshTrainCard(train);
  const statusEl = grid_cardEl(train.id)?.querySelector('[data-role="sillon-status"]');
  if (statusEl) {
    statusEl.textContent = 'Les 7 heures théoriques ont été calculées ✓';
    statusEl.className = 'sillon-lookup-status status-ok';
  }
  showToast('Les 7 heures théoriques ont été calculées');
}

function wireDragAndDrop(grid) {
  grid.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('[data-action="drag-handle"]');
    if (!handle) { e.preventDefault(); return; }
    const card = handle.closest('.train-card');
    e.dataTransfer.setData('text/plain', card.dataset.trainId);
    e.dataTransfer.effectAllowed = 'move';
  });
  grid.addEventListener('dragover', (e) => {
    if (e.target.closest('.train-card')) e.preventDefault();
  });
  grid.addEventListener('drop', (e) => {
    e.preventDefault();
    const targetCard = e.target.closest('.train-card');
    if (!targetCard) return;
    const draggedId = e.dataTransfer.getData('text/plain');
    const targetId = targetCard.dataset.trainId;
    if (!draggedId || draggedId === targetId) return;
    const a = findTrain(draggedId);
    const b = findTrain(targetId);
    if (!a || !b) return;
    const tmp = a.order ?? 0;
    a.order = b.order ?? 0;
    b.order = tmp;
    persist();
    renderGrid();
  });
}

// ---------- Modales génériques ----------
function openModal({ title, bodyHTML, onMount, wide = false }) {
  const root = el('modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal"></div>
    <div class="modal-panel ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-header">
        <h2>${title}</h2>
        <button type="button" class="icon-btn modal-close" data-action="close-modal" aria-label="Fermer">✕</button>
      </div>
      <div class="modal-body">${bodyHTML}</div>
    </div>`;
  root.classList.add('open');
  document.body.classList.add('modal-open');
  root.querySelectorAll('[data-action="close-modal"]').forEach((elm) => elm.addEventListener('click', closeModal));
  document.addEventListener('keydown', onModalKeydown);
  if (onMount) onMount(root.querySelector('.modal-panel'));
}
function closeModal() {
  const root = el('modalRoot');
  root.classList.remove('open');
  root.innerHTML = '';
  document.body.classList.remove('modal-open');
  document.removeEventListener('keydown', onModalKeydown);
}
function onModalKeydown(e) {
  if (e.key === 'Escape') closeModal();
}

// ---------- Modale Ajouter / Modifier un train ----------
function trainFormBodyHTML(train) {
  const stepLabels = train ? train.steps.map((s) => s.label) : settings.defaultStepLabels;
  const stepTheo = train ? train.steps.map((s) => s.theoretical || '') : Array(stepLabels.length).fill('');
  const stepCause = train ? train.steps.map((s) => s.cause || '') : Array(stepLabels.length).fill('');
  const stepOffset = train ? train.steps.map((s) => (s.offsetMinutes ?? '')) : Array(stepLabels.length).fill('');

  return `
    <form id="trainForm" class="stacked-form">
      <div class="form-row">
        <label>Numéro de train
          <input type="text" id="fNumber" required value="${escapeHtml(train?.number || '')}" placeholder="ex : 1234" inputmode="numeric">
        </label>
        <label>Date de circulation
          <input type="date" id="fDate" required value="${train?.date || currentDate}">
        </label>
      </div>
      ${train ? '' : `
        <div id="extraDatesContainer" class="extra-dates"></div>
        <button type="button" class="btn btn-ghost btn-sm" id="btnAddDateRow">+ Ajouter une autre date de circulation</button>
        <p class="help-text">Un train qui circule sur plusieurs dates précises crée une vignette indépendante par date (chacune garde ses propres heures réelles). Pour un train qui circule chaque semaine les mêmes jours, préférez la synchronisation Google Sheets (section 6 du README).</p>
      `}
      <p class="help-text">
        "Décalage / Départ (min)" est optionnel : si renseigné pour une
        étape, son heure théorique est calculée automatiquement à partir de
        celle du Départ (négatif pour une étape de préparation avant le
        départ, positif pour une étape après) et le champ "Heure théorique"
        de cette étape est ignoré.
      </p>
      <div class="steps-form-list">
        ${stepLabels.map((label, i) => `
          <fieldset class="step-form-row">
            <legend>Étape ${i + 1}${i === 0 ? ' (référence)' : ''}</legend>
            <label>Libellé
              <input type="text" class="fStepLabel" data-i="${i}" value="${escapeHtml(label)}" required>
            </label>
            <label>Heure théorique
              <input type="time" class="fStepTheo" data-i="${i}" value="${stepTheo[i]}">
            </label>
            <label>Décalage / Départ (min)
              <input type="number" class="fStepOffset" data-i="${i}" value="${stepOffset[i]}" placeholder="ex : -91" ${i === 0 ? 'disabled' : ''}>
            </label>
            <label>Cause (si retard)
              <span class="cause-input-row">
                <input type="text" class="fStepCause" data-i="${i}" value="${escapeHtml(stepCause[i])}" placeholder="ex : Signalisation">
                <button type="button" class="icon-btn fStepCauseSuggestBtn" data-i="${i}" data-label="${escapeHtml(label)}" title="Suggérer une cause à partir du libellé de l'étape" aria-label="Suggérer une cause">💡</button>
              </span>
            </label>
          </fieldset>`).join('')}
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">${train ? 'Enregistrer les modifications' : 'Ajouter le train'}</button>
      </div>
    </form>`;
}

function sortedByIndex(list) {
  return [...list].sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i));
}

function addDateRow(container) {
  const row = document.createElement('div');
  row.className = 'date-row-extra';
  row.innerHTML = `
    <input type="date" class="fDateExtra" required value="${currentDate}">
    <button type="button" class="icon-btn" data-action="remove-date-row" aria-label="Retirer cette date">✕</button>`;
  container.appendChild(row);
}

function openTrainModal(train) {
  openModal({
    title: train ? `Modifier le train ${escapeHtml(train.number)}` : 'Ajouter un train',
    wide: true,
    bodyHTML: trainFormBodyHTML(train),
    onMount: (panel) => {
      panel.querySelector('#trainForm').addEventListener('submit', (e) => {
        e.preventDefault();
        saveTrainForm(panel, train);
      });
      panel.querySelectorAll('.fStepCauseSuggestBtn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = Number(btn.dataset.i);
          const fieldset = btn.closest('.step-form-row');
          const labelInput = fieldset?.querySelector('.fStepLabel');
          const causeInput = fieldset?.querySelector('.fStepCause');
          if (!causeInput) return;
          const suggestion = suggestCauseForLabel(labelInput?.value || btn.dataset.label);
          if (!suggestion) return;
          causeInput.value = suggestion;
          // Enregistre tout de suite (sans attendre le clic sur "Enregistrer
          // les modifications") : uniquement possible pour un train déjà
          // existant, puisqu'un train en cours de création n'existe pas
          // encore en mémoire tant que le formulaire n'a pas été soumis.
          if (train && train.steps[i]) {
            train.steps[i].cause = suggestion;
            train.updatedAt = new Date().toISOString();
            persist();
            refreshTrainCard(train);
            pushStepIfConfigured(train, i);
            showToast(`Cause « ${suggestion} » enregistrée pour ${train.steps[i].label}`);
          }
        });
      });
      const addDateBtn = panel.querySelector('#btnAddDateRow');
      const extraDatesContainer = panel.querySelector('#extraDatesContainer');
      if (addDateBtn && extraDatesContainer) {
        addDateBtn.addEventListener('click', () => addDateRow(extraDatesContainer));
        extraDatesContainer.addEventListener('click', (e) => {
          const removeBtn = e.target.closest('[data-action="remove-date-row"]');
          if (removeBtn) removeBtn.closest('.date-row-extra').remove();
        });
      }
    },
  });
}

function saveTrainForm(panel, existingTrain) {
  const number = panel.querySelector('#fNumber').value.trim();
  const primaryDate = panel.querySelector('#fDate').value;
  if (!number || !primaryDate) return;

  const labels = sortedByIndex([...panel.querySelectorAll('.fStepLabel')]).map((i) => i.value.trim());
  const theos = sortedByIndex([...panel.querySelectorAll('.fStepTheo')]).map((i) => i.value);
  const causes = sortedByIndex([...panel.querySelectorAll('.fStepCause')]).map((i) => i.value.trim());
  const offsets = sortedByIndex([...panel.querySelectorAll('.fStepOffset')]).map((i) => (i.value.trim() === '' ? null : Number(i.value)));

  const applyStepFields = (train) => {
    train.steps.forEach((step, i) => {
      step.label = labels[i] || step.label;
      step.cause = causes[i] || '';
      step.offsetMinutes = i === 0 ? null : offsets[i];
      // Une étape avec décalage voit son heure théorique recalculée depuis
      // le Départ (via applyOffsetSteps ci-dessous) : le champ saisi ici
      // n'est utilisé que si aucun décalage n'est défini.
      if (step.offsetMinutes === null) step.theoretical = theos[i] || null;
    });
    applyOffsetSteps(train);
  };

  let createdCount = 0;
  if (existingTrain) {
    existingTrain.number = number;
    existingTrain.date = primaryDate;
    applyStepFields(existingTrain);
    existingTrain.updatedAt = new Date().toISOString();
  } else {
    // Une vignette indépendante par date sélectionnée (chacune garde ses
    // propres heures réelles) — un train qui "circule sur plusieurs dates"
    // n'est pas un seul objet partagé entre ces dates.
    const extraDates = [...panel.querySelectorAll('.fDateExtra')].map((i) => i.value).filter(Boolean);
    const allDates = [...new Set([primaryDate, ...extraDates])];
    let maxOrder = trains.reduce((m, t) => Math.max(m, t.order || 0), -1);
    for (const date of allDates) {
      const newTrain = createEmptyTrain({ number, date, stepLabels: labels, order: ++maxOrder, source: 'manual' });
      applyStepFields(newTrain);
      trains.push(newTrain);
    }
    createdCount = allDates.length;
  }

  persist();
  closeModal();
  renderGrid();
  if (existingTrain) {
    if (settings.sheetsWebAppUrl) pushAllStepsToSheet(settings.sheetsWebAppUrl, existingTrain, computeAllStepDelays).catch(() => {});
    showToast('Train mis à jour');
  } else {
    showToast(createdCount > 1 ? `${createdCount} vignettes ajoutées (une par date)` : 'Train ajouté');
  }
}

// ---------- Modale Réglages ----------
function addQuickTrainRowInto(container, { number = '', operator = '', destination = '', mailTo = '', mailBcc = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'quick-train-form-row';
  row.innerHTML = `
    <div class="quick-train-form-main">
      <input type="text" class="fQuickTrainNumber" placeholder="Numéro" inputmode="numeric" value="${escapeHtml(number)}" style="max-width:110px;">
      <input type="text" class="fQuickTrainOperator" placeholder="Opérateur (ex : NAVILAND)" value="${escapeHtml(operator)}">
      <input type="text" class="fQuickTrainDestination" placeholder="Destination" value="${escapeHtml(destination)}">
      <button type="button" class="icon-btn" data-action="remove-quick-train-row" aria-label="Retirer ce train">✕</button>
    </div>
    <div class="quick-train-form-mail">
      <label>✉ À
        <input type="text" class="fQuickTrainMailTo" inputmode="email" autocomplete="off" placeholder="adresses séparées par ; (vide = liste par défaut)" value="${escapeHtml(mailTo)}">
      </label>
      <label>👁‍🗨 Cci (invisibles)
        <input type="text" class="fQuickTrainMailBcc" inputmode="email" autocomplete="off" placeholder="adresses séparées par ; (vide = liste par défaut)" value="${escapeHtml(mailBcc)}">
      </label>
    </div>`;
  container.appendChild(row);
}

function shuttleTimingSectionHTML(group) {
  const stops = group.stops || [];
  return `
    <fieldset class="shuttle-timing-fieldset" data-shuttle-family="${escapeHtml(group.id)}" style="border-color:${escapeHtml(group.color)}">
      <legend style="color:${escapeHtml(group.color)}">${escapeHtml(group.id)} — ${escapeHtml(group.codes.join(', '))}</legend>
      <div class="form-row">
        <label>Arrivée = départ + (min)
          <input type="number" class="sShuttleOffset" min="0" value="${group.offsetMinutes}">
        </label>
        <label>Seuil de clignotement (min avant arrivée)
          <input type="number" class="sShuttleImminent" min="0" value="${group.imminentMin ?? SHUTTLE_DEFAULT_IMMINENT_MIN}">
        </label>
      </div>
      <p class="help-text">Passages intermédiaires (nom + minutes depuis le départ) :</p>
      <div class="shuttle-timing-stops" data-role="shuttle-timing-stops">
        ${stops.map((s) => `
          <div class="shuttle-stop-form-row">
            <input type="text" class="fShuttleTimingStopLabel" placeholder="ex : Pont rouge" value="${escapeHtml(s.label)}">
            <input type="number" class="fShuttleTimingStopMin" placeholder="min" min="0" value="${escapeHtml(String(s.offsetMin))}">
            <button type="button" class="icon-btn" data-action="remove-shuttle-timing-stop" aria-label="Retirer ce passage">✕</button>
          </div>`).join('')}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-action="add-shuttle-timing-stop">+ Ajouter un passage</button>
      ${(settings.shuttleExtraCodes?.[group.id] || []).length ? `
        <p class="help-text">Codes ajoutés à cette famille (via "+ Navette") :</p>
        <div class="shuttle-extra-codes-list">
          ${settings.shuttleExtraCodes[group.id].map((code) => `
            <span class="quick-train-btn btn btn-outline btn-sm" style="display:inline-flex;gap:0.4rem;align-items:center;">
              ${escapeHtml(code)}
              <button type="button" class="icon-btn" data-action="remove-shuttle-extra-code" data-family="${escapeHtml(group.id)}" data-code="${escapeHtml(code)}" aria-label="Retirer ce code">✕</button>
            </span>`).join('')}
        </div>` : ''}
    </fieldset>`;
}

function addArrivalTimingStopRowInto(container, label = '', minutes = '') {
  const row = document.createElement('div');
  row.className = 'shuttle-stop-form-row';
  row.innerHTML = `
    <input type="text" class="fArrivalTimingStopLabel" placeholder="ex : Passage frontière" value="${escapeHtml(label)}">
    <input type="number" class="fArrivalTimingStopMin" placeholder="min" min="0" value="${escapeHtml(String(minutes))}">
    <button type="button" class="icon-btn" data-action="remove-arrival-timing-stop" aria-label="Retirer cette étape">✕</button>`;
  container.appendChild(row);
}

function arrivalTimingSectionHTML(group) {
  const stops = group.stops || [];
  return `
    <fieldset class="shuttle-timing-fieldset" data-arrival-family="${escapeHtml(group.id)}" style="border-color:${escapeHtml(group.color)}">
      <legend style="color:${escapeHtml(group.color)}">${escapeHtml(group.label)}</legend>
      <div class="form-row">
        <label>Arrivée = départ + (min)
          <input type="number" class="sArrivalOffset" min="0" value="${group.offsetMinutes}">
        </label>
        <label>Seuil de clignotement (min avant arrivée)
          <input type="number" class="sArrivalImminent" min="0" value="${group.imminentMin ?? ARRIVAL_DEFAULT_IMMINENT_MIN}">
        </label>
      </div>
      <p class="help-text">Étapes par défaut (nom + minutes depuis le départ) :</p>
      <div class="shuttle-timing-stops" data-role="arrival-timing-stops">
        ${stops.map((s) => `
          <div class="shuttle-stop-form-row">
            <input type="text" class="fArrivalTimingStopLabel" placeholder="ex : Passage frontière" value="${escapeHtml(s.label)}">
            <input type="number" class="fArrivalTimingStopMin" placeholder="min" min="0" value="${escapeHtml(String(s.offsetMin))}">
            <button type="button" class="icon-btn" data-action="remove-arrival-timing-stop" aria-label="Retirer cette étape">✕</button>
          </div>`).join('')}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-action="add-arrival-timing-stop">+ Ajouter une étape</button>
    </fieldset>`;
}

function syncInfoText() {
  if (!settings.lastSyncAt) return 'Aucune synchronisation effectuée pour le moment.';
  const date = new Date(settings.lastSyncAt);
  const status = settings.lastSyncStatus === 'ok' ? 'réussie' : 'échouée';
  return `Dernière synchronisation ${status} à ${formatHHMM(date)}.`;
}

function settingsBodyHTML() {
  return `
    <form id="settingsForm" class="stacked-form">
      <label>URL du Web App Google Apps Script (horaires théoriques + journal des heures réelles)
        <input type="url" id="sSheetUrl" value="${escapeHtml(settings.sheetsWebAppUrl || '')}" placeholder="https://script.google.com/macros/s/AKfycb.../exec">
      </label>
      <p class="help-text">Laissez vide pour saisir les horaires uniquement à la main. Cette même URL sert désormais aussi à envoyer automatiquement vers un onglet "Journal" chaque heure réelle enregistrée (mise à jour de apps-script/Code.gs requise — voir le README).</p>

      <div class="steps-form-list">
        <p class="help-text">Libellés par défaut des 7 étapes (nouveaux trains uniquement) :</p>
        ${settings.defaultStepLabels.map((l, i) => `
          <label>Étape ${i + 1}
            <input type="text" class="sStepLabel" data-i="${i}" value="${escapeHtml(l)}" required>
          </label>`).join('')}
      </div>

      <div class="steps-form-list">
        <p class="help-text">
          Décalages (minutes) du bouton "⚡ Remplir les 7 heures", par
          rapport à l'heure du sillon (départ pour la ligne + 15 min).
          Négatif = avant le sillon. Si les horaires calculés ne
          correspondent pas à la réalité du terrain, corrigez-les ici —
          ça s'applique à toutes les vignettes.
        </p>
        ${settings.defaultStepLabels.map((l, i) => `
          <label>${escapeHtml(l)}
            <input type="number" class="sSillonOffset" data-i="${i}" value="${settings.sillonStepOffsets[i] ?? ''}" required>
          </label>`).join('')}
        <button type="button" class="btn btn-ghost btn-sm" id="btnResetSillonOffsets">↺ Réinitialiser aux valeurs par défaut</button>
      </div>

      <div class="steps-form-list">
        <p class="help-text">
          Seuils de retard — au-delà de "orange", l'écart est affiché en
          orange (léger retard) ; au-delà de "rouge", en rouge (retard
          important). Utilisés partout : statut de la vignette, écarts par
          étape, cause principale, et l'email stylé (numéro de train/étape en
          couleur selon l'écart).
        </p>
        <div class="form-row">
          <label>Seuil orange (min)
            <input type="number" id="sDelayModerate" min="1" step="1" value="${settings.delayThresholds?.moderate ?? DELAY_THRESHOLDS_DEFAULTS.moderate}">
          </label>
          <label>Seuil rouge (min)
            <input type="number" id="sDelaySevere" min="1" step="1" value="${settings.delayThresholds?.severe ?? DELAY_THRESHOLDS_DEFAULTS.severe}">
          </label>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="btnResetDelayThresholds">↺ Réinitialiser aux valeurs par défaut</button>
      </div>

      <div class="steps-form-list">
        <p class="help-text">
          Navettes internes — réglages par famille. Les horaires de FL/NL/AL
          sont identiques par défaut ; ajustez-les ici indépendamment selon
          vos observations, ça se sauvegarde pour toutes les navettes de la
          famille (FL1/FL2/FL3, NL1/NL2, AL1/AL2). "Seuil de clignotement"
          est le nombre de minutes avant l'arrivée estimée à partir duquel la
          vignette clignote en rouge ("Arrivée imminente").
        </p>
        ${getAllShuttleGroups().filter((g) => !g.id.startsWith('custom-')).map((g) => shuttleTimingSectionHTML(g)).join('')}
      </div>

      <div class="steps-form-list">
        <p class="help-text">
          Tableau rapide des départs navettes (LF/LN/LA) — heure théorique de
          départ réglable navette par navette (chaque navette a son propre
          horaire), utilisée pour calculer l'écart avec l'heure réelle
          enregistrée (badge coloré vert/orange/rouge sur chaque case).
          "Réserve" est la case supplémentaire de secours de la famille.
          Laissez vide pour ne pas afficher d'écart sur une case.
        </p>
        ${SHUTTLE_QUICKBOARD_GROUPS.map((g) => `
          <fieldset class="shuttle-timing-fieldset" style="border-color:${escapeHtml(g.color)}">
            <legend style="color:${escapeHtml(g.color)}">${escapeHtml(g.id)} — ${escapeHtml(g.codes.join(', '))}, Réserve ${escapeHtml(g.id)}</legend>
            <div class="form-row">
              ${g.codes.map((code) => `
                <label>${escapeHtml(code)} — heure théorique
                  <input type="time" class="sQuickboardTheoretical" data-family="${escapeHtml(code)}" value="${escapeHtml(settings.quickboardTimings?.[code] || '')}">
                </label>`).join('')}
              <label>Réserve ${escapeHtml(g.id)} — heure théorique
                <input type="time" class="sQuickboardTheoretical" data-family="${escapeHtml(g.id)}" value="${escapeHtml(settings.quickboardTimings?.[g.id] || '')}">
              </label>
            </div>
          </fieldset>`).join('')}
      </div>

      ${(settings.customShuttleGroups || []).length ? `
        <div class="steps-form-list">
          <p class="help-text">Navettes ajoutées manuellement (via "+ Navette" → "Personnalisée") :</p>
          ${settings.customShuttleGroups.map((g) => `
            <div class="date-row-extra">
              <span style="flex:1 1 auto;">
                <strong style="color:${escapeHtml(g.color)}">${escapeHtml(g.codes.join(', '))}</strong>
                — ${escapeHtml(g.label || '')} (arrivée à + ${g.offsetMinutes} min)
              </span>
              <button type="button" class="icon-btn" data-action="remove-custom-shuttle" data-id="${escapeHtml(g.id)}" aria-label="Supprimer cette navette">✕</button>
            </div>`).join('')}
        </div>` : ''}

      <div class="steps-form-list">
        <p class="help-text">
          Arrivées (trains fret en provenance d'autres sites) — réglages par
          défaut par destination. "Arrivée = départ + (min)" et les étapes
          ci-dessous sont les valeurs de départ ; elles restent modifiables
          au jour le jour directement depuis chaque vignette (au clic), sans
          toucher aux valeurs par défaut définies ici.
        </p>
        ${getAllArrivalGroups().filter((g) => !g.id.startsWith('custom-arrival-')).map((g) => arrivalTimingSectionHTML(g)).join('')}
      </div>

      ${(settings.customArrivalGroups || []).length ? `
        <div class="steps-form-list">
          <p class="help-text">Arrivées ajoutées manuellement (via "+ Arrivée") :</p>
          ${settings.customArrivalGroups.map((g) => `
            <div class="date-row-extra">
              <span style="flex:1 1 auto;">
                <strong style="color:${escapeHtml(g.color)}">${escapeHtml(g.label || '')}</strong>
                (arrivée à + ${g.offsetMinutes} min)
              </span>
              <button type="button" class="icon-btn" data-action="remove-custom-arrival" data-id="${escapeHtml(g.id)}" aria-label="Supprimer cette arrivée">✕</button>
            </div>`).join('')}
        </div>` : ''}

      <div class="steps-form-list">
        <p class="help-text">Trains à accès rapide — un bouton apparaît pour chacun sous les navettes : cliquez pour indiquer qu'il circule aujourd'hui (ajoute sa vignette) ou qu'il ne circule pas (la retire). Opérateur et destination sont affichés au-dessus du numéro.</p>
        <p class="help-text">Destinataires du bouton « Email » de chaque train : « À » (visibles) et « Cci » (invisibles, les autres destinataires ne les voient pas). Plusieurs adresses : séparez-les par « ; ». Un champ vide reprend les destinataires par défaut ci-dessous.</p>
        <div class="quick-train-form-mail mail-defaults">
          <label>✉ À — par défaut (tous les trains)
            <input type="text" id="sMailDefaultTo" inputmode="email" autocomplete="off" placeholder="ex : regulation@exemple.fr; chef.equipe@exemple.fr" value="${escapeHtml(settings.mailDefaultTo || '')}">
          </label>
          <label>👁‍🗨 Cci — par défaut (invisibles)
            <input type="text" id="sMailDefaultBcc" inputmode="email" autocomplete="off" placeholder="ex : archives@exemple.fr" value="${escapeHtml(settings.mailDefaultBcc || '')}">
          </label>
        </div>
        <div id="sQuickTrainsContainer" class="extra-dates"></div>
        <button type="button" class="btn btn-ghost btn-sm" id="btnAddQuickTrainRow">+ Ajouter un train à accès rapide</button>
      </div>

      <label>Thème
        <select id="sTheme">
          <option value="auto" ${settings.theme === 'auto' ? 'selected' : ''}>Automatique (système)</option>
          <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Clair</option>
          <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Sombre</option>
        </select>
      </label>

      <p class="help-text" id="syncInfo">${syncInfoText()}</p>

      <div class="form-actions">
        <button type="button" id="btnSyncNow" class="btn btn-outline">↻ Relire les horaires</button>
        <button type="button" id="btnPushToday" class="btn btn-outline">↥ Renvoyer aujourd'hui vers Sheets</button>
        <button type="submit" class="btn btn-primary">Enregistrer</button>
      </div>
    </form>`;
}

function openSettingsModal() {
  openModal({
    title: 'Réglages',
    wide: true,
    bodyHTML: settingsBodyHTML(),
    onMount: (panel) => {
      panel.querySelector('#btnSyncNow').addEventListener('click', async () => {
        settings.sheetsWebAppUrl = panel.querySelector('#sSheetUrl').value.trim();
        saveSettings(settings);
        await syncWithSheet();
        const info = panel.querySelector('#syncInfo');
        if (info) info.textContent = syncInfoText();
      });
      panel.querySelector('#btnPushToday').addEventListener('click', async () => {
        settings.sheetsWebAppUrl = panel.querySelector('#sSheetUrl').value.trim();
        saveSettings(settings);
        await pushTodayToSheet();
      });
      panel.querySelectorAll('[data-action="remove-custom-shuttle"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const group = (settings.customShuttleGroups || []).find((g) => g.id === btn.dataset.id);
          if (!group) return;
          if (!confirm(`Supprimer la navette "${group.label}" (${group.codes.join(', ')}) ?`)) return;
          settings.customShuttleGroups = settings.customShuttleGroups.filter((g) => g.id !== group.id);
          saveSettings(settings);
          renderShuttlesBar();
          btn.closest('.date-row-extra').remove();
          showToast('Navette supprimée');
        });
      });
      panel.querySelectorAll('[data-action="remove-custom-arrival"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const group = (settings.customArrivalGroups || []).find((g) => g.id === btn.dataset.id);
          if (!group) return;
          if (!confirm(`Supprimer l'arrivée "${group.label}" ?`)) return;
          settings.customArrivalGroups = settings.customArrivalGroups.filter((g) => g.id !== group.id);
          saveSettings(settings);
          renderArrivalsBar();
          btn.closest('.date-row-extra').remove();
          showToast('Arrivée supprimée');
        });
      });
      panel.querySelector('#btnResetSillonOffsets').addEventListener('click', () => {
        if (!confirm('Réinitialiser les décalages du sillon aux valeurs par défaut de l\'application ?')) return;
        sortedByIndex([...panel.querySelectorAll('.sSillonOffset')]).forEach((input, i) => {
          input.value = DEFAULT_SETTINGS.sillonStepOffsets[i] ?? 0;
        });
        showToast('Décalages réinitialisés — pensez à Enregistrer');
      });
      panel.querySelector('#btnResetDelayThresholds').addEventListener('click', () => {
        panel.querySelector('#sDelayModerate').value = DELAY_THRESHOLDS_DEFAULTS.moderate;
        panel.querySelector('#sDelaySevere').value = DELAY_THRESHOLDS_DEFAULTS.severe;
        showToast('Seuils de retard réinitialisés — pensez à Enregistrer');
      });

      // ---- Trains à accès rapide (lignes numéro/opérateur/destination) ----
      const quickTrainsContainer = panel.querySelector('#sQuickTrainsContainer');
      (settings.quickTrains || []).forEach((t) => addQuickTrainRowInto(quickTrainsContainer, t));
      panel.querySelector('#btnAddQuickTrainRow').addEventListener('click', () => addQuickTrainRowInto(quickTrainsContainer));
      quickTrainsContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-action="remove-quick-train-row"]');
        if (removeBtn) removeBtn.closest('.quick-train-form-row').remove();
      });

      // ---- Navettes FL/NL/AL : passages intermédiaires (ajout/suppression de lignes) ----
      panel.querySelectorAll('[data-role="shuttle-timing-stops"]').forEach((stopsContainer) => {
        const fieldset = stopsContainer.closest('.shuttle-timing-fieldset');
        const addBtn = fieldset.querySelector('[data-action="add-shuttle-timing-stop"]');
        addBtn.addEventListener('click', () => addShuttleTimingStopRowInto(stopsContainer));
      });
      // ---- Arrivées : étapes par défaut (ajout/suppression de lignes) ----
      panel.querySelectorAll('[data-role="arrival-timing-stops"]').forEach((stopsContainer) => {
        const fieldset = stopsContainer.closest('.shuttle-timing-fieldset');
        const addBtn = fieldset.querySelector('[data-action="add-arrival-timing-stop"]');
        addBtn.addEventListener('click', () => addArrivalTimingStopRowInto(stopsContainer));
      });
      panel.addEventListener('click', (e) => {
        const removeStopBtn = e.target.closest('[data-action="remove-shuttle-timing-stop"]');
        if (removeStopBtn) { removeStopBtn.closest('.shuttle-stop-form-row').remove(); return; }
        const removeArrivalStopBtn = e.target.closest('[data-action="remove-arrival-timing-stop"]');
        if (removeArrivalStopBtn) { removeArrivalStopBtn.closest('.shuttle-stop-form-row').remove(); return; }
        const removeExtraCodeBtn = e.target.closest('[data-action="remove-shuttle-extra-code"]');
        if (removeExtraCodeBtn) {
          const { family, code } = removeExtraCodeBtn.dataset;
          settings.shuttleExtraCodes = { ...settings.shuttleExtraCodes };
          settings.shuttleExtraCodes[family] = (settings.shuttleExtraCodes[family] || []).filter((c) => c !== code);
          saveSettings(settings);
          renderShuttlesBar();
          removeExtraCodeBtn.closest('.shuttle-extra-codes-list > span, span').remove();
          showToast(`Code ${code} retiré de ${family}`);
        }
      });

      panel.querySelector('#settingsForm').addEventListener('submit', (e) => {
        e.preventDefault();
        settings.sheetsWebAppUrl = panel.querySelector('#sSheetUrl').value.trim();
        settings.defaultStepLabels = sortedByIndex([...panel.querySelectorAll('.sStepLabel')]).map((i) => i.value.trim());
        settings.sillonStepOffsets = sortedByIndex([...panel.querySelectorAll('.sSillonOffset')]).map((i) => Number(i.value) || 0);

        settings.quickTrains = [...quickTrainsContainer.querySelectorAll('.quick-train-form-row')]
          .map((row) => ({
            number: row.querySelector('.fQuickTrainNumber').value.trim(),
            operator: row.querySelector('.fQuickTrainOperator').value.trim(),
            destination: row.querySelector('.fQuickTrainDestination').value.trim(),
            mailTo: row.querySelector('.fQuickTrainMailTo').value.trim(),
            mailBcc: row.querySelector('.fQuickTrainMailBcc').value.trim(),
          }))
          .filter((t) => t.number);
        settings.quickTrainsEnrichedV2 = true;
        settings.mailDefaultTo = panel.querySelector('#sMailDefaultTo').value.trim();
        settings.mailDefaultBcc = panel.querySelector('#sMailDefaultBcc').value.trim();

        const shuttleTimings = { ...(settings.shuttleTimings || {}) };
        panel.querySelectorAll('[data-shuttle-family]').forEach((fieldset) => {
          const familyId = fieldset.dataset.shuttleFamily;
          const offsetMinutes = Number(fieldset.querySelector('.sShuttleOffset').value) || 0;
          const imminentMin = Number(fieldset.querySelector('.sShuttleImminent').value) || 0;
          const stops = [...fieldset.querySelectorAll('.shuttle-stop-form-row')]
            .map((row) => ({
              label: row.querySelector('.fShuttleTimingStopLabel').value.trim(),
              offsetMin: Number(row.querySelector('.fShuttleTimingStopMin').value) || 0,
            }))
            .filter((s) => s.label)
            .sort((a, b) => a.offsetMin - b.offsetMin);
          shuttleTimings[familyId] = { offsetMinutes, imminentMin, stops };
        });
        settings.shuttleTimings = shuttleTimings;

        const arrivalTimings = { ...(settings.arrivalTimings || {}) };
        panel.querySelectorAll('[data-arrival-family]').forEach((fieldset) => {
          const familyId = fieldset.dataset.arrivalFamily;
          const offsetMinutes = Number(fieldset.querySelector('.sArrivalOffset').value) || 0;
          const imminentMin = Number(fieldset.querySelector('.sArrivalImminent').value) || 0;
          const stops = [...fieldset.querySelectorAll('.shuttle-stop-form-row')]
            .map((row) => ({
              label: row.querySelector('.fArrivalTimingStopLabel').value.trim(),
              offsetMin: Number(row.querySelector('.fArrivalTimingStopMin').value) || 0,
            }))
            .filter((s) => s.label)
            .sort((a, b) => a.offsetMin - b.offsetMin);
          arrivalTimings[familyId] = { offsetMinutes, imminentMin, stops };
        });
        settings.arrivalTimings = arrivalTimings;

        const quickboardTimings = { ...(settings.quickboardTimings || {}) };
        panel.querySelectorAll('.sQuickboardTheoretical').forEach((input) => {
          const familyId = input.dataset.family;
          quickboardTimings[familyId] = input.value || null;
        });
        settings.quickboardTimings = quickboardTimings;

        settings.delayThresholds = {
          moderate: Number(panel.querySelector('#sDelayModerate').value) || null,
          severe: Number(panel.querySelector('#sDelaySevere').value) || null,
        };
        applyEffectiveDelayThresholds();

        settings.theme = panel.querySelector('#sTheme').value;
        saveSettings(settings);
        applyTheme();
        renderQuickTrainsBar();
        renderShuttlesBar();
        renderArrivalsBar();
        renderShuttleQuickboard();
        renderGrid();
        closeModal();
        showToast('Réglages enregistrés');
      });
    },
  });
}

// ---------- Modale Calendrier (vue globale, passé + à venir) ----------
function historyBodyHTML() {
  const countByDate = new Map();
  for (const t of trains) countByDate.set(t.date, (countByDate.get(t.date) || 0) + 1);
  const allDates = [...countByDate.keys()].sort((a, b) => a.localeCompare(b));
  if (allDates.length === 0) {
    return `<p class="help-text">Aucun train enregistré pour l'instant.</p>`;
  }
  return `
    <p class="help-text">Tous les trains enregistrés, quelle que soit leur date (passée ou à venir). Rien n'est jamais supprimé par le changement de date.</p>
    <div class="history-layout">
      <div class="history-dates">
        ${allDates.map((d) => {
          const isToday = d === currentDate;
          const count = countByDate.get(d);
          return `<button type="button" class="btn btn-outline history-date-btn${isToday ? ' active' : ''}" data-date="${d}">${formatDateFR(d)}${isToday ? ' · Aujourd\'hui' : ''} (${count})</button>`;
        }).join('')}
      </div>
      <div class="history-detail" id="historyDetail"><p class="help-text">Sélectionnez une date ci-dessus.</p></div>
    </div>`;
}

function renderHistoryDetail(container, dateISO) {
  const list = trains.filter((t) => t.date === dateISO).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  container.innerHTML = `
    <table class="history-table">
      <thead><tr><th>Train</th><th>Statut</th><th>Cause principale</th><th>Écart max</th><th></th></tr></thead>
      <tbody>
        ${list.map((t) => {
          const status = computeTrainStatus(t);
          const cause = computeMainCause(t);
          return `<tr>
            <td>${escapeHtml(t.number)}</td>
            <td><span class="status-pill tone-${status.tone}">${status.label}</span></td>
            <td>${escapeHtml(cause.cause)}</td>
            <td>${escapeHtml(cause.amountLabel)}</td>
            <td><button type="button" class="btn btn-ghost" data-copy-id="${t.id}">Copier</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  container.querySelectorAll('[data-copy-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const train = findTrain(btn.dataset.copyId);
      if (train) copyTrainData(train);
    });
  });
}

function openHistoryModal() {
  openModal({
    title: 'Calendrier des trains',
    wide: true,
    bodyHTML: historyBodyHTML(),
    onMount: (panel) => {
      const dateButtons = panel.querySelectorAll('.history-date-btn');
      dateButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
          dateButtons.forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          renderHistoryDetail(panel.querySelector('#historyDetail'), btn.dataset.date);
        });
      });
      const todayBtn = panel.querySelector('.history-date-btn.active');
      if (todayBtn) renderHistoryDetail(panel.querySelector('#historyDetail'), todayBtn.dataset.date);
    },
  });
}

// ---------- Synchronisation Google Sheets ----------
function setSyncIndicator(state, detail) {
  const dot = el('syncDot');
  const label = el('syncLabel');
  if (!dot || !label) return;
  dot.className = `sync-dot sync-${state}`;
  const messages = {
    none: 'Google Sheets non configuré',
    loading: 'Synchronisation…',
    ok: `Synchronisé à ${formatHHMM(new Date())}`,
    error: `Sheets indisponible${detail ? ' (' + detail + ')' : ''}`,
  };
  label.textContent = messages[state] || '';
}

const SYNC_ERROR_LABELS = {
  not_configured: 'non configuré',
  timeout: 'délai dépassé',
  network_error: 'réseau indisponible',
  http_error: 'erreur serveur',
  bad_format: 'format inattendu',
};

async function syncWithSheet({ silent = false } = {}) {
  const url = settings.sheetsWebAppUrl;
  if (!url) {
    setSyncIndicator('none');
    return;
  }
  setSyncIndicator('loading');
  const res = await fetchTheoreticalFromSheet(url, currentDate);

  if (!res.ok) {
    settings.lastSyncStatus = 'error';
    settings.lastSyncAt = new Date().toISOString();
    saveSettings(settings);
    setSyncIndicator('error', SYNC_ERROR_LABELS[res.reason] || res.reason);
    if (!silent) showToast('Google Sheets indisponible — données locales conservées', 'error');
    return;
  }

  const { trains: merged, touchedNumbers } = mergeSheetRowsIntoTrains(res.rows, trains, currentDate, settings.defaultStepLabels);
  trains = merged;
  persist();
  settings.lastSyncStatus = 'ok';
  settings.lastSyncAt = new Date().toISOString();
  saveSettings(settings);
  setSyncIndicator('ok');
  renderGrid();
  if (!silent && touchedNumbers.size) showToast(`Horaires synchronisés (${touchedNumbers.size} train${touchedNumbers.size > 1 ? 's' : ''})`);
}

// Envoi (fire-and-forget) d'une étape vers le "Journal" Google Sheets dès
// qu'une heure réelle est enregistrée/corrigée/réinitialisée, si une URL est
// configurée. N'affiche rien en cas de succès (pour ne pas surcharger
// l'utilisateur de toasts) ; une erreur reste silencieuse ici aussi — le
// bouton "↥ Renvoyer aujourd'hui vers Sheets" dans Réglages permet de
// rattraper manuellement tout ce qui n'aurait pas pu être envoyé (ex : pas
// de réseau au moment de la saisie).
function pushStepIfConfigured(train, stepIndex) {
  if (!settings.sheetsWebAppUrl) return;
  pushStepToSheet(settings.sheetsWebAppUrl, train, stepIndex, computeAllStepDelays).catch(() => {});
}

// Même principe que pushStepIfConfigured ci-dessus, pour les navettes
// (ligne 1), le tableau rapide des départs (ligne 2, "quickboard") et les
// arrivées (trains fret) — voir pushShuttleLogToSheet dans sheets-sync.js et
// l'onglet "Navettes" créé automatiquement côté Apps Script. `code` doit
// être unique par ligne du jour (voir le commentaire dans sheets-sync.js).
function pushShuttleLogIfConfigured(type, code, label, theoreticalHHMM, realHHMM, diffMin) {
  if (!settings.sheetsWebAppUrl) return;
  pushShuttleLogToSheet(settings.sheetsWebAppUrl, todayISO(), type, code, label, theoreticalHHMM, realHHMM, diffMin).catch(() => {});
}

async function pushTodayToSheet() {
  if (!settings.sheetsWebAppUrl) {
    showToast('Configurez d\'abord une URL Google Sheets', 'error');
    return { sent: 0, failed: 0 };
  }
  const todays = getTodayTrains();
  let sent = 0;
  let failed = 0;
  let sawBadResponse = false;
  for (const train of todays) {
    const results = await pushAllStepsToSheet(settings.sheetsWebAppUrl, train, computeAllStepDelays);
    for (const r of results) {
      if (r.ok) sent++;
      else {
        failed++;
        if (r.reason === 'bad_response') sawBadResponse = true;
      }
    }
  }
  if (failed === 0) {
    showToast(`${sent} heure(s) envoyée(s) vers Google Sheets ✓`);
  } else if (sawBadResponse) {
    // Réponse non-JSON du Web App : presque toujours un déploiement Apps
    // Script pas encore mis à jour (nouvelle version requise après avoir
    // collé le Code.gs à jour — voir README section 6.2).
    showToast('Échec — créez une NOUVELLE VERSION du déploiement Apps Script (Code.gs à jour non pris en compte)', 'error');
  } else {
    showToast(`${sent} envoyée(s), ${failed} échec(s) — réessayez plus tard`, failed === sent + failed ? 'error' : 'success');
  }
  return { sent, failed };
}

// ---------- Horloge & bascule de date ----------
function startClock() {
  const clockEl = el('clock');
  const tick = () => {
    clockEl.textContent = formatHHMMSS(new Date());
    const iso = todayISO();
    if (iso !== currentDate) {
      // Archive silencieusement (sans téléchargement) le PDF récap de la
      // journée qui se termine, AVANT de remettre à zéro navettes/réserves/
      // arrivées juste en dessous — sauvegarde régulière demandée. Capture
      // explicite d'un instantané de cette journée (date + trains de ce
      // jour-là + copies des navettes/réserves/arrivées), puisque les
      // variables globales basculent sur le nouveau jour juste après — voir
      // archiveDailyRecapSilently, qui ignore silencieusement les jours sans
      // aucune activité.
      const endingDate = currentDate;
      archiveDailyRecapSilently(endingDate, {
        trainsForDate: trains.filter((t) => t.date === endingDate),
        shuttlesSnapshot: { ...shuttles },
        shuttleReservesSnapshot: { ...shuttleReserves },
        arrivalsSnapshot: { ...arrivals },
      });

      currentDate = iso;
      updateDateLabel();
      renderGrid();
      // Remise à zéro automatique des navettes internes à chaque changement
      // de jour : un départ saisi la veille n'a plus de sens aujourd'hui.
      // (Le chronomètre de pause se remet à zéro tout seul, voir
      // stopwatch.js — il gère sa propre date en interne.)
      shuttles = {};
      saveShuttles(shuttles);
      renderShuttlesBar();
      // Idem pour le tableau rapide des départs navettes (réserves FL/NL/AL).
      shuttleReserves = {};
      saveShuttleReserves(shuttleReserves);
      renderShuttleQuickboard();
      // Idem pour les arrivées : les étapes modifiées la veille depuis une
      // vignette ne valent que pour la journée en cours (voir
      // getArrivalEffectiveConfig) ; les valeurs par défaut de Réglages
      // restent, elles, inchangées.
      arrivals = {};
      saveArrivals(arrivals);
      renderArrivalsBar();
      if (settings.sheetsWebAppUrl) syncWithSheet({ silent: true });
    }
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- PWA : installation & service worker ----------
function wireInstallPrompt() {
  const btn = el('btnInstall');
  if (!btn) return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btn.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    showToast('Application installée ✓');
  });
}

// IMPORTANT : sans ce qui suit, une fenêtre déjà ouverte (ou une PWA
// installée qui n'a jamais été complètement refermée) continue d'exécuter
// l'ancien code JS en mémoire indéfiniment, même une fois qu'un nouveau
// Service Worker a fini de s'installer et de prendre le contrôle en
// arrière-plan (self.skipWaiting() + self.clients.claim() côté
// service-worker.js) : ça n'a jamais rechargé la page pour de vrai. C'est
// ce qui explique qu'un correctif déployé ne "prenne" parfois qu'après
// plusieurs fermetures/réouvertures complètes de l'app, voire jamais tant
// que l'utilisateur ne vide pas le cache à la main. On répare ça une fois
// pour toutes : dès que le nouveau Service Worker prend la main
// (« controllerchange »), on recharge automatiquement la page — sauf si une
// saisie est en cours dans une modale, pour ne pas la couper en plein
// milieu (le rechargement se fera de toute façon au prochain changement de
// visibilité, via refreshFromStorage()/wireVisibilityRefresh()).
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then((reg) => reg.update().catch(() => {}))
      .catch((err) => console.warn('Service worker non enregistré', err));
  });

  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedForUpdate) return;
    if (document.body.classList.contains('modal-open')) return;
    reloadedForUpdate = true;
    window.location.reload();
  });
}

// ---------- Navettes internes ----------
// Fusionne les réglages personnalisés (settings.shuttleTimings, par famille
// FL/NL/AL) et les codes ajoutés via les préréglages (settings.
// shuttleExtraCodes) sur les groupes intégrés, puis ajoute les navettes
// personnalisées (settings.customShuttleGroups) telles quelles.
function getAllShuttleGroups() {
  const builtIn = SHUTTLE_GROUPS.map((group) => {
    const override = settings.shuttleTimings?.[group.id];
    const extraCodes = settings.shuttleExtraCodes?.[group.id] || [];
    return {
      ...group,
      offsetMinutes: override?.offsetMinutes ?? group.offsetMinutes,
      imminentMin: override?.imminentMin ?? group.imminentMin ?? SHUTTLE_DEFAULT_IMMINENT_MIN,
      stops: override?.stops?.length ? override.stops : group.stops,
      codes: [...group.codes, ...extraCodes],
    };
  });
  return [...builtIn, ...(settings.customShuttleGroups || [])];
}

function findShuttleGroup(code) {
  return getAllShuttleGroups().find((g) => g.codes.includes(code));
}

function computeShuttleArrival(code, departureHHMM) {
  const group = findShuttleGroup(code);
  const parsed = parseHHMM(departureHHMM);
  if (!group || !parsed) return null;
  const base = new Date(2000, 0, 1, parsed.h, parsed.m, 0, 0);
  const arrival = new Date(base.getTime() + group.offsetMinutes * 60000);
  return formatHHMM(arrival);
}

// Progression de la navette calculée à partir du temps ÉCOULÉ depuis
// l'heure de départ validée (plutôt que de sauter directement à "en
// approche"/"arrivée") :
//   vide -> partie du Terminal -> [passage intermédiaire atteint] (répété,
//   un par un, selon `group.stops`) -> imminente (clignote, à `imminentMin`
//   minutes de l'arrivée estimée) -> en retard (clignote en rouge, temps de
//   retard affiché) -> arrivée (grisée, uniquement après confirmation).
// Exemple (FL, départ validé à 10:19, arrivée = +35 min = 10:54,
// imminentMin = 10) : 10:19-10:20 "Partie du Terminal", 10:21 "Départ FS"
// (passage à +2 min), 10:24 "CV 1474" (+5), 10:34 "Entrée GB" (+15), 10:42
// "Sortie GB" (+23), dès 10:44 (10:54 - 10 min) "⚠ Arrivée imminente"
// clignotante, puis à partir de 10:54 (heure estimée dépassée) "⏱ En retard,
// confirmez l'arrivée" clignotant en rouge avec un compteur qui augmente
// ("+1 min", "+2 min"...) tant que personne n'a cliqué "✓ Navette arrivée" —
// corrige un bug signalé où la vignette grisait automatiquement dès l'heure
// estimée dépassée, alors que la navette n'était pas forcément arrivée pour
// de vrai (retard non détecté). Seul un clic sur "Navette arrivée" fait
// passer à "Arrivée effectuée" (grisée) : voir "arrivedManually" ci-dessous,
// qui court-circuite tout ce calcul.
function computeShuttleProgress(code) {
  if (shuttles[code]?.arrivedManually) return { state: 'arrived', label: 'Arrivée effectuée' };
  const group = findShuttleGroup(code);
  const departure = shuttles[code]?.departure;
  if (!group || !departure) return { state: 'empty', label: '' };
  const parsedDeparture = parseHHMM(departure);
  if (!parsedDeparture) return { state: 'empty', label: '' };

  const now = new Date();
  const departureDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsedDeparture.h, parsedDeparture.m, 0, 0);
  const elapsedMin = (now.getTime() - departureDate.getTime()) / 60000;

  const arrivalOffset = group.offsetMinutes;
  const imminentMin = group.imminentMin ?? SHUTTLE_DEFAULT_IMMINENT_MIN;

  if (elapsedMin >= arrivalOffset) return { state: 'overdue', label: "⏱ En retard, confirmez l'arrivée" };
  if (elapsedMin >= arrivalOffset - imminentMin) return { state: 'imminent', label: '⚠ Arrivée imminente' };
  if (elapsedMin < 0) return { state: 'scheduled', label: '' };

  const stops = [...(group.stops || [])].sort((a, b) => a.offsetMin - b.offsetMin);
  let currentStop = null;
  for (const stop of stops) {
    if (elapsedMin >= stop.offsetMin) currentStop = stop;
    else break;
  }
  if (currentStop) return { state: 'enroute', label: currentStop.label };
  return { state: 'departed', label: 'Partie du Terminal' };
}

function shuttleHasDelayFlag(code) {
  return Boolean(shuttles[code]?.delayFlag);
}

// Minutes restantes avant l'arrivée estimée (départ + group.offsetMinutes),
// pour le décompte affiché sur la vignette. null tant qu'aucun départ n'est
// enregistré ou une fois la navette arrivée (le décompte n'a alors plus de
// sens et le libellé d'état s'en charge déjà).
function computeShuttleRemainingMin(code) {
  if (shuttles[code]?.arrivedManually) return null;
  const group = findShuttleGroup(code);
  const departure = shuttles[code]?.departure;
  if (!group || !departure) return null;
  const parsedDeparture = parseHHMM(departure);
  if (!parsedDeparture) return null;
  const now = new Date();
  const departureDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsedDeparture.h, parsedDeparture.m, 0, 0);
  const elapsedMin = (now.getTime() - departureDate.getTime()) / 60000;
  if (elapsedMin >= group.offsetMinutes) return null;
  return Math.max(0, Math.round(group.offsetMinutes - elapsedMin));
}

// Minutes de retard écoulées au-delà de l'heure d'arrivée estimée (départ +
// group.offsetMinutes), affichées en compteur croissant sur la vignette tant
// que la navette est à l'état "overdue" (voir computeShuttleProgress) et que
// personne n'a cliqué "✓ Navette arrivée" — null tant que l'heure estimée
// n'est pas dépassée, ou une fois l'arrivée confirmée manuellement.
function computeShuttleOverdueMin(code) {
  if (shuttles[code]?.arrivedManually) return null;
  const group = findShuttleGroup(code);
  const departure = shuttles[code]?.departure;
  if (!group || !departure) return null;
  const parsedDeparture = parseHHMM(departure);
  if (!parsedDeparture) return null;
  const now = new Date();
  const departureDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsedDeparture.h, parsedDeparture.m, 0, 0);
  const elapsedMin = (now.getTime() - departureDate.getTime()) / 60000;
  if (elapsedMin < group.offsetMinutes) return null;
  return Math.max(0, Math.round(elapsedMin - group.offsetMinutes));
}

// Écart entre l'arrivée estimée (départ + group.offsetMinutes) et l'heure
// réelle observée — uniquement disponible quand la navette a été marquée
// "Navette arrivée" à la main (current.arrivedAt, capturé au clic) :
// l'arrivée automatique (par simple écoulement du temps) n'a rien de réel
// à comparer, donc null dans ce cas. null aussi tant qu'aucun départ n'est
// renseigné.
// Calcule l'écart entre l'arrivée estimée et l'heure réelle observée à
// partir d'un enregistrement générique { departure, arrivedManually,
// arrivedAt } et d'un groupe { offsetMinutes } — factorisé pour être
// utilisé par les navettes (computeShuttleArrivalDelta) ET les arrivées
// (computeArrivalArrivalDelta) ci-dessous, ainsi que par le PDF récap qui
// travaille sur un instantané figé des données (voir buildRecapPdfDoc).
function computeArrivalDeltaFromRecord(rec, group) {
  if (!rec?.arrivedManually || !rec.arrivedAt) return null;
  const parsedDeparture = parseHHMM(rec.departure);
  if (!group || !parsedDeparture) return null;
  const now = new Date();
  const departureDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsedDeparture.h, parsedDeparture.m, 0, 0);
  const estimatedArrival = new Date(departureDate.getTime() + group.offsetMinutes * 60000);
  const diffMin = diffMinutes(estimatedArrival, new Date(rec.arrivedAt));
  return { diffMin, tone: delayTone(diffMin, DELAY_THRESHOLDS) };
}

function computeShuttleArrivalDelta(code) {
  return computeArrivalDeltaFromRecord(shuttles[code], findShuttleGroup(code));
}

function shuttleDeltaBadgeHTML(delta) {
  if (!delta) return '<span class="shuttle-delta-badge" data-role="shuttle-delta" hidden></span>';
  return `<span class="shuttle-delta-badge tone-${delta.tone}" data-role="shuttle-delta">${escapeHtml(formatDelayLabel(delta.diffMin, DELAY_THRESHOLDS))}</span>`;
}

function shuttleChipInnerHTML(code) {
  const rec = shuttles[code];
  const departure = rec?.departure;
  const arrival = departure ? computeShuttleArrival(code, departure) : null;
  const progress = computeShuttleProgress(code);
  const delayFlag = shuttleHasDelayFlag(code);
  const remainingMin = computeShuttleRemainingMin(code);
  const overdueMin = computeShuttleOverdueMin(code);
  const delta = computeShuttleArrivalDelta(code);
  // Une fois confirmée ("✓ Navette arrivée"), on affiche l'heure RÉELLE
  // d'arrivée (rec.arrivedAt) à la place de l'heure estimée — l'heure
  // estimée n'a plus d'intérêt une fois l'arrivée confirmée, et le badge
  // d'écart (shuttleDeltaBadgeHTML) montre déjà la différence avec l'heure
  // théorique.
  const realArrival = rec?.arrivedManually && rec.arrivedAt ? formatHHMM(new Date(rec.arrivedAt)) : null;
  return `
    <span class="shuttle-code">${escapeHtml(code)}</span>
    ${departure
      ? `<span class="shuttle-times">Dép ${departure} → Arr${realArrival ? ' réelle' : ''} ${realArrival || arrival}</span>`
      : `<span class="shuttle-times shuttle-times-empty">Départ non renseigné</span>`}
    ${progress.label ? `<span class="shuttle-state-label" data-role="shuttle-state-label">${escapeHtml(progress.label)}</span>` : '<span class="shuttle-state-label" data-role="shuttle-state-label" hidden></span>'}
    <span class="shuttle-countdown" data-role="shuttle-countdown" ${remainingMin === null ? 'hidden' : ''}>${remainingMin === null ? '' : `⏳ ${remainingMin} min`}</span>
    <span class="shuttle-overdue-badge" data-role="shuttle-overdue" ${overdueMin === null ? 'hidden' : ''}>${overdueMin === null ? '' : `⏱ +${overdueMin} min`}</span>
    ${shuttleDeltaBadgeHTML(delta)}
    <span class="shuttle-delay-flag" data-role="shuttle-delay-flag" ${delayFlag ? '' : 'hidden'}>⚠ Retard signalé</span>`;
}

// Le grisage immédiat "dès que l'heure est renseignée" a été retiré : il
// masquait les passages intermédiaires et le clignotement "imminente" dès
// la saisie du départ, alors que la vignette doit rester colorée pendant
// toute la progression et ne griser qu'une fois réellement arrivée (voir
// computeShuttleProgress et .shuttle-chip.state-arrived dans style.css).
function shuttleChipClass(code) {
  return `shuttle-chip state-${computeShuttleProgress(code).state}${shuttleHasDelayFlag(code) ? ' has-delay' : ''}`;
}

// ---------- Masquer/afficher un bandeau (navettes / tableau rapide /
// arrivées) ----------
// Bouton ▾ commun aux 3 bandeaux (voir index.html, .bar-toggle-btn dans
// style.css). Persisté dans settings.panelHidden pour survivre à un
// rechargement de page. "shuttles" et "arrivals" réapparaissent tout seuls
// une fois masqués si un élément dedans devient imminent (voir
// maybeAutoRevealShuttlesBar/maybeAutoRevealArrivalsBar, appelées depuis
// updateShuttleStates/updateArrivalStates) ; "quickboard" reste masqué
// jusqu'au prochain clic manuel (pas de notion de temps restant pour ce
// bandeau-là).
const BAR_SECTION_SELECTOR = {
  shuttles: '.shuttles-bar',
  quickboard: '.shuttle-quickboard-bar',
  arrivals: '.arrivals-bar',
};

function applyPanelVisibility() {
  const state = settings.panelHidden || {};
  Object.entries(BAR_SECTION_SELECTOR).forEach(([key, selector]) => {
    const section = document.querySelector(selector);
    if (!section) return;
    const hidden = Boolean(state[key]);
    section.classList.toggle('is-collapsed', hidden);
    const btn = section.querySelector('.bar-toggle-btn');
    if (btn) btn.setAttribute('aria-pressed', String(hidden));
  });
}

function setPanelHidden(key, hidden) {
  settings.panelHidden = { ...settings.panelHidden, [key]: hidden };
  saveSettings(settings);
  applyPanelVisibility();
}

function wireBarToggles() {
  document.querySelectorAll('.bar-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.barToggle;
      const currentlyHidden = Boolean(settings.panelHidden?.[key]);
      setPanelHidden(key, !currentlyHidden);
    });
  });
}

// Réaffiche automatiquement le bandeau "navettes internes" s'il est masqué
// et qu'au moins une navette suivie devient imminente ou vient d'arriver
// (même seuil que le clignotement "Arrivée imminente" / group.imminentMin),
// pour ne jamais faire rater la séquence finale d'un départ validé pendant
// que le bandeau était masqué. Ne fait rien si le bandeau n'est pas masqué.
// Corrige un bug signalé : en déclenchant aussi sur l'état "arrivé" (en
// plus de "imminent"/"overdue"), le bandeau redevenait impossible à masquer
// une fois une navette arrivée — "arrivé" est un état définitif pour le
// reste de la journée (uniquement atteint après confirmation manuelle),
// donc il forçait la réouverture en permanence. "imminent" (transitoire,
// juste avant l'arrivée) et "overdue" (heure estimée dépassée sans
// confirmation, voir computeShuttleProgress) doivent au contraire forcer la
// réouverture — on ne veut jamais rater une navette en retard non
// confirmée. Une fois arrivée (confirmée), le bandeau peut à nouveau être
// masqué durablement.
function maybeAutoRevealShuttlesBar() {
  if (!settings.panelHidden?.shuttles) return;
  const codes = getAllShuttleGroups().flatMap((g) => g.codes);
  const shouldReveal = codes.some((code) => ['imminent', 'overdue'].includes(computeShuttleProgress(code).state));
  if (shouldReveal) setPanelHidden('shuttles', false);
}

// Équivalent pour le bandeau "arrivées" — voir maybeAutoRevealShuttlesBar.
function maybeAutoRevealArrivalsBar() {
  if (!settings.panelHidden?.arrivals) return;
  const shouldReveal = getAllArrivalGroups().some((group) => ['imminent', 'overdue'].includes(computeArrivalProgress(group.id).state));
  if (shouldReveal) setPanelHidden('arrivals', false);
}

function renderShuttlesBar() {
  const container = el('shuttlesBar');
  if (!container) return;
  const chips = getAllShuttleGroups().map((group) => group.codes.map((code) => `
    <button type="button" class="${shuttleChipClass(code)}" style="--shuttle-color:${group.color}" data-shuttle-code="${code}" title="${escapeHtml(group.label || '')}">
      ${shuttleChipInnerHTML(code)}
    </button>`).join('')).join('');
  container.innerHTML = `${chips}
    <button type="button" class="shuttle-chip shuttle-chip-add" id="btnAddShuttle">+ Navette</button>`;
}

// Recalcule la classe d'état + le libellé de chaque navette à chaque tick
// (utile pour la progression en temps réel), mais ne touche au DOM que ce
// qui a changé, pour ne pas interrompre l'animation de clignotement en
// cours.
function updateShuttleStates() {
  const container = el('shuttlesBar');
  if (!container) return;
  container.querySelectorAll('[data-shuttle-code]').forEach((chip) => {
    const code = chip.dataset.shuttleCode;
    const wantClass = shuttleChipClass(code);
    if (chip.className !== wantClass) chip.className = wantClass;
    const progress = computeShuttleProgress(code);
    const labelEl = chip.querySelector('[data-role="shuttle-state-label"]');
    if (labelEl && labelEl.textContent !== progress.label) {
      labelEl.textContent = progress.label || '';
      labelEl.hidden = !progress.label;
    }
    const delayEl = chip.querySelector('[data-role="shuttle-delay-flag"]');
    if (delayEl) delayEl.hidden = !shuttleHasDelayFlag(code);
    const countdownEl = chip.querySelector('[data-role="shuttle-countdown"]');
    if (countdownEl) {
      const remainingMin = computeShuttleRemainingMin(code);
      const text = remainingMin === null ? '' : `⏳ ${remainingMin} min`;
      if (countdownEl.textContent !== text) countdownEl.textContent = text;
      countdownEl.hidden = remainingMin === null;
    }
    const overdueEl = chip.querySelector('[data-role="shuttle-overdue"]');
    if (overdueEl) {
      const overdueMin = computeShuttleOverdueMin(code);
      const text = overdueMin === null ? '' : `⏱ +${overdueMin} min`;
      if (overdueEl.textContent !== text) overdueEl.textContent = text;
      overdueEl.hidden = overdueMin === null;
    }
    const deltaEl = chip.querySelector('[data-role="shuttle-delta"]');
    if (deltaEl) {
      const delta = computeShuttleArrivalDelta(code);
      deltaEl.hidden = !delta;
      if (delta) {
        deltaEl.className = `shuttle-delta-badge tone-${delta.tone}`;
        deltaEl.textContent = formatDelayLabel(delta.diffMin, DELAY_THRESHOLDS);
      }
    }
  });
  maybeAutoRevealShuttlesBar();
}

function shuttleQuickStatusText(arrivedManually, delayFlag) {
  if (arrivedManually && delayFlag) return 'Marquée arrivée manuellement, avec un retard signalé.';
  if (arrivedManually) return 'Marquée arrivée manuellement (remplace le calcul automatique).';
  if (delayFlag) return 'Retard / souci signalé — repère visuel ajouté sur la vignette.';
  return 'Aucune anomalie signalée.';
}

function openShuttleModal(code) {
  const group = findShuttleGroup(code);
  if (!group) return;
  const rec = shuttles[code] || {};
  const departure = rec.departure || '';
  const arrivedManually = Boolean(rec.arrivedManually);
  const delayFlag = Boolean(rec.delayFlag);

  openModal({
    title: `Navette ${escapeHtml(code)}`,
    bodyHTML: `
      <form id="shuttleForm" class="stacked-form">
        <label>Heure de départ (Terminal)
          <div class="sillon-lookup-row">
            <input type="time" id="fShuttleDeparture" value="${departure}">
            <button type="button" class="btn btn-outline btn-sm" id="btnShuttleNow">Maintenant</button>
          </div>
        </label>
        <p class="help-text">Heure d'arrivée estimée (départ + ${group.offsetMinutes} min) :</p>
        <p class="shuttle-arrival-preview" data-role="shuttle-arrival">${departure ? computeShuttleArrival(code, departure) : '--:--'}</p>

        ${group.stops && group.stops.length ? `
          <div class="shuttle-stops" style="--shuttle-color:${group.color}">
            <p class="help-text">Passages (calculés depuis l'heure de départ ci-dessus) :</p>
            <ul class="shuttle-stops-list" data-role="shuttle-stops-list">
              ${group.stops.map((s) => `<li><span class="shuttle-stop-label">${escapeHtml(s.label)}</span><span data-offset="${s.offsetMin}">--:--</span></li>`).join('')}
            </ul>
          </div>` : ''}

        <div class="shuttle-quick-actions">
          <button type="button" class="btn ${arrivedManually ? 'btn-primary' : 'btn-outline'}" id="btnShuttleArrived" aria-pressed="${arrivedManually}">✓ Navette arrivée</button>
          <button type="button" class="btn ${delayFlag ? 'btn-danger' : 'btn-outline'}" id="btnShuttleDelay" aria-pressed="${delayFlag}">⚠ Retard / souci</button>
        </div>
        <p class="help-text" data-role="shuttle-quick-status">${shuttleQuickStatusText(arrivedManually, delayFlag)}</p>

        <div class="form-actions">
          <button type="button" class="btn btn-outline" id="btnClearShuttle">Effacer</button>
          <button type="submit" class="btn btn-primary">Enregistrer</button>
        </div>
      </form>`,
    onMount: (panel) => {
      const input = panel.querySelector('#fShuttleDeparture');
      const preview = panel.querySelector('[data-role="shuttle-arrival"]');
      const stopsListEl = panel.querySelector('[data-role="shuttle-stops-list"]');
      const refreshStops = () => {
        if (!stopsListEl) return;
        const parsed = parseHHMM(input.value);
        stopsListEl.querySelectorAll('span[data-offset]').forEach((span) => {
          if (!parsed) { span.textContent = '--:--'; return; }
          const base = new Date(2000, 0, 1, parsed.h, parsed.m, 0, 0);
          const t = new Date(base.getTime() + Number(span.dataset.offset) * 60000);
          span.textContent = formatHHMM(t);
        });
      };
      const refreshPreview = () => {
        preview.textContent = input.value ? computeShuttleArrival(code, input.value) : '--:--';
        refreshStops();
      };
      refreshPreview();
      input.addEventListener('input', refreshPreview);
      panel.querySelector('#btnShuttleNow').addEventListener('click', () => {
        input.value = formatHHMM(new Date());
        refreshPreview();
      });

      const arrivedBtn = panel.querySelector('#btnShuttleArrived');
      const delayBtn = panel.querySelector('#btnShuttleDelay');
      const statusEl = panel.querySelector('[data-role="shuttle-quick-status"]');
      const refreshQuickButtons = () => {
        const current = shuttles[code] || {};
        arrivedBtn.classList.toggle('btn-primary', Boolean(current.arrivedManually));
        arrivedBtn.classList.toggle('btn-outline', !current.arrivedManually);
        arrivedBtn.setAttribute('aria-pressed', String(Boolean(current.arrivedManually)));
        delayBtn.classList.toggle('btn-danger', Boolean(current.delayFlag));
        delayBtn.classList.toggle('btn-outline', !current.delayFlag);
        delayBtn.setAttribute('aria-pressed', String(Boolean(current.delayFlag)));
        statusEl.textContent = shuttleQuickStatusText(current.arrivedManually, current.delayFlag);
      };
      arrivedBtn.addEventListener('click', () => {
        const current = shuttles[code] || {};
        current.arrivedManually = !current.arrivedManually;
        // Capture l'instant du clic comme heure réelle d'arrivée (pour
        // l'écart affiché sur la vignette, voir computeShuttleArrivalDelta)
        // : seul ce clic donne une heure réelle observée, contrairement à
        // l'arrivée automatique (calculée par simple écoulement du temps,
        // donc toujours "pile à l'heure" par construction).
        current.arrivedAt = current.arrivedManually ? new Date().toISOString() : null;
        shuttles[code] = current;
        saveShuttles(shuttles);
        renderShuttlesBar();
        refreshQuickButtons();
        if (current.arrivedManually && current.arrivedAt) {
          const delta = computeShuttleArrivalDelta(code);
          pushShuttleLogIfConfigured('Navette', `${code}-arr`, `${code} (arrivée)`, computeShuttleArrival(code, current.departure), formatHHMM(new Date(current.arrivedAt)), delta?.diffMin ?? null);
        }
        showToast(current.arrivedManually ? `Navette ${code} marquée arrivée` : `Navette ${code} réactivée`);
      });
      delayBtn.addEventListener('click', () => {
        const current = shuttles[code] || {};
        current.delayFlag = !current.delayFlag;
        shuttles[code] = current;
        saveShuttles(shuttles);
        renderShuttlesBar();
        refreshQuickButtons();
        showToast(current.delayFlag ? `Retard signalé sur la navette ${code}` : `Retard levé sur la navette ${code}`);
      });

      panel.querySelector('#shuttleForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const current = shuttles[code] || {};
        current.departure = input.value || null;
        shuttles[code] = current;
        saveShuttles(shuttles);
        renderShuttlesBar();
        closeModal();
        if (current.departure) pushShuttleLogIfConfigured('Navette', code, `${code} (départ)`, null, current.departure, null);
        showToast(`Navette ${code} mise à jour`);
      });
      panel.querySelector('#btnClearShuttle').addEventListener('click', () => {
        shuttles[code] = { departure: null, arrivedManually: false, delayFlag: false, arrivedAt: null };
        saveShuttles(shuttles);
        renderShuttlesBar();
        closeModal();
        showToast(`Navette ${code} réinitialisée`);
      });
    },
  });
}

function addShuttleTimingStopRowInto(container, label = '', minutes = '') {
  const row = document.createElement('div');
  row.className = 'shuttle-stop-form-row';
  row.innerHTML = `
    <input type="text" class="fShuttleTimingStopLabel" placeholder="ex : Pont rouge" value="${escapeHtml(label)}">
    <input type="number" class="fShuttleTimingStopMin" placeholder="min" min="0" value="${escapeHtml(String(minutes))}">
    <button type="button" class="icon-btn" data-action="remove-shuttle-timing-stop" aria-label="Retirer ce passage">✕</button>`;
  container.appendChild(row);
}

function addShuttleStopRowInto(container, label = '', minutes = '') {
  const row = document.createElement('div');
  row.className = 'shuttle-stop-form-row';
  row.innerHTML = `
    <input type="text" class="fShuttleStopLabel" placeholder="ex : Pont rouge" value="${escapeHtml(label)}">
    <input type="number" class="fShuttleStopMin" placeholder="min" min="0" value="${escapeHtml(String(minutes))}">
    <button type="button" class="icon-btn" data-action="remove-shuttle-stop" aria-label="Retirer ce passage">✕</button>`;
  container.appendChild(row);
}

const SHUTTLE_PRESET_LABELS = { FL: 'FL — orange', NL: 'NL — bleu', AL: 'AL — jaune' };

function shuttlePresetPreviewHTML(presetId) {
  const group = getAllShuttleGroups().find((g) => g.id === presetId);
  if (!group) return '';
  return `Reprend automatiquement le trajet, la couleur et les horaires ${escapeHtml(presetId)} (arrivée à + ${group.offsetMinutes} min, ${group.stops.length} passage${group.stops.length > 1 ? 's' : ''} intermédiaire${group.stops.length > 1 ? 's' : ''}). Codes actuels : ${escapeHtml(group.codes.join(', '))}.`;
}

function shuttleAddDynamicHTML(preset) {
  if (preset === 'custom') {
    return `
      <form id="addShuttleForm" class="stacked-form">
        <div class="form-row">
          <label>Nom / destination
            <input type="text" id="fShuttleName" required placeholder="ex : Navette Portuaire">
          </label>
          <label>Couleur du cadre
            <input type="color" id="fShuttleColor" value="#0ea5e9">
          </label>
        </div>
        <label>Codes (séparés par une virgule)
          <input type="text" id="fShuttleCodes" required placeholder="ex : BL1, BL2">
        </label>
        <p class="help-text">
          Liste des passages, avec le nombre de minutes écoulées depuis le
          départ pour chacun. Le passage ayant le plus grand nombre de
          minutes définit l'heure d'arrivée estimée.
        </p>
        <div id="shuttleStopsContainer" class="extra-dates"></div>
        <button type="button" class="btn btn-ghost btn-sm" id="btnAddShuttleStop">+ Ajouter un passage</button>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Ajouter la navette</button>
        </div>
      </form>`;
  }
  return `
    <form id="addShuttlePresetForm" class="stacked-form">
      <p class="help-text">${shuttlePresetPreviewHTML(preset)}</p>
      <label>Nouveau(x) code(s) pour cette famille (séparés par une virgule)
        <input type="text" id="fShuttlePresetCodes" required placeholder="ex : ${preset}4">
      </label>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Ajouter à ${escapeHtml(preset)}</button>
      </div>
    </form>`;
}

function openAddShuttleModal() {
  openModal({
    title: 'Ajouter une navette',
    wide: true,
    bodyHTML: `
      <div class="shuttle-preset-row">
        ${['FL', 'NL', 'AL'].map((id) => {
          const group = SHUTTLE_GROUPS.find((g) => g.id === id);
          return `<button type="button" class="shuttle-preset-btn" data-preset="${id}" style="--shuttle-color:${group.color}">${escapeHtml(SHUTTLE_PRESET_LABELS[id])}</button>`;
        }).join('')}
        <button type="button" class="shuttle-preset-btn" data-preset="custom">Personnalisée</button>
      </div>
      <div id="shuttleAddDynamic"></div>`,
    onMount: (panel) => {
      const dynamic = panel.querySelector('#shuttleAddDynamic');
      const presetButtons = [...panel.querySelectorAll('.shuttle-preset-btn')];

      function selectPreset(preset) {
        presetButtons.forEach((b) => b.classList.toggle('is-selected', b.dataset.preset === preset));
        dynamic.innerHTML = shuttleAddDynamicHTML(preset);
        wireDynamicForm(preset);
      }

      function wireDynamicForm(preset) {
        if (preset === 'custom') {
          const stopsContainer = dynamic.querySelector('#shuttleStopsContainer');
          addShuttleStopRowInto(stopsContainer);
          addShuttleStopRowInto(stopsContainer);
          dynamic.querySelector('#btnAddShuttleStop').addEventListener('click', () => addShuttleStopRowInto(stopsContainer));
          stopsContainer.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('[data-action="remove-shuttle-stop"]');
            if (removeBtn) removeBtn.closest('.shuttle-stop-form-row').remove();
          });
          dynamic.querySelector('#addShuttleForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const name = dynamic.querySelector('#fShuttleName').value.trim();
            const color = dynamic.querySelector('#fShuttleColor').value;
            const codes = dynamic.querySelector('#fShuttleCodes').value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
            if (codes.length === 0) { showToast('Indiquez au moins un code de navette', 'error'); return; }
            const existingCodes = new Set(getAllShuttleGroups().flatMap((g) => g.codes));
            const clashing = codes.filter((c) => existingCodes.has(c));
            if (clashing.length) { showToast(`Code(s) déjà utilisé(s) : ${clashing.join(', ')}`, 'error'); return; }
            const stops = [...stopsContainer.querySelectorAll('.shuttle-stop-form-row')]
              .map((row) => ({
                label: row.querySelector('.fShuttleStopLabel').value.trim(),
                offsetMin: Number(row.querySelector('.fShuttleStopMin').value) || 0,
              }))
              .filter((s) => s.label)
              .sort((a, b) => a.offsetMin - b.offsetMin);
            if (stops.length === 0) { showToast("Ajoutez au moins un passage (l'arrivée)", 'error'); return; }
            const newGroup = {
              id: 'custom-' + Date.now().toString(36),
              label: name || codes[0],
              codes,
              color,
              offsetMinutes: stops[stops.length - 1].offsetMin,
              stops: stops.slice(0, -1),
            };
            settings.customShuttleGroups = [...(settings.customShuttleGroups || []), newGroup];
            saveSettings(settings);
            renderShuttlesBar();
            closeModal();
            showToast(`Navette "${newGroup.label}" ajoutée`);
          });
          return;
        }

        // Préréglage FL/NL/AL : on ne demande que le(s) nouveau(x) code(s),
        // tout le reste (couleur, décalage d'arrivée, passages) est repris
        // de la famille via getAllShuttleGroups().
        dynamic.querySelector('#addShuttlePresetForm').addEventListener('submit', (e) => {
          e.preventDefault();
          const codes = dynamic.querySelector('#fShuttlePresetCodes').value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
          if (codes.length === 0) { showToast('Indiquez au moins un code', 'error'); return; }
          const existingCodes = new Set(getAllShuttleGroups().flatMap((g) => g.codes));
          const clashing = codes.filter((c) => existingCodes.has(c));
          if (clashing.length) { showToast(`Code(s) déjà utilisé(s) : ${clashing.join(', ')}`, 'error'); return; }
          settings.shuttleExtraCodes = { ...settings.shuttleExtraCodes };
          settings.shuttleExtraCodes[preset] = [...(settings.shuttleExtraCodes[preset] || []), ...codes];
          saveSettings(settings);
          renderShuttlesBar();
          closeModal();
          showToast(`${codes.join(', ')} ajouté(s) à ${preset}`);
        });
      }

      presetButtons.forEach((btn) => btn.addEventListener('click', () => selectPreset(btn.dataset.preset)));
      selectPreset('FL');
    },
  });
}

function wireShuttlesBar() {
  const container = el('shuttlesBar');
  if (!container) return;
  container.addEventListener('click', (e) => {
    if (e.target.closest('#btnAddShuttle')) { openAddShuttleModal(); return; }
    const btn = e.target.closest('[data-shuttle-code]');
    if (btn) openShuttleModal(btn.dataset.shuttleCode);
  });
  setInterval(updateShuttleStates, 15000);
}

// ---------- Tableau rapide des départs navettes (sens retour) ----------
// Départs "dans l'autre sens" (codes LF/LN/LA), DISTINCTS des navettes
// suivies par les vignettes ci-dessus (codes FL/NL/AL) — y compris pour la
// famille AL, volontairement renommée LA ici pour qu'aucun code ne soit
// jamais partagé entre les deux bandeaux (source de confusion sinon, un
// clic sur l'un pouvant être pris pour l'autre) : stockage totalement
// indépendant (shuttleReserves, malgré son nom historique — voir
// STORAGE_KEYS.shuttleReserves dans config.js), pour ne jamais interférer
// avec le suivi détaillé des vignettes (arrivée estimée, passages
// intermédiaires, modale). Besoin volontairement minimal pour ce sens :
// cliquer pose l'heure actuelle, la case grise pour indiquer "c'est
// parti" (voir .quickboard-cell.is-set dans style.css), un second clic
// permet de corriger ou d'effacer via un petit éditeur dédié. Pas de suivi
// d'arrivée/passages intermédiaires ici — on veut juste savoir si c'est
// parti ou non.
const SHUTTLE_QUICKBOARD_GROUPS = [
  { id: 'LF', codes: ['LF1', 'LF2', 'LF3'], color: '#f59e0b' },
  { id: 'LN', codes: ['LN1', 'LN2'], color: '#1e3a8a' },
  { id: 'LA', codes: ['LA1', 'LA2'], color: '#eab308' },
];
const SHUTTLE_QUICKBOARD_CODES = SHUTTLE_QUICKBOARD_GROUPS.flatMap((g) => g.codes);
const SHUTTLE_QUICKBOARD_RESERVE_FAMILIES = SHUTTLE_QUICKBOARD_GROUPS.map((g) => g.id);

function quickboardGroupOf(codeOrFamily) {
  return SHUTTLE_QUICKBOARD_GROUPS.find((g) => g.codes.includes(codeOrFamily) || g.id === codeOrFamily);
}

function quickboardPad(n) {
  return String(n).padStart(2, '0');
}

function quickboardNowHHMM() {
  const now = new Date();
  return `${quickboardPad(now.getHours())}:${quickboardPad(now.getMinutes())}`;
}

// Écart entre l'heure théorique (settings.quickboardTimings, réglable
// navette par navette dans Réglages) et l'heure réelle cliquée — même
// palier de couleur (DELAY_THRESHOLDS) que partout ailleurs dans l'app.
// `key` est soit un code précis ("LF1"), soit une famille ("LF") pour sa
// case Réserve — chacun a sa propre heure théorique dans
// settings.quickboardTimings. null tant qu'aucune heure théorique n'est
// réglée pour cette clé, ou qu'aucun départ n'a encore été cliqué.
function computeQuickboardDelta(key) {
  const theoretical = settings.quickboardTimings?.[key];
  const real = shuttleReserves[key];
  if (!theoretical || !real) return null;
  const parsedTheo = parseHHMM(theoretical);
  const parsedReal = parseHHMM(real);
  if (!parsedTheo || !parsedReal) return null;
  const theoDate = new Date(2000, 0, 1, parsedTheo.h, parsedTheo.m, 0, 0);
  const realDate = new Date(2000, 0, 1, parsedReal.h, parsedReal.m, 0, 0);
  const diffMin = diffMinutes(theoDate, realDate);
  return { diffMin, tone: delayTone(diffMin, DELAY_THRESHOLDS) };
}

function shuttleQuickboardCellHTML(code) {
  const group = quickboardGroupOf(code);
  const time = shuttleReserves[code] || null;
  return `
    <td>
      <button type="button" class="quickboard-cell${time ? ' is-set' : ''}" style="--shuttle-color:${escapeHtml(group?.color || '#94a3b8')}" data-quickboard-code="${escapeHtml(code)}" title="${time ? 'Cliquer pour corriger' : "Cliquer pour enregistrer l'heure actuelle"}">
        <span class="quickboard-code">${escapeHtml(code)}</span>
        <span class="quickboard-time">${time || '--:--'}</span>
        ${shuttleDeltaBadgeHTML(computeQuickboardDelta(code))}
      </button>
    </td>`;
}

function shuttleQuickboardReserveCellHTML(family) {
  const group = quickboardGroupOf(family);
  const time = shuttleReserves[family] || null;
  return `
    <td>
      <button type="button" class="quickboard-cell${time ? ' is-set' : ''}" style="--shuttle-color:${escapeHtml(group?.color || '#94a3b8')}" data-quickboard-reserve="${escapeHtml(family)}" title="${time ? 'Cliquer pour corriger' : "Cliquer pour enregistrer l'heure actuelle"}">
        <span class="quickboard-code">Réserve ${escapeHtml(family)}</span>
        <span class="quickboard-time">${time || '--:--'}</span>
        ${shuttleDeltaBadgeHTML(computeQuickboardDelta(family))}
      </button>
    </td>`;
}

function renderShuttleQuickboard() {
  const container = el('shuttleQuickboard');
  if (!container) return;
  const cells = SHUTTLE_QUICKBOARD_CODES.map(shuttleQuickboardCellHTML).join('')
    + SHUTTLE_QUICKBOARD_RESERVE_FAMILIES.map(shuttleQuickboardReserveCellHTML).join('');
  container.innerHTML = `<table class="shuttle-quickboard-table" aria-label="Tableau rapide des départs navettes (sens retour)"><tbody><tr>${cells}</tr></tbody></table>`;
}

// Éditeur minimal (heure + effacer) partagé par les codes principaux et les
// réserves du tableau rapide : `key` est la clé dans shuttleReserves (un
// code comme "LF1", ou une famille comme "LF" pour sa réserve).
function openQuickboardTimeEditor(key, label) {
  const current = shuttleReserves[key] || '';
  openModal({
    title: `${label} — heure de départ`,
    bodyHTML: `
      <form id="quickboardTimeForm" class="stacked-form">
        <label>Heure de départ
          <input type="time" id="fQuickboardTime" value="${escapeHtml(current)}">
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn-outline" id="btnQuickboardClear">Effacer</button>
          <button type="submit" class="btn btn-primary">Enregistrer</button>
        </div>
      </form>`,
    onMount: (panel) => {
      panel.querySelector('#btnQuickboardClear').addEventListener('click', () => {
        shuttleReserves[key] = null;
        saveShuttleReserves(shuttleReserves);
        renderShuttleQuickboard();
        closeModal();
      });
      panel.querySelector('#quickboardTimeForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const value = panel.querySelector('#fQuickboardTime').value;
        shuttleReserves[key] = value || null;
        saveShuttleReserves(shuttleReserves);
        renderShuttleQuickboard();
        closeModal();
        if (shuttleReserves[key]) pushQuickboardLog(key, label);
      });
    },
  });
}

// Envoie la ligne "tableau rapide des départs navettes" (ligne 2,
// "quickboard") vers l'onglet "Navettes" — voir pushShuttleLogIfConfigured.
// `key` est la clé dans shuttleReserves (un code comme "LF1", ou une
// famille comme "LF" pour sa réserve) ; l'heure théorique vient de
// settings.quickboardTimings (réglable navette par navette dans Réglages),
// et l'écart de computeQuickboardDelta, déjà utilisé pour le badge affiché
// sur la vignette.
function pushQuickboardLog(key, label) {
  const theoretical = settings.quickboardTimings?.[key];
  const delta = computeQuickboardDelta(key);
  pushShuttleLogIfConfigured('Quickboard', key, label, theoretical || null, shuttleReserves[key] || null, delta?.diffMin ?? null);
}

function quickboardRecordCode(code) {
  if (!shuttleReserves[code]) {
    shuttleReserves[code] = quickboardNowHHMM();
    saveShuttleReserves(shuttleReserves);
    renderShuttleQuickboard();
    pushQuickboardLog(code, code);
    showToast(`${code} : départ enregistré à ${shuttleReserves[code]}`);
  } else {
    openQuickboardTimeEditor(code, code);
  }
}

function quickboardRecordReserve(family) {
  if (!shuttleReserves[family]) {
    shuttleReserves[family] = quickboardNowHHMM();
    saveShuttleReserves(shuttleReserves);
    renderShuttleQuickboard();
    pushQuickboardLog(family, `Réserve ${family}`);
    showToast(`Réserve ${family} : départ enregistré à ${shuttleReserves[family]}`);
  } else {
    openQuickboardTimeEditor(family, `Réserve ${family}`);
  }
}

function wireShuttleQuickboard() {
  const container = el('shuttleQuickboard');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const codeBtn = e.target.closest('[data-quickboard-code]');
    if (codeBtn) { quickboardRecordCode(codeBtn.dataset.quickboardCode); return; }
    const resBtn = e.target.closest('[data-quickboard-reserve]');
    if (resBtn) { quickboardRecordReserve(resBtn.dataset.quickboardReserve); return; }
  });
}

// ---------- Arrivées (trains fret en provenance d'autres sites) ----------
// Même principe que les navettes internes ci-dessus (getAllShuttleGroups…),
// avec une différence : les étapes peuvent être modifiées directement
// depuis la vignette (au clic), pour la journée en cours uniquement — voir
// getArrivalEffectiveConfig, qui donne priorité aux étapes du jour
// (arrivals[id].stops) sur les valeurs par défaut de Réglages
// (settings.arrivalTimings) elles-mêmes prioritaires sur ARRIVAL_GROUPS.
function getAllArrivalGroups() {
  const builtIn = ARRIVAL_GROUPS.map((group) => {
    const override = settings.arrivalTimings?.[group.id];
    return {
      ...group,
      offsetMinutes: override?.offsetMinutes ?? group.offsetMinutes,
      imminentMin: override?.imminentMin ?? group.imminentMin ?? ARRIVAL_DEFAULT_IMMINENT_MIN,
      stops: override?.stops?.length ? override.stops : group.stops,
    };
  });
  return [...builtIn, ...(settings.customArrivalGroups || [])];
}

function findArrivalGroup(id) {
  return getAllArrivalGroups().find((g) => g.id === id);
}

// Configuration "effective" du jour : les étapes modifiées depuis la
// vignette (arrivals[id].stops) remplacent celles de Réglages pour la
// journée en cours seulement (remis à zéro automatiquement le lendemain,
// voir startClock) ; la dernière étape de la liste définit l'heure
// d'arrivée estimée (offsetMinutes), exactement comme pour l'ajout d'une
// navette personnalisée.
function getArrivalEffectiveConfig(id) {
  const group = findArrivalGroup(id);
  if (!group) return null;
  const todayStops = arrivals[id]?.stops;
  const stops = (todayStops && todayStops.length ? [...todayStops] : [...(group.stops || [])]).sort((a, b) => a.offsetMin - b.offsetMin);
  const offsetMinutes = stops.length ? stops[stops.length - 1].offsetMin : group.offsetMinutes;
  return { ...group, stops, offsetMinutes };
}

function computeArrivalETA(id, departureHHMM) {
  const group = getArrivalEffectiveConfig(id);
  const parsed = parseHHMM(departureHHMM);
  if (!group || !parsed) return null;
  const base = new Date(2000, 0, 1, parsed.h, parsed.m, 0, 0);
  return formatHHMM(new Date(base.getTime() + group.offsetMinutes * 60000));
}

function arrivalHasDelayFlag(id) {
  return Boolean(arrivals[id]?.delayFlag);
}

// Progression calculée à partir du temps écoulé depuis le départ saisi,
// exactement comme computeShuttleProgress ci-dessus (mêmes états : vide ->
// en approche -> imminente -> arrivée), avec en plus le pourcentage `pct`
// et les étapes avec leur position `pct` le long du rail, utilisés par
// arrivalTrackHTML pour dessiner et faire avancer l'icône du train.
function computeArrivalProgress(id) {
  const group = getArrivalEffectiveConfig(id);
  if (!group) return { state: 'empty', label: '', pct: 0, stops: [] };
  const totalMin = group.offsetMinutes || 1;
  const baseStops = group.stops.map((s) => ({ ...s, pct: Math.max(0, Math.min(100, (s.offsetMin / totalMin) * 100)) }));

  if (arrivals[id]?.arrivedManually) {
    return { state: 'arrived', label: 'Arrivée effectuée', pct: 100, stops: baseStops.map((s) => ({ ...s, reached: true, time: null })) };
  }

  const departure = arrivals[id]?.departure;
  if (!departure) return { state: 'empty', label: '', pct: 0, stops: baseStops.map((s) => ({ ...s, reached: false, time: null })) };
  const parsedDeparture = parseHHMM(departure);
  if (!parsedDeparture) return { state: 'empty', label: '', pct: 0, stops: baseStops.map((s) => ({ ...s, reached: false, time: null })) };

  const now = new Date();
  const departureDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsedDeparture.h, parsedDeparture.m, 0, 0);
  const elapsedMin = (now.getTime() - departureDate.getTime()) / 60000;
  const imminentMin = group.imminentMin ?? ARRIVAL_DEFAULT_IMMINENT_MIN;
  const pct = Math.max(0, Math.min(100, (elapsedMin / totalMin) * 100));
  const stops = baseStops.map((s) => ({
    ...s,
    reached: elapsedMin >= s.offsetMin,
    time: formatHHMM(new Date(departureDate.getTime() + s.offsetMin * 60000)),
  }));

  // Heure estimée dépassée sans confirmation manuelle : reste à l'état
  // "overdue" (clignote en rouge, compteur de retard croissant — voir
  // computeArrivalOverdueMin) plutôt que de griser automatiquement, pour ne
  // pas afficher "arrivée" avant d'en être sûr (même correctif que les
  // navettes internes, voir computeShuttleProgress). Le train reste affiché
  // en bout de rail (pct à 100) et continue de "chuguer" (voir .chugging
  // dans updateArrivalStates) tant que ce n'est pas confirmé.
  if (elapsedMin >= totalMin) return { state: 'overdue', label: "⏱ En retard, confirmez l'arrivée", pct: 100, stops };
  if (elapsedMin >= totalMin - imminentMin) return { state: 'imminent', label: '⚠ Arrivée imminente', pct, stops };
  if (elapsedMin < 0) return { state: 'scheduled', label: '', pct: 0, stops };
  return { state: 'enroute', label: 'En approche', pct, stops };
}

// Minutes restantes avant l'arrivée estimée (départ + group.offsetMinutes),
// même logique que computeShuttleRemainingMin ci-dessus pour les navettes —
// voir .arrival-countdown dans style.css.
function computeArrivalRemainingMin(id) {
  if (arrivals[id]?.arrivedManually) return null;
  const group = getArrivalEffectiveConfig(id);
  const departure = arrivals[id]?.departure;
  if (!group || !departure) return null;
  const parsedDeparture = parseHHMM(departure);
  if (!parsedDeparture) return null;
  const now = new Date();
  const departureDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsedDeparture.h, parsedDeparture.m, 0, 0);
  const elapsedMin = (now.getTime() - departureDate.getTime()) / 60000;
  const totalMin = group.offsetMinutes || 1;
  if (elapsedMin >= totalMin) return null;
  return Math.max(0, Math.round(totalMin - elapsedMin));
}

// Minutes de retard écoulées au-delà de l'heure d'arrivée estimée, même
// logique que computeShuttleOverdueMin ci-dessus pour les navettes.
function computeArrivalOverdueMin(id) {
  if (arrivals[id]?.arrivedManually) return null;
  const group = getArrivalEffectiveConfig(id);
  const departure = arrivals[id]?.departure;
  if (!group || !departure) return null;
  const parsedDeparture = parseHHMM(departure);
  if (!parsedDeparture) return null;
  const now = new Date();
  const departureDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsedDeparture.h, parsedDeparture.m, 0, 0);
  const elapsedMin = (now.getTime() - departureDate.getTime()) / 60000;
  const totalMin = group.offsetMinutes || 1;
  if (elapsedMin < totalMin) return null;
  return Math.max(0, Math.round(elapsedMin - totalMin));
}

// Mini-rail animé : ligne, repères d'étape (révélant l'heure de passage une
// fois atteints) et icône du train fret positionnée en pourcentage le long
// du trajet — voir .arrival-track dans style.css pour l'animation (transition
// CSS sur `left`, plus un léger "dandinement" tant que la navette est en
// approche).
function arrivalTrackHTML(progress) {
  return `
    <div class="arrival-track">
      <div class="arrival-track-line"></div>
      ${progress.stops.map((s) => `
        <div class="arrival-tick${s.reached ? ' reached' : ''}" style="left:${s.pct}%" title="${escapeHtml(s.label)}">
          <span class="arrival-tick-dot"></span>
          <span class="arrival-tick-time">${s.reached && s.time ? escapeHtml(s.time) : ''}</span>
        </div>`).join('')}
      <div class="arrival-track-icon${progress.state === 'enroute' ? ' chugging' : ''}" style="left:${progress.pct}%" aria-hidden="true">🚆</div>
    </div>`;
}

// Même principe que computeShuttleArrivalDelta ci-dessus, pour les
// arrivées (trains fret) — voir le bouton "✓ Arrivée effectuée" dans
// openArrivalModal, qui capture désormais aussi arrivedAt.
function computeArrivalArrivalDelta(id) {
  return computeArrivalDeltaFromRecord(arrivals[id], getArrivalEffectiveConfig(id));
}

// Variante de shuttleDeltaBadgeHTML avec un data-role dédié aux arrivées,
// pour ne jamais être confondue avec le badge d'écart des navettes lors
// d'un querySelector ciblé (voir updateArrivalStates).
function arrivalDeltaBadgeHTML(delta) {
  if (!delta) return '<span class="shuttle-delta-badge" data-role="arrival-delta" hidden></span>';
  return `<span class="shuttle-delta-badge tone-${delta.tone}" data-role="arrival-delta">${escapeHtml(formatDelayLabel(delta.diffMin, DELAY_THRESHOLDS))}</span>`;
}

function arrivalChipInnerHTML(id) {
  const group = findArrivalGroup(id);
  const rec = arrivals[id];
  const departure = rec?.departure;
  const eta = departure ? computeArrivalETA(id, departure) : null;
  const progress = computeArrivalProgress(id);
  const delayFlag = arrivalHasDelayFlag(id);
  const remainingMin = computeArrivalRemainingMin(id);
  const overdueMin = computeArrivalOverdueMin(id);
  const delta = computeArrivalArrivalDelta(id);
  // Même logique que shuttleChipInnerHTML ci-dessus : une fois confirmée
  // ("✓ Arrivée effectuée"), on affiche l'heure RÉELLE d'arrivée plutôt
  // que l'heure estimée.
  const realArrival = rec?.arrivedManually && rec.arrivedAt ? formatHHMM(new Date(rec.arrivedAt)) : null;
  return `
    <span class="arrival-label">${escapeHtml(group.label)}</span>
    ${departure
      ? `<span class="shuttle-times">Dép ${departure} → Arr${realArrival ? ' réelle' : ''} ${realArrival || eta}</span>`
      : `<span class="shuttle-times shuttle-times-empty">Départ non renseigné</span>`}
    ${arrivalTrackHTML(progress)}
    ${progress.label ? `<span class="shuttle-state-label" data-role="arrival-state-label">${escapeHtml(progress.label)}</span>` : '<span class="shuttle-state-label" data-role="arrival-state-label" hidden></span>'}
    <span class="shuttle-countdown" data-role="arrival-countdown" ${remainingMin === null ? 'hidden' : ''}>${remainingMin === null ? '' : `⏳ ${remainingMin} min`}</span>
    <span class="shuttle-overdue-badge" data-role="arrival-overdue" ${overdueMin === null ? 'hidden' : ''}>${overdueMin === null ? '' : `⏱ +${overdueMin} min`}</span>
    ${arrivalDeltaBadgeHTML(delta)}
    <span class="shuttle-delay-flag" data-role="arrival-delay-flag" ${delayFlag ? '' : 'hidden'}>⚠ Retard signalé</span>`;
}

function arrivalChipClass(id) {
  return `arrival-chip state-${computeArrivalProgress(id).state}${arrivalHasDelayFlag(id) ? ' has-delay' : ''}`;
}

function renderArrivalsBar() {
  const container = el('arrivalsBar');
  if (!container) return;
  const chips = getAllArrivalGroups().map((group) => `
    <button type="button" class="${arrivalChipClass(group.id)}" style="--arrival-color:${group.color}" data-arrival-id="${escapeHtml(group.id)}" title="${escapeHtml(group.label)}">
      ${arrivalChipInnerHTML(group.id)}
    </button>`).join('');
  container.innerHTML = `${chips}
    <button type="button" class="arrival-chip arrival-chip-add" id="btnAddArrival">+ Arrivée</button>`;
}

// Rafraîchissement toutes les secondes, ciblé (jamais de ré-écriture
// complète du innerHTML) : c'est ce qui permet à l'icône du train d'avancer
// en continu grâce à la transition CSS sur `left` (voir .arrival-track-icon
// dans style.css) plutôt que de "sauter" à chaque mise à jour.
function updateArrivalStates() {
  const container = el('arrivalsBar');
  if (!container) return;
  container.querySelectorAll('[data-arrival-id]').forEach((chip) => {
    const id = chip.dataset.arrivalId;
    const progress = computeArrivalProgress(id);
    const wantClass = arrivalChipClass(id);
    if (chip.className !== wantClass) chip.className = wantClass;

    const labelEl = chip.querySelector('[data-role="arrival-state-label"]');
    if (labelEl && labelEl.textContent !== progress.label) {
      labelEl.textContent = progress.label || '';
      labelEl.hidden = !progress.label;
    }
    const delayEl = chip.querySelector('[data-role="arrival-delay-flag"]');
    if (delayEl) delayEl.hidden = !arrivalHasDelayFlag(id);

    const countdownEl = chip.querySelector('[data-role="arrival-countdown"]');
    if (countdownEl) {
      const remainingMin = computeArrivalRemainingMin(id);
      const text = remainingMin === null ? '' : `⏳ ${remainingMin} min`;
      if (countdownEl.textContent !== text) countdownEl.textContent = text;
      countdownEl.hidden = remainingMin === null;
    }
    const overdueEl = chip.querySelector('[data-role="arrival-overdue"]');
    if (overdueEl) {
      const overdueMin = computeArrivalOverdueMin(id);
      const text = overdueMin === null ? '' : `⏱ +${overdueMin} min`;
      if (overdueEl.textContent !== text) overdueEl.textContent = text;
      overdueEl.hidden = overdueMin === null;
    }
    const deltaEl = chip.querySelector('[data-role="arrival-delta"]');
    if (deltaEl) {
      const delta = computeArrivalArrivalDelta(id);
      deltaEl.hidden = !delta;
      if (delta) {
        deltaEl.className = `shuttle-delta-badge tone-${delta.tone}`;
        deltaEl.textContent = formatDelayLabel(delta.diffMin, DELAY_THRESHOLDS);
      }
    }

    const icon = chip.querySelector('.arrival-track-icon');
    if (icon) {
      icon.style.left = `${progress.pct}%`;
      icon.classList.toggle('chugging', progress.state === 'enroute' || progress.state === 'overdue');
    }
    const ticks = chip.querySelectorAll('.arrival-tick');
    progress.stops.forEach((s, i) => {
      const tickEl = ticks[i];
      if (!tickEl || tickEl.classList.contains('reached') === Boolean(s.reached)) return;
      tickEl.classList.toggle('reached', Boolean(s.reached));
      const timeEl = tickEl.querySelector('.arrival-tick-time');
      if (timeEl) timeEl.textContent = s.reached && s.time ? s.time : '';
    });
  });
  maybeAutoRevealArrivalsBar();
}

function arrivalQuickStatusText(arrivedManually, delayFlag) {
  if (arrivedManually && delayFlag) return 'Marquée arrivée manuellement, avec un retard signalé.';
  if (arrivedManually) return 'Marquée arrivée manuellement (remplace le calcul automatique).';
  if (delayFlag) return 'Retard / souci signalé — repère visuel ajouté sur la vignette.';
  return 'Aucune anomalie signalée.';
}

function addArrivalStopRowInto(container, label = '', minutes = '') {
  const row = document.createElement('div');
  row.className = 'shuttle-stop-form-row';
  row.innerHTML = `
    <input type="text" class="fArrivalStopLabel" placeholder="ex : Passage frontière" value="${escapeHtml(label)}">
    <input type="number" class="fArrivalStopMin" placeholder="min" min="0" value="${escapeHtml(String(minutes))}">
    <button type="button" class="icon-btn" data-action="remove-arrival-stop" aria-label="Retirer cette étape">✕</button>`;
  container.appendChild(row);
}

function openArrivalModal(id) {
  const group = findArrivalGroup(id);
  if (!group) return;
  const rec = arrivals[id] || {};
  const departure = rec.departure || '';
  const arrivedManually = Boolean(rec.arrivedManually);
  const delayFlag = Boolean(rec.delayFlag);
  const effective = getArrivalEffectiveConfig(id);
  const stopsForForm = effective.stops.length ? effective.stops : [{ label: 'Arrivée', offsetMin: effective.offsetMinutes }];

  openModal({
    title: `Arrivée — ${escapeHtml(group.label)}`,
    wide: true,
    bodyHTML: `
      <form id="arrivalForm" class="stacked-form">
        <label>Heure de départ (origine)
          <div class="sillon-lookup-row">
            <input type="time" id="fArrivalDeparture" value="${departure}">
            <button type="button" class="btn btn-outline btn-sm" id="btnArrivalNow">Maintenant</button>
          </div>
        </label>
        <p class="help-text">Heure d'arrivée estimée (dernière étape ci-dessous) :</p>
        <p class="shuttle-arrival-preview" data-role="arrival-eta-preview">${departure ? computeArrivalETA(id, departure) : '--:--'}</p>

        <p class="help-text">
          Étapes (nom + minutes écoulées depuis le départ). La dernière
          étape de la liste définit l'heure d'arrivée estimée — modifiable
          librement pour ce trajet du jour uniquement (remis aux valeurs
          par défaut de Réglages le lendemain).
        </p>
        <div id="arrivalStopsContainer" class="extra-dates"></div>
        <button type="button" class="btn btn-ghost btn-sm" id="btnAddArrivalStop">+ Ajouter une étape</button>

        <div class="shuttle-quick-actions">
          <button type="button" class="btn ${arrivedManually ? 'btn-primary' : 'btn-outline'}" id="btnArrivalArrived" aria-pressed="${arrivedManually}">✓ Arrivée effectuée</button>
          <button type="button" class="btn ${delayFlag ? 'btn-danger' : 'btn-outline'}" id="btnArrivalDelay" aria-pressed="${delayFlag}">⚠ Retard / souci</button>
        </div>
        <p class="help-text" data-role="arrival-quick-status">${arrivalQuickStatusText(arrivedManually, delayFlag)}</p>

        <div class="form-actions">
          <button type="button" class="btn btn-outline" id="btnClearArrival">Effacer</button>
          <button type="submit" class="btn btn-primary">Enregistrer</button>
        </div>
      </form>`,
    onMount: (panel) => {
      const stopsContainer = panel.querySelector('#arrivalStopsContainer');
      stopsForForm.forEach((s) => addArrivalStopRowInto(stopsContainer, s.label, s.offsetMin));
      panel.querySelector('#btnAddArrivalStop').addEventListener('click', () => addArrivalStopRowInto(stopsContainer));
      stopsContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-action="remove-arrival-stop"]');
        if (removeBtn) removeBtn.closest('.shuttle-stop-form-row').remove();
      });

      const readFormStops = () => [...stopsContainer.querySelectorAll('.shuttle-stop-form-row')]
        .map((row) => ({
          label: row.querySelector('.fArrivalStopLabel').value.trim(),
          offsetMin: Number(row.querySelector('.fArrivalStopMin').value) || 0,
        }))
        .filter((s) => s.label)
        .sort((a, b) => a.offsetMin - b.offsetMin);

      const input = panel.querySelector('#fArrivalDeparture');
      const preview = panel.querySelector('[data-role="arrival-eta-preview"]');
      const refreshPreview = () => {
        if (!input.value) { preview.textContent = '--:--'; return; }
        const parsed = parseHHMM(input.value);
        if (!parsed) { preview.textContent = '--:--'; return; }
        const stops = readFormStops();
        const lastOffset = stops.length ? stops[stops.length - 1].offsetMin : effective.offsetMinutes;
        const base = new Date(2000, 0, 1, parsed.h, parsed.m, 0, 0);
        preview.textContent = formatHHMM(new Date(base.getTime() + lastOffset * 60000));
      };
      refreshPreview();
      input.addEventListener('input', refreshPreview);
      stopsContainer.addEventListener('input', refreshPreview);
      stopsContainer.addEventListener('click', refreshPreview);
      panel.querySelector('#btnArrivalNow').addEventListener('click', () => {
        input.value = formatHHMM(new Date());
        refreshPreview();
      });

      const arrivedBtn = panel.querySelector('#btnArrivalArrived');
      const delayBtn = panel.querySelector('#btnArrivalDelay');
      const statusEl = panel.querySelector('[data-role="arrival-quick-status"]');
      const refreshQuickButtons = () => {
        const current = arrivals[id] || {};
        arrivedBtn.classList.toggle('btn-primary', Boolean(current.arrivedManually));
        arrivedBtn.classList.toggle('btn-outline', !current.arrivedManually);
        arrivedBtn.setAttribute('aria-pressed', String(Boolean(current.arrivedManually)));
        delayBtn.classList.toggle('btn-danger', Boolean(current.delayFlag));
        delayBtn.classList.toggle('btn-outline', !current.delayFlag);
        delayBtn.setAttribute('aria-pressed', String(Boolean(current.delayFlag)));
        statusEl.textContent = arrivalQuickStatusText(current.arrivedManually, current.delayFlag);
      };
      arrivedBtn.addEventListener('click', () => {
        const current = arrivals[id] || {};
        current.arrivedManually = !current.arrivedManually;
        // Capture l'instant du clic comme heure réelle d'arrivée (même
        // logique que les navettes, voir computeArrivalArrivalDelta et
        // arrivalChipInnerHTML qui affiche désormais cette heure réelle à
        // la place de l'heure estimée une fois confirmée).
        current.arrivedAt = current.arrivedManually ? new Date().toISOString() : null;
        arrivals[id] = current;
        saveArrivals(arrivals);
        renderArrivalsBar();
        refreshQuickButtons();
        if (current.arrivedManually && current.arrivedAt) {
          const delta = computeArrivalArrivalDelta(id);
          pushShuttleLogIfConfigured('Arrivée', `${id}-arr`, `${group.label} (arrivée)`, current.departure ? computeArrivalETA(id, current.departure) : null, formatHHMM(new Date(current.arrivedAt)), delta?.diffMin ?? null);
        }
        showToast(current.arrivedManually ? `${group.label} marquée arrivée` : `${group.label} réactivée`);
      });
      delayBtn.addEventListener('click', () => {
        const current = arrivals[id] || {};
        current.delayFlag = !current.delayFlag;
        arrivals[id] = current;
        saveArrivals(arrivals);
        renderArrivalsBar();
        refreshQuickButtons();
        showToast(current.delayFlag ? `Retard signalé sur ${group.label}` : `Retard levé sur ${group.label}`);
      });

      panel.querySelector('#arrivalForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const current = arrivals[id] || {};
        current.departure = input.value || null;
        current.stops = readFormStops();
        arrivals[id] = current;
        saveArrivals(arrivals);
        renderArrivalsBar();
        closeModal();
        if (current.departure) pushShuttleLogIfConfigured('Arrivée', id, `${group.label} (départ)`, null, current.departure, null);
        showToast(`${group.label} mise à jour`);
      });
      panel.querySelector('#btnClearArrival').addEventListener('click', () => {
        arrivals[id] = { departure: null, arrivedManually: false, delayFlag: false, stops: null };
        saveArrivals(arrivals);
        renderArrivalsBar();
        closeModal();
        showToast(`${group.label} réinitialisée`);
      });
    },
  });
}

function openAddArrivalModal() {
  openModal({
    title: 'Ajouter une arrivée',
    wide: true,
    bodyHTML: `
      <form id="addArrivalForm" class="stacked-form">
        <div class="form-row">
          <label>Nom / destination
            <input type="text" id="fArrivalName" required placeholder="ex : Miramas">
          </label>
          <label>Couleur du cadre
            <input type="color" id="fArrivalColor" value="#64748b">
          </label>
        </div>
        <p class="help-text">
          Liste des étapes, avec le nombre de minutes écoulées depuis le
          départ pour chacune. La dernière étape définit l'heure d'arrivée
          estimée.
        </p>
        <div id="newArrivalStopsContainer" class="extra-dates"></div>
        <button type="button" class="btn btn-ghost btn-sm" id="btnAddNewArrivalStop">+ Ajouter une étape</button>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Ajouter l'arrivée</button>
        </div>
      </form>`,
    onMount: (panel) => {
      const stopsContainer = panel.querySelector('#newArrivalStopsContainer');
      addArrivalStopRowInto(stopsContainer);
      addArrivalStopRowInto(stopsContainer, 'Arrivée', 180);
      panel.querySelector('#btnAddNewArrivalStop').addEventListener('click', () => addArrivalStopRowInto(stopsContainer));
      stopsContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-action="remove-arrival-stop"]');
        if (removeBtn) removeBtn.closest('.shuttle-stop-form-row').remove();
      });
      panel.querySelector('#addArrivalForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = panel.querySelector('#fArrivalName').value.trim();
        const color = panel.querySelector('#fArrivalColor').value;
        const stops = [...stopsContainer.querySelectorAll('.shuttle-stop-form-row')]
          .map((row) => ({
            label: row.querySelector('.fArrivalStopLabel').value.trim(),
            offsetMin: Number(row.querySelector('.fArrivalStopMin').value) || 0,
          }))
          .filter((s) => s.label)
          .sort((a, b) => a.offsetMin - b.offsetMin);
        if (stops.length === 0) { showToast("Ajoutez au moins une étape (l'arrivée)", 'error'); return; }
        const newGroup = {
          id: 'custom-arrival-' + Date.now().toString(36),
          label: name || 'Arrivée',
          color,
          offsetMinutes: stops[stops.length - 1].offsetMin,
          imminentMin: ARRIVAL_DEFAULT_IMMINENT_MIN,
          stops: stops.slice(0, -1),
        };
        settings.customArrivalGroups = [...(settings.customArrivalGroups || []), newGroup];
        saveSettings(settings);
        renderArrivalsBar();
        closeModal();
        showToast(`Arrivée "${newGroup.label}" ajoutée`);
      });
    },
  });
}

function wireArrivalsBar() {
  const container = el('arrivalsBar');
  if (!container) return;
  container.addEventListener('click', (e) => {
    if (e.target.closest('#btnAddArrival')) { openAddArrivalModal(); return; }
    const btn = e.target.closest('[data-arrival-id]');
    if (btn) openArrivalModal(btn.dataset.arrivalId);
  });
  setInterval(updateArrivalStates, 1000);
}

// ---------- PDF récap du jour (bouton "📄 PDF récap") + archives ----------
// Génère entièrement côté client (PWA, pas de backend) via jsPDF, chargé
// en CDN dans index.html (window.jspdf.jsPDF) et mis en cache par le
// Service Worker comme chart.js — voir CDN_ASSETS dans service-worker.js.
// Reprend toutes les infos utiles du jour : trains (étapes, écarts, cause,
// composition/slot), navettes (ligne 1), tableau rapide des départs
// (ligne 2) et arrivées — sans toucher au stockage ni au Sheet.
//
// buildRecapPdfDoc() construit le document jsPDF à partir d'un instantané
// explicite (date + trains/navettes/réserves/arrivées de CE jour-là),
// plutôt que de lire directement les variables globales "aujourd'hui" :
// c'est ce qui permet de régénérer le PDF d'une journée qui vient de se
// terminer (archivage automatique silencieux à minuit, voir
// archiveDailyRecapSilently plus bas) sans dépendre de currentDate, qui a
// déjà basculé sur le nouveau jour à ce moment-là.
function pdfEcart(diffMin) {
  return diffMin === null || diffMin === undefined ? '—' : formatDelayLabel(diffMin, DELAY_THRESHOLDS);
}

function buildRecapPdfDoc(dateISO, { trainsForDate, shuttlesSnapshot, shuttleReservesSnapshot, arrivalsSnapshot }) {
  if (!window.jspdf || !window.jspdf.jsPDF) return null;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginLeft = 12;
  const marginBottom = 15;
  let y = 15;

  const ensureSpace = (lineHeight = 5.5) => {
    if (y + lineHeight > pageHeight - marginBottom) {
      doc.addPage();
      y = 15;
    }
  };
  const writeLine = (text, { size = 10, style = 'normal', gap = 5.5, indent = 0 } = {}) => {
    ensureSpace(gap);
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.text(String(text), marginLeft + indent, y);
    y += gap;
  };
  const writeSectionTitle = (text) => {
    y += 2;
    ensureSpace(8);
    doc.setDrawColor(180, 180, 180);
    doc.line(marginLeft, y - 3, 198, y - 3);
    writeLine(text, { size: 13, style: 'bold', gap: 7 });
  };

  writeLine(`Récap du jour — ${formatDateFR(dateISO)}`, { size: 17, style: 'bold', gap: 9 });
  writeLine(`Généré le ${formatDateFR(todayISO())} à ${formatHHMMSS(new Date())}`, { size: 9, style: 'italic', gap: 7 });

  // ---- Trains ----
  writeSectionTitle('🚆 Trains');
  if (trainsForDate.length === 0) {
    writeLine('Aucun train pour cette date.', { size: 10, style: 'italic' });
  }
  trainsForDate.forEach((train) => {
    const delays = computeAllStepDelays(train);
    const status = computeTrainStatus(train);
    const cause = computeMainCause(train);
    const destination = getQuickTrainDestination(train.number);
    writeLine(`TRAIN ${train.number}${destination ? ` → ${destination}` : ''} — ${status.label}`, { size: 11.5, style: 'bold', gap: 6 });
    train.steps.forEach((step, i) => {
      const d = delays[i];
      const real = d.realDate ? formatHHMM(d.realDate) : 'non enregistré';
      const ecart = d.status === 'recorded' ? pdfEcart(d.diffMin) : '—';
      writeLine(`${step.label} — théo. ${step.theoretical || '--:--'} / réel ${real} / écart ${ecart}`, { size: 9.5, gap: 4.8, indent: 4 });
    });
    if (cause.cause) {
      writeLine(`Cause principale : ${cause.cause}${cause.amountLabel && cause.amountLabel !== '--' ? ` (${cause.amountLabel})` : ''}`, { size: 9.5, style: 'italic', gap: 4.8, indent: 4 });
    }
    const compositionSummary = formatCompositionSummary(train.composition);
    if (compositionSummary) writeLine(`Composition : ${compositionSummary}`, { size: 9.5, gap: 4.8, indent: 4 });
    const slotSummary = train.trainType === 'slots' ? formatSlotSummary(train.slot) : '';
    if (slotSummary) writeLine(`SLOT : ${slotSummary}`, { size: 9.5, gap: 4.8, indent: 4 });
    y += 2;
  });

  // ---- Navettes (ligne 1) ----
  writeSectionTitle('🚌 Navettes (ligne 1)');
  const shuttleCodes = getAllShuttleGroups().flatMap((g) => g.codes);
  if (shuttleCodes.length === 0) writeLine('Aucune navette configurée.', { size: 10, style: 'italic' });
  shuttleCodes.forEach((code) => {
    const rec = shuttlesSnapshot[code] || {};
    const eta = rec.departure ? computeShuttleArrival(code, rec.departure) : null;
    const delta = computeArrivalDeltaFromRecord(rec, findShuttleGroup(code));
    const arrivalReal = rec.arrivedAt ? formatHHMM(new Date(rec.arrivedAt)) : null;
    writeLine(
      `${code} — départ ${rec.departure || '--:--'} / arrivée estimée ${eta || '--:--'}` +
      `${arrivalReal ? ` / arrivée réelle ${arrivalReal} (écart ${pdfEcart(delta?.diffMin)})` : ''}`,
      { size: 9.5, gap: 4.8, indent: 4 },
    );
  });

  // ---- Tableau rapide des départs (ligne 2) ----
  writeSectionTitle('⏱ Tableau rapide des départs navettes (ligne 2)');
  const quickboardKeys = [...SHUTTLE_QUICKBOARD_CODES, ...SHUTTLE_QUICKBOARD_RESERVE_FAMILIES];
  quickboardKeys.forEach((key) => {
    const theoretical = settings.quickboardTimings?.[key];
    const real = shuttleReservesSnapshot[key];
    const parsedTheo = parseHHMM(theoretical);
    const parsedReal = parseHHMM(real);
    let delta = null;
    if (parsedTheo && parsedReal) {
      const theoDate = new Date(2000, 0, 1, parsedTheo.h, parsedTheo.m, 0, 0);
      const realDate = new Date(2000, 0, 1, parsedReal.h, parsedReal.m, 0, 0);
      const diffMin = diffMinutes(theoDate, realDate);
      delta = { diffMin, tone: delayTone(diffMin, DELAY_THRESHOLDS) };
    }
    const label = SHUTTLE_QUICKBOARD_RESERVE_FAMILIES.includes(key) ? `Réserve ${key}` : key;
    writeLine(`${label} — théorique ${theoretical || '--:--'} / réel ${real || '--:--'} / écart ${pdfEcart(delta?.diffMin)}`, { size: 9.5, gap: 4.8, indent: 4 });
  });

  // ---- Arrivées ----
  writeSectionTitle('📥 Arrivées');
  const arrivalGroups = getAllArrivalGroups();
  if (arrivalGroups.length === 0) writeLine('Aucune arrivée configurée.', { size: 10, style: 'italic' });
  arrivalGroups.forEach((group) => {
    const rec = arrivalsSnapshot[group.id] || {};
    const eta = rec.departure ? computeArrivalETA(group.id, rec.departure) : null;
    const delta = computeArrivalDeltaFromRecord(rec, getArrivalEffectiveConfig(group.id));
    const arrivalReal = rec.arrivedAt ? formatHHMM(new Date(rec.arrivedAt)) : null;
    const statusText = rec.arrivedManually ? 'Arrivée effectuée' : (rec.delayFlag ? '⚠ Retard / souci signalé' : 'En attente');
    writeLine(
      `${group.label} — départ ${rec.departure || '--:--'} / ETA ${eta || '--:--'}` +
      `${arrivalReal ? ` / arrivée réelle ${arrivalReal} (écart ${pdfEcart(delta?.diffMin)})` : ''} / ${statusText}`,
      { size: 9.5, gap: 4.8, indent: 4 },
    );
  });

  return doc;
}

// Bouton "📄 PDF récap" : génère le PDF du jour EN COURS à partir de
// l'état actuel (en mémoire), le télécharge comme avant, et en garde aussi
// une copie dans les archives (voir js/archives.js et le bouton
// "🗄 Archives" ci-dessous) — écrase l'archive du jour si déjà générée
// aujourd'hui.
function generateDailyRecapPDF() {
  const doc = buildRecapPdfDoc(currentDate, {
    trainsForDate: getTodayTrains(),
    shuttlesSnapshot: shuttles,
    shuttleReservesSnapshot: shuttleReserves,
    arrivalsSnapshot: arrivals,
  });
  if (!doc) {
    showToast("Génération PDF indisponible (bibliothèque non chargée — vérifiez la connexion réseau au premier chargement)", 'error');
    return;
  }
  doc.save(`recap-${currentDate}.pdf`);
  saveArchivePdf(currentDate, doc.output('blob')).catch((err) => console.warn('Archivage PDF échoué', err));
  showToast('PDF récap généré ✓ (et archivé)');
}

// Archivage automatique et silencieux (pas de téléchargement) de la
// journée qui vient de se terminer — appelé juste avant la remise à zéro
// de minuit dans startClock. `snapshot` doit être capturé AVANT cette
// remise à zéro (shuttles/shuttleReserves/arrivals passent à {} juste
// après). Ne fait rien si la journée n'a eu aucune activité (aucun train,
// aucune navette, aucune arrivée), pour ne pas accumuler des archives
// vides tous les jours. Erreurs avalées (fire-and-forget) : un souci
// d'archivage ne doit jamais empêcher la bascule de minuit de se dérouler
// normalement.
async function archiveDailyRecapSilently(dateISO, snapshot) {
  try {
    const hasActivity = snapshot.trainsForDate.length > 0
      || Object.keys(snapshot.shuttlesSnapshot || {}).length > 0
      || Object.keys(snapshot.arrivalsSnapshot || {}).length > 0;
    if (!hasActivity) return;
    const doc = buildRecapPdfDoc(dateISO, snapshot);
    if (!doc) return;
    await saveArchivePdf(dateISO, doc.output('blob'));
    await pruneOldArchives();
  } catch (err) {
    console.warn('Archivage automatique du PDF échoué', err);
  }
}

function archiveSizeLabel(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} o`;
  return `${(bytes / 1024).toFixed(0)} Ko`;
}

// ---------- Archives (bouton "🗄 Archives") ----------
// Liste les PDF récap archivés (voir js/archives.js, IndexedDB) : un par
// jour, régénérable/écrasable à tout moment via "📄 PDF récap" pour
// aujourd'hui, ou créé automatiquement à minuit pour les jours passés
// (voir archiveDailyRecapSilently). Fonctionne hors-ligne (stockage local
// du navigateur, propre à cet appareil) ; purement consultatif, ne touche
// jamais aux données trains/navettes/arrivées elles-mêmes.
async function archivesBodyListHTML() {
  const entries = await listArchivePdfs();
  if (entries.length === 0) {
    return '<p class="help-text">Aucun PDF archivé pour l\'instant. Un PDF est ajouté ici automatiquement chaque jour (s\'il y a eu de l\'activité), ou dès que vous cliquez sur "📄 PDF récap".</p>';
  }
  return `
    <table class="history-table">
      <thead><tr><th>Date</th><th>Taille</th><th>Généré le</th><th></th><th></th></tr></thead>
      <tbody>
        ${entries.map((e) => `
          <tr>
            <td>${escapeHtml(formatDateFR(e.date))}</td>
            <td>${escapeHtml(archiveSizeLabel(e.size))}</td>
            <td>${e.generatedAt ? escapeHtml(formatHHMM(new Date(e.generatedAt))) : '—'}</td>
            <td><button type="button" class="btn btn-ghost" data-archive-download="${escapeHtml(e.date)}">Télécharger</button></td>
            <td><button type="button" class="icon-btn" data-archive-delete="${escapeHtml(e.date)}" aria-label="Supprimer cette archive">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function openArchivesModal() {
  openModal({
    title: '🗄 Archives des PDF récap',
    wide: true,
    bodyHTML: '<div id="archivesListContainer"><p class="help-text">Chargement…</p></div>',
    onMount: (panel) => {
      const container = panel.querySelector('#archivesListContainer');
      const refresh = async () => {
        container.innerHTML = await archivesBodyListHTML();
        container.querySelectorAll('[data-archive-download]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const dateISO = btn.dataset.archiveDownload;
            const entry = await getArchivePdf(dateISO);
            if (!entry) { showToast('Archive introuvable', 'error'); return; }
            const url = URL.createObjectURL(entry.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `recap-${dateISO}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          });
        });
        container.querySelectorAll('[data-archive-delete]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const dateISO = btn.dataset.archiveDelete;
            if (!confirm(`Supprimer l'archive du ${formatDateFR(dateISO)} ?`)) return;
            await deleteArchivePdf(dateISO);
            refresh();
          });
        });
      };
      refresh();
    },
  });
}

function wireHeaderButtons() {
  el('btnAddTrain').addEventListener('click', () => openTrainModal(null));
  el('btnSettings').addEventListener('click', openSettingsModal);
  el('btnHistory').addEventListener('click', openHistoryModal);
  el('btnSyncHeader').addEventListener('click', () => syncWithSheet());
  // Bouton principal (point 4 demandé) : renvoie d'un coup toutes les heures
  // déjà enregistrées aujourd'hui vers Google Sheets — reprend la même
  // logique que le bouton "Renvoyer aujourd'hui vers Sheets" de Réglages
  // (utile par ex. après une saisie faite hors-ligne).
  el('btnPushTodayHeader').addEventListener('click', () => pushTodayToSheet());
  // Bouton "📄 PDF récap" : génère un PDF récapitulatif complet de la
  // journée (trains, navettes, tableau rapide, arrivées) — voir
  // generateDailyRecapPDF ci-dessus.
  el('btnDailyRecapPdf').addEventListener('click', generateDailyRecapPDF);
  // Bouton "🗄 Archives" : ouvre la liste des PDF récap archivés — voir
  // openArchivesModal ci-dessus.
  const archivesBtn = el('btnArchives');
  if (archivesBtn) archivesBtn.addEventListener('click', openArchivesModal);
}

// Une PWA installée peut rester "suspendue" en arrière-plan pendant des
// heures (Android met la page en pause plutôt que de la fermer) : à la
// réouverture, le navigateur redonne parfois la main à cette PAGE FIGÉE
// telle qu'elle était (au lieu d'en recharger une neuve), avec en mémoire
// un `trains`/`settings` périmé — par exemple vide, si l'app avait été
// ouverte avant même le premier train du jour. Résultat : "Aucun train"
// alors que des trains existent bel et bien dans le stockage local, jusqu'à
// ce qu'une action quelconque (comme ouvrir Réglages) déclenche un nouveau
// rendu. On se protège de ça en relisant tout depuis le stockage et en
// redessinant dès que l'app redevient visible/active — sans toucher à une
// modale déjà ouverte (édition en cours).
function refreshFromStorage() {
  if (document.body.classList.contains('modal-open')) return;
  settings = loadSettings();
  trains = loadTrains();
  shuttles = loadShuttles();
  shuttleReserves = loadShuttleReserves();
  arrivals = loadArrivals();
  currentDate = todayISO();
  applyTheme();
  updateDateLabel();
  renderGrid();
  renderShuttlesBar();
  renderShuttleQuickboard();
  renderArrivalsBar();
  setSyncIndicator(settings.sheetsWebAppUrl ? 'loading' : 'none');
  if (settings.sheetsWebAppUrl) syncWithSheet({ silent: true });
}

function wireVisibilityRefresh() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshFromStorage();
  });
  // bfcache (retour arrière/avant du navigateur) : la page peut être
  // restaurée telle quelle, sans ré-exécuter ce script, avec le même risque
  // de données périmées.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) refreshFromStorage();
  });
}

// ---------- Animation d'introduction (~7 s au lancement) ----------
// Overlay purement cosmétique défini dans index.html (#introSplash) et
// css/style.css (.intro-*) : vidéo du logo LHTE avec musique
// (assets/lhte-intro.mp4). Ne bloque jamais l'app en dessous (déjà en
// cours d'initialisation juste après, voir init()) ni l'utilisateur :
// cliquer/toucher l'overlay, le bouton "Passer", ou Échap/Entrée/Espace la
// fait disparaître immédiatement. Disparaît aussi toute seule à la fin de
// la vidéo, ou très vite si la vidéo ne peut pas démarrer (fichier absent,
// format non supporté...) pour ne jamais laisser un écran figé.
//
// Son : les navigateurs interdisent souvent de lancer du son sans action de
// l'utilisateur (sauf, en général, quand l'app est installée en PWA). On
// tente donc la lecture AVEC le son ; si c'est refusé, la vidéo se lance
// sans le son et un bouton "🔊 Activer le son" apparaît. Le bouton permet
// aussi de couper le son ; ce choix est mémorisé sur l'appareil.
// Si le système demande de réduire les animations (prefers-reduced-motion),
// l'intro n'est pas jouée du tout, par respect de ce réglage.
const INTRO_SOUND_PREF_KEY = 'traintrack.introSoundMuted';
const INTRO_START_TIMEOUT_MS = 2500;
// Moment de la vidéo (en s) où le slogan "électrique" s'allume (juste après
// le flash du logo), et petite pause sur la dernière image avant de fermer
// l'intro, le temps de lire le slogan en entier.
const INTRO_TAGLINE_AT_S = 3.6;
const INTRO_END_HOLD_MS = 600;
// Dégradé du slogan : couleurs des navettes (FL orange, AL jaune, NL bleu,
// éclairci pour rester lisible sur fond nuit) puis des trains (NAVILAND
// violet, FERROVERGNE orange).
const INTRO_TAGLINE_COLORS = ['#f59e0b', '#eab308', '#60a5fa', '#a78bfa', '#fb923c'];

function mixHexColors(a, b, t) {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

// Découpe le slogan en mots (insécables) puis en lettres, chacune avec sa
// couleur (position dans le dégradé), son délai d'allumage et un léger
// décalage de grésillement — voir .intro-tagline-* dans css/style.css.
function buildIntroTagline(container) {
  const text = container.textContent.trim();
  const letters = text.replace(/\s+/g, '').length;
  const stops = INTRO_TAGLINE_COLORS;
  let index = 0;
  const colorAt = (k) => {
    const pos = letters > 1 ? (k / (letters - 1)) * (stops.length - 1) : 0;
    const i = Math.min(Math.floor(pos), stops.length - 2);
    return mixHexColors(stops[i], stops[i + 1], pos - i);
  };
  const wordsHTML = text.split(/\s+/).map((word) => {
    const chars = [...word].map((ch) => {
      const k = index++;
      const delay = (k * 0.022 + (k % 3) * 0.04).toFixed(3);
      const buzz = ((k * 7) % 11 / 5).toFixed(2);
      return `<span class="intro-tagline-char" style="--c:${colorAt(k)};--d:${delay}s;--b:${buzz}s">${escapeHtml(ch)}</span>`;
    }).join('');
    return `<span class="intro-tagline-word">${chars}</span>`;
  }).join(' ');
  container.innerHTML = `<span class="intro-tagline-text">${wordsHTML}</span><span class="intro-tagline-spark"></span>`;
}

function readIntroMutedPref() {
  try { return localStorage.getItem(INTRO_SOUND_PREF_KEY) === '1'; } catch (err) { return false; }
}
function writeIntroMutedPref(muted) {
  try { localStorage.setItem(INTRO_SOUND_PREF_KEY, muted ? '1' : '0'); } catch (err) { /* stockage indisponible */ }
}

function playIntroSplash() {
  const splash = document.getElementById('introSplash');
  if (!splash) return;
  const video = document.getElementById('introVideo');
  const soundBtn = document.getElementById('introSoundBtn');
  const skipBtn = document.getElementById('introSkipBtn');
  const tagline = document.getElementById('introTagline');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduceMotion || !video || typeof video.play !== 'function') {
    if (video) video.removeAttribute('src');
    splash.remove();
    return;
  }

  document.body.classList.add('intro-active');
  if (tagline) buildIntroTagline(tagline);
  let dismissed = false;
  let safetyTimer = null;

  const updateSoundBtn = () => {
    if (!soundBtn) return;
    soundBtn.hidden = false;
    soundBtn.textContent = video.muted ? '🔊 Activer le son' : '🔇 Couper le son';
  };

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(safetyTimer);
    splash.classList.add('is-leaving');
    document.body.classList.remove('intro-active');
    // Petit fondu du son pendant le fondu de l'image (ignoré sur iOS, où le
    // volume n'est pas pilotable : la vidéo est alors simplement stoppée).
    const startVolume = video.volume;
    const fadeStart = performance.now();
    const fadeAudio = (now) => {
      const k = Math.min(1, (now - fadeStart) / 450);
      try { video.volume = startVolume * (1 - k); } catch (err) { /* lecture seule */ }
      if (k < 1 && splash.isConnected) requestAnimationFrame(fadeAudio);
    };
    requestAnimationFrame(fadeAudio);
    const cleanup = () => {
      if (!splash.isConnected) return;
      video.pause();
      video.removeAttribute('src');
      video.load();
      splash.remove();
    };
    splash.addEventListener('transitionend', cleanup, { once: true });
    // Filet de sécurité si transitionend ne se déclenche jamais (onglet en
    // arrière-plan, etc.) : l'overlay doit disparaître coûte que coûte pour
    // ne jamais bloquer l'accès à l'app.
    setTimeout(cleanup, 700);
  };

  splash.addEventListener('click', dismiss);
  splash.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') dismiss();
  });
  if (skipBtn) skipBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  if (soundBtn) {
    soundBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      video.muted = !video.muted;
      writeIntroMutedPref(video.muted);
      // Ce clic est une action de l'utilisateur : le navigateur autorise
      // maintenant le son, on relance la lecture au cas où elle aurait été
      // suspendue.
      if (video.paused) video.play().catch(() => {});
      updateSoundBtn();
    });
  }

  video.addEventListener('ended', () => {
    if (tagline) tagline.classList.add('is-on');
    setTimeout(dismiss, INTRO_END_HOLD_MS);
  });
  video.addEventListener('error', dismiss);
  video.addEventListener('timeupdate', () => {
    if (tagline && video.currentTime >= INTRO_TAGLINE_AT_S) tagline.classList.add('is-on');
  });
  // Une fois la lecture réellement lancée, filet de sécurité calé sur la
  // durée de la vidéo (au cas où l'événement "ended" ne viendrait jamais).
  video.addEventListener('playing', () => {
    clearTimeout(safetyTimer);
    const remaining = Number.isFinite(video.duration) ? (video.duration - video.currentTime) : 8;
    safetyTimer = setTimeout(dismiss, Math.max(1, remaining) * 1000 + 1500);
  }, { once: true });
  // Vidéo qui ne démarre pas (hors-ligne sans cache, décodage impossible...).
  safetyTimer = setTimeout(dismiss, INTRO_START_TIMEOUT_MS);

  video.muted = readIntroMutedPref();
  video.play().then(updateSoundBtn).catch((err) => {
    if (dismissed) return;
    if (err && err.name === 'NotAllowedError' && !video.muted) {
      // Son refusé par le navigateur : on joue sans le son.
      video.muted = true;
      video.play().then(updateSoundBtn).catch(dismiss);
    } else {
      dismiss();
    }
  });
}

function init() {
  playIntroSplash();
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') applyTheme();
  });

  if (!settings.hasSeeded && trains.length === 0) {
    trains = seedDemoTrains(settings.defaultStepLabels);
    settings.hasSeeded = true;
    saveSettings(settings);
    saveTrains(trains);
  }

  updateDateLabel();
  renderGrid();
  startClock();
  pruneOldArchives().catch(() => {});

  const grid = el('trainsGrid');
  grid.addEventListener('click', onGridClick);
  wireDragAndDrop(grid);
  wireSillonInputs(grid);

  wireHeaderButtons();
  initStopwatch(el('stopwatchWidget'));
  renderShuttlesBar();
  wireShuttlesBar();
  renderShuttleQuickboard();
  wireShuttleQuickboard();
  renderArrivalsBar();
  wireArrivalsBar();
  wireBarToggles();
  applyPanelVisibility();
  wireQuickTrainsBar();
  wireInstallPrompt();
  registerServiceWorker();
  wireVisibilityRefresh();
  setSyncIndicator(settings.sheetsWebAppUrl ? 'loading' : 'none');

  if (settings.sheetsWebAppUrl) syncWithSheet({ silent: true });
}

document.addEventListener('DOMContentLoaded', init);
