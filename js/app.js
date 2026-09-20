// Point d'entrée de l'application. Gère l'état en mémoire, le rendu et
// tous les événements utilisateur. Les modules importés ne touchent ni au
// DOM (delay-calc, time-utils, storage, sheets-sync) ni à l'état global
// (card, charts, splitflap), ce qui garde ce fichier comme seul chef
// d'orchestre.
import { DELAY_THRESHOLDS, SHUTTLE_GROUPS, SHUTTLE_DEFAULT_IMMINENT_MIN, ARRIVAL_GROUPS, ARRIVAL_DEFAULT_IMMINENT_MIN, QUICK_TRAIN_OPERATOR_COLORS, DEFAULT_SETTINGS } from './config.js';
import { loadTrains, saveTrains, loadSettings, saveSettings, createEmptyTrain, todayISO, seedDemoTrains, loadShuttles, saveShuttles, loadArrivals, saveArrivals } from './storage.js';
import { computeAllStepDelays, computeMainCause, computeTrainStatus, applyOffsetSteps, applySillonSequence, suggestCauseForLabel } from './delay-calc.js';
import { formatHHMM, formatHHMMSS, formatDelayLabel, nowLocalISOWithSeconds, parseHHMM } from './time-utils.js';
import { fetchTheoreticalFromSheet, mergeSheetRowsIntoTrains, pushStepToSheet, pushAllStepsToSheet } from './sheets-sync.js';
import { SplitFlapDisplay } from './splitflap.js';
import { createDelayChart, updateDelayChart } from './charts.js';
import { trainCardTemplate, updateCardDynamicParts, escapeHtml } from './card.js';
import { initStopwatch } from './stopwatch.js';

let settings = loadSettings();
let trains = loadTrains();
let currentDate = todayISO();
let shuttles = loadShuttles();
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
function showToast(message, type = 'success') {
  const container = el('toastContainer');
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.textContent = message;
  container.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 300);
  }, 2600);
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
function recordStepNow(train, stepIndex) {
  const step = train.steps[stepIndex];
  step.real = nowLocalISOWithSeconds();
  train.updatedAt = new Date().toISOString();
  persist();
  refreshTrainCard(train);
  pushStepIfConfigured(train, stepIndex);
  showToast(`${step.label} enregistré à ${formatHHMMSS(new Date(step.real))}`);
}

function resetStepTime(train, stepIndex) {
  if (!confirm("Réinitialiser l'heure enregistrée pour cette étape ?")) return;
  train.steps[stepIndex].real = null;
  train.updatedAt = new Date().toISOString();
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

function buildTrainReportText(train) {
  const delays = computeAllStepDelays(train);
  const status = computeTrainStatus(train);
  const cause = computeMainCause(train);
  const lines = [`TRAIN ${train.number}`, `Date : ${formatDateFR(train.date)}`, ''];

  train.steps.forEach((step, i) => {
    const d = delays[i];
    lines.push(step.label);
    lines.push(`Théorique : ${step.theoretical || 'Non renseignée'}`);
    lines.push(`Réel : ${d.realDate ? formatHHMM(d.realDate) : 'Non enregistré'}`);
    lines.push(`Écart : ${d.status === 'recorded' ? formatDelayLabel(d.diffMin, DELAY_THRESHOLDS) : '—'}`);
    lines.push('');
  });

  lines.push('Cause principale :');
  lines.push(cause.cause);
  if (cause.amountLabel && cause.amountLabel !== '--') lines.push(cause.amountLabel);
  lines.push('');
  lines.push(`Statut global : ${status.label}`);
  return lines.join('\n');
}

async function copyTrainData(train) {
  const text = buildTrainReportText(train);
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

function emailTrainData(train) {
  const subject = `Suivi train ${train.number} - ${formatDateFR(train.date)}`;
  const body = buildTrainReportText(train);
  window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
          const i = btn.dataset.i;
          const fieldset = btn.closest('.step-form-row');
          const labelInput = fieldset?.querySelector('.fStepLabel');
          const causeInput = fieldset?.querySelector('.fStepCause');
          if (!causeInput) return;
          const suggestion = suggestCauseForLabel(labelInput?.value || btn.dataset.label);
          if (suggestion) causeInput.value = suggestion;
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
function addQuickTrainRowInto(container, { number = '', operator = '', destination = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'quick-train-form-row date-row-extra';
  row.innerHTML = `
    <input type="text" class="fQuickTrainNumber" placeholder="Numéro" inputmode="numeric" value="${escapeHtml(number)}" style="max-width:110px;">
    <input type="text" class="fQuickTrainOperator" placeholder="Opérateur (ex : NAVILAND)" value="${escapeHtml(operator)}">
    <input type="text" class="fQuickTrainDestination" placeholder="Destination" value="${escapeHtml(destination)}">
    <button type="button" class="icon-btn" data-action="remove-quick-train-row" aria-label="Retirer ce train">✕</button>`;
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
          Navettes internes — réglages par famille. Les horaires de FL/NL/AL
          sont identiques par défaut ; ajustez-les ici indépendamment selon
          vos observations, ça se sauvegarde pour toutes les navettes de la
          famille (FL1/FL2/FL3, NL1/NL2, AL1/AL2). "Seuil de clignotement"
          est le nombre de minutes avant l'arrivée estimée à partir duquel la
          vignette clignote en rouge ("Arrivée imminente").
        </p>
        ${getAllShuttleGroups().filter((g) => !g.id.startsWith('custom-')).map((g) => shuttleTimingSectionHTML(g)).join('')}
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
          }))
          .filter((t) => t.number);
        settings.quickTrainsEnrichedV2 = true;

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

        settings.theme = panel.querySelector('#sTheme').value;
        saveSettings(settings);
        applyTheme();
        renderQuickTrainsBar();
        renderShuttlesBar();
        renderArrivalsBar();
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

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => console.warn('Service worker non enregistré', err));
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
//   minutes de l'arrivée estimée) -> arrivée (grisée).
// Exemple (FL, départ validé à 10:19, arrivée = +35 min = 10:54,
// imminentMin = 10) : 10:19-10:20 "Partie du Terminal", 10:21 "Départ FS"
// (passage à +2 min), 10:24 "CV 1474" (+5), 10:34 "Entrée GB" (+15), 10:42
// "Sortie GB" (+23), puis dès 10:44 (10:54 - 10 min) "⚠ Arrivée imminente"
// clignotante, et "Arrivée effectuée" (grisée) à partir de 10:54.
// "arrivedManually" (bouton "Navette arrivée") court-circuite ce calcul :
// utile quand l'heure réelle ne correspond pas à l'estimation automatique.
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

  if (elapsedMin >= arrivalOffset) return { state: 'arrived', label: 'Arrivée effectuée' };
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

function shuttleChipInnerHTML(code) {
  const departure = shuttles[code]?.departure;
  const arrival = departure ? computeShuttleArrival(code, departure) : null;
  const progress = computeShuttleProgress(code);
  const delayFlag = shuttleHasDelayFlag(code);
  return `
    <span class="shuttle-code">${escapeHtml(code)}</span>
    ${departure
      ? `<span class="shuttle-times">Dép ${departure} → Arr ${arrival}</span>`
      : `<span class="shuttle-times shuttle-times-empty">Départ non renseigné</span>`}
    ${progress.label ? `<span class="shuttle-state-label" data-role="shuttle-state-label">${escapeHtml(progress.label)}</span>` : '<span class="shuttle-state-label" data-role="shuttle-state-label" hidden></span>'}
    <span class="shuttle-delay-flag" data-role="shuttle-delay-flag" ${delayFlag ? '' : 'hidden'}>⚠ Retard signalé</span>`;
}

function shuttleChipClass(code) {
  return `shuttle-chip state-${computeShuttleProgress(code).state}${shuttleHasDelayFlag(code) ? ' has-delay' : ''}`;
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
  });
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
          <div class="shuttle-stops">
            <p class="help-text">Passages (calculés depuis l'heure de départ ci-dessus) :</p>
            <ul class="shuttle-stops-list" data-role="shuttle-stops-list">
              ${group.stops.map((s) => `<li><span>${escapeHtml(s.label)}</span><span data-offset="${s.offsetMin}">--:--</span></li>`).join('')}
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
        shuttles[code] = current;
        saveShuttles(shuttles);
        renderShuttlesBar();
        refreshQuickButtons();
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
        showToast(`Navette ${code} mise à jour`);
      });
      panel.querySelector('#btnClearShuttle').addEventListener('click', () => {
        shuttles[code] = { departure: null, arrivedManually: false, delayFlag: false };
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

  if (elapsedMin >= totalMin) return { state: 'arrived', label: 'Arrivée effectuée', pct: 100, stops };
  if (elapsedMin >= totalMin - imminentMin) return { state: 'imminent', label: '⚠ Arrivée imminente', pct, stops };
  if (elapsedMin < 0) return { state: 'scheduled', label: '', pct: 0, stops };
  return { state: 'enroute', label: 'En approche', pct, stops };
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

function arrivalChipInnerHTML(id) {
  const group = findArrivalGroup(id);
  const departure = arrivals[id]?.departure;
  const eta = departure ? computeArrivalETA(id, departure) : null;
  const progress = computeArrivalProgress(id);
  const delayFlag = arrivalHasDelayFlag(id);
  return `
    <span class="arrival-label">${escapeHtml(group.label)}</span>
    ${departure
      ? `<span class="shuttle-times">Dép ${departure} → Arr ${eta}</span>`
      : `<span class="shuttle-times shuttle-times-empty">Départ non renseigné</span>`}
    ${arrivalTrackHTML(progress)}
    ${progress.label ? `<span class="shuttle-state-label" data-role="arrival-state-label">${escapeHtml(progress.label)}</span>` : '<span class="shuttle-state-label" data-role="arrival-state-label" hidden></span>'}
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

    const icon = chip.querySelector('.arrival-track-icon');
    if (icon) {
      icon.style.left = `${progress.pct}%`;
      icon.classList.toggle('chugging', progress.state === 'enroute');
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
        arrivals[id] = current;
        saveArrivals(arrivals);
        renderArrivalsBar();
        refreshQuickButtons();
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

function wireHeaderButtons() {
  el('btnAddTrain').addEventListener('click', () => openTrainModal(null));
  el('btnSettings').addEventListener('click', openSettingsModal);
  el('btnHistory').addEventListener('click', openHistoryModal);
  el('btnSyncHeader').addEventListener('click', () => syncWithSheet());
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
  arrivals = loadArrivals();
  currentDate = todayISO();
  applyTheme();
  updateDateLabel();
  renderGrid();
  renderShuttlesBar();
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

function init() {
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

  const grid = el('trainsGrid');
  grid.addEventListener('click', onGridClick);
  wireDragAndDrop(grid);
  wireSillonInputs(grid);

  wireHeaderButtons();
  initStopwatch(el('stopwatchWidget'));
  renderShuttlesBar();
  wireShuttlesBar();
  renderArrivalsBar();
  wireArrivalsBar();
  wireQuickTrainsBar();
  wireInstallPrompt();
  registerServiceWorker();
  wireVisibilityRefresh();
  setSyncIndicator(settings.sheetsWebAppUrl ? 'loading' : 'none');

  if (settings.sheetsWebAppUrl) syncWithSheet({ silent: true });
}

document.addEventListener('DOMContentLoaded', init);
