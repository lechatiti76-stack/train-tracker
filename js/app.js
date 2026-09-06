// Point d'entrée de l'application. Gère l'état en mémoire, le rendu et
// tous les événements utilisateur. Les modules importés ne touchent ni au
// DOM (delay-calc, time-utils, storage, sheets-sync) ni à l'état global
// (card, charts, splitflap), ce qui garde ce fichier comme seul chef
// d'orchestre.
import { DELAY_THRESHOLDS } from './config.js';
import { loadTrains, saveTrains, loadSettings, saveSettings, createEmptyTrain, todayISO, seedDemoTrains } from './storage.js';
import { computeAllStepDelays, computeMainCause, computeTrainStatus, applyOffsetSteps } from './delay-calc.js';
import { formatHHMM, formatHHMMSS, formatDelayLabel, nowLocalISOWithSeconds } from './time-utils.js';
import { fetchTheoreticalFromSheet, mergeSheetRowsIntoTrains, findSillonByArrivalTime, applySillonRowsToTrain } from './sheets-sync.js';
import { SplitFlapDisplay } from './splitflap.js';
import { createDelayChart, updateDelayChart } from './charts.js';
import { trainCardTemplate, updateCardDynamicParts, escapeHtml } from './card.js';
import { initStopwatch } from './stopwatch.js';

let settings = loadSettings();
let trains = loadTrains();
let currentDate = todayISO();

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
    return;
  }

  grid.innerHTML = todays.map((t) => trainCardTemplate(t, { readOnly: false })).join('');
  for (const train of todays) mountCardExtras(train);
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
  showToast(`${step.label} enregistré à ${formatHHMMSS(new Date(step.real))}`);
}

function resetStepTime(train, stepIndex) {
  if (!confirm("Réinitialiser l'heure enregistrée pour cette étape ?")) return;
  train.steps[stepIndex].real = null;
  train.updatedAt = new Date().toISOString();
  persist();
  refreshTrainCard(train);
  showToast('Heure réinitialisée');
}

function resetAllStepsForTrain(train) {
  const recordedCount = train.steps.filter((s) => s.real).length;
  if (recordedCount === 0) {
    showToast('Aucune heure enregistrée à réinitialiser');
    return;
  }
  if (!confirm(`Réinitialiser les ${recordedCount} heure(s) enregistrée(s) pour le train ${train.number} ?`)) return;
  train.steps.forEach((s) => { s.real = null; });
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
    case 'lookup-sillon': {
      const input = cardEl.querySelector('[data-role="arrival-lookup"]');
      lookupSillonByArrival(train, input?.value);
      break;
    }
    default: break;
  }
}

function wireSillonInputs(grid) {
  grid.addEventListener('change', (e) => {
    const input = e.target.closest('[data-role="arrival-lookup"]');
    if (!input) return;
    const cardEl = input.closest('.train-card');
    const train = findTrain(cardEl?.dataset.trainId);
    if (!train) return;
    train.targetArrival = input.value || null;
    persist();
  });
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('[data-role="arrival-lookup"]');
    if (!input) return;
    e.preventDefault();
    const cardEl = input.closest('.train-card');
    const train = findTrain(cardEl?.dataset.trainId);
    if (train) lookupSillonByArrival(train, input.value);
  });
}

function setSillonStatus(trainId, state, extra) {
  const cardEl = grid_cardEl(trainId);
  const el = cardEl?.querySelector('[data-role="sillon-status"]');
  if (!el) return;
  const messages = {
    loading: 'Recherche du sillon…',
    ok: `Sillon ${extra} appliqué`,
    'not-found': "Aucun sillon trouvé dans le Sheet pour cette heure, ce jour-là.",
    error: `Google Sheets indisponible${extra ? ' (' + extra + ')' : ''}.`,
  };
  el.textContent = messages[state] || '';
  el.className = `sillon-lookup-status status-${state}`;
}

async function lookupSillonByArrival(train, timeValue) {
  if (!timeValue) return;
  if (!settings.sheetsWebAppUrl) {
    showToast("Configurez d'abord l'URL Google Sheets dans les Réglages", 'error');
    setSillonStatus(train.id, 'error', 'non configuré');
    return;
  }
  setSillonStatus(train.id, 'loading');
  const res = await fetchTheoreticalFromSheet(settings.sheetsWebAppUrl, train.date);
  if (!res.ok) {
    const detail = SYNC_ERROR_LABELS[res.reason] || res.reason;
    setSillonStatus(train.id, 'error', detail);
    showToast('Google Sheets indisponible', 'error');
    return;
  }

  const match = findSillonByArrivalTime(res.rows, train.date, timeValue);
  if (!match) {
    setSillonStatus(train.id, 'not-found');
    showToast('Aucun sillon trouvé pour cette heure', 'error');
    return;
  }

  applySillonRowsToTrain(train, match.rows);
  applyOffsetSteps(train);
  train.number = match.trainNumber || train.number;
  train.targetArrival = timeValue;
  train.source = 'sheet';
  train.updatedAt = new Date().toISOString();
  persist();
  refreshTrainCard(train);
  setSillonStatus(train.id, 'ok', match.trainNumber);
  showToast(`Sillon ${match.trainNumber} appliqué (${match.rows.length} horaires)`);
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
              <input type="text" class="fStepCause" data-i="${i}" value="${escapeHtml(stepCause[i])}" placeholder="ex : Signalisation">
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
  if (existingTrain) showToast('Train mis à jour');
  else showToast(createdCount > 1 ? `${createdCount} vignettes ajoutées (une par date)` : 'Train ajouté');
}

// ---------- Modale Réglages ----------
function syncInfoText() {
  if (!settings.lastSyncAt) return 'Aucune synchronisation effectuée pour le moment.';
  const date = new Date(settings.lastSyncAt);
  const status = settings.lastSyncStatus === 'ok' ? 'réussie' : 'échouée';
  return `Dernière synchronisation ${status} à ${formatHHMM(date)}.`;
}

function settingsBodyHTML() {
  return `
    <form id="settingsForm" class="stacked-form">
      <label>URL du Web App Google Apps Script (horaires théoriques)
        <input type="url" id="sSheetUrl" value="${escapeHtml(settings.sheetsWebAppUrl || '')}" placeholder="https://script.google.com/macros/s/AKfycb.../exec">
      </label>
      <p class="help-text">Laissez vide pour saisir les horaires uniquement à la main. Voir le README pour créer ce Web App (aucune clé API n'est requise, aucun secret côté navigateur).</p>

      <div class="steps-form-list">
        <p class="help-text">Libellés par défaut des 7 étapes (nouveaux trains uniquement) :</p>
        ${settings.defaultStepLabels.map((l, i) => `
          <label>Étape ${i + 1}
            <input type="text" class="sStepLabel" data-i="${i}" value="${escapeHtml(l)}" required>
          </label>`).join('')}
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
        <button type="button" id="btnSyncNow" class="btn btn-outline">Synchroniser maintenant</button>
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
      panel.querySelector('#settingsForm').addEventListener('submit', (e) => {
        e.preventDefault();
        settings.sheetsWebAppUrl = panel.querySelector('#sSheetUrl').value.trim();
        settings.defaultStepLabels = sortedByIndex([...panel.querySelectorAll('.sStepLabel')]).map((i) => i.value.trim());
        settings.theme = panel.querySelector('#sTheme').value;
        saveSettings(settings);
        applyTheme();
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

// ---------- Initialisation ----------
function wireHeaderButtons() {
  el('btnAddTrain').addEventListener('click', () => openTrainModal(null));
  el('btnSettings').addEventListener('click', openSettingsModal);
  el('btnHistory').addEventListener('click', openHistoryModal);
  el('btnSyncHeader').addEventListener('click', () => syncWithSheet());
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
  wireInstallPrompt();
  registerServiceWorker();
  setSyncIndicator(settings.sheetsWebAppUrl ? 'loading' : 'none');

  if (settings.sheetsWebAppUrl) syncWithSheet({ silent: true });
}

document.addEventListener('DOMContentLoaded', init);
