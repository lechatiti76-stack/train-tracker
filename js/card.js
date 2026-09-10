// Construction et mise à jour du DOM d'une vignette train.
// Rendu en chaîne HTML (simple et suffisant à cette échelle), avec re-requête
// des sous-éléments pour les mises à jour ciblées (pas de framework).
import { computeAllStepDelays, computeTrainStatus, computeMainCause } from './delay-calc.js';
import { formatHHMM, formatHHMMSS, formatDelayLabel } from './time-utils.js';
import { DELAY_THRESHOLDS } from './config.js';

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function statusToneClass(tone) {
  return `tone-${tone || 'neutral'}`;
}

function stepRowHTML(train, index, readOnly) {
  const step = train.steps[index];
  const delay = computeAllStepDelays(train)[index];
  const hasReal = Boolean(step.real);

  let actionHTML;
  if (readOnly) {
    actionHTML = hasReal
      ? `<div class="step-recorded ${statusToneClass(delay.tone)}">
           <span class="step-real-time">${formatHHMM(delay.realDate)}</span>
           <span class="step-delay-badge">${formatDelayLabel(delay.diffMin, DELAY_THRESHOLDS)}</span>
         </div>`
      : `<span class="step-empty">Non enregistré</span>`;
  } else if (hasReal) {
    actionHTML = `
      <div class="step-recorded ${statusToneClass(delay.tone)}">
        <span class="step-real-time">${formatHHMM(delay.realDate)}</span>
        <span class="step-delay-badge">${formatDelayLabel(delay.diffMin, DELAY_THRESHOLDS)}</span>
        <div class="step-tools">
          <button type="button" class="icon-btn" data-action="edit-step-time" aria-label="Corriger l'heure">✎</button>
          <button type="button" class="icon-btn" data-action="reset-step-time" aria-label="Réinitialiser l'heure">↺</button>
        </div>
      </div>`;
  } else {
    actionHTML = `<button type="button" class="step-record-btn" data-action="record-step">Enregistrer l'heure</button>`;
  }

  return `
    <li class="step-row" data-step-index="${index}">
      <div class="step-info">
        <span class="step-num">${index + 1}</span>
        <span class="step-label">${escapeHtml(step.label)}</span>
        <span class="step-theoretical">${step.theoretical || '--:--'}</span>
      </div>
      <div class="step-action">${actionHTML}</div>
    </li>`;
}

function summaryRowHTML(train) {
  const delays = computeAllStepDelays(train);
  const lastIndex = train.steps.length - 1;
  const arrival = train.steps[lastIndex];
  const arrivalDelay = delays[lastIndex];
  const theo = arrival.theoretical || '--:--';
  const real = arrivalDelay.status === 'recorded' ? formatHHMM(arrivalDelay.realDate) : '—';
  const ecart = arrivalDelay.status === 'recorded' ? formatDelayLabel(arrivalDelay.diffMin, DELAY_THRESHOLDS) : '—';
  const tone = arrivalDelay.status === 'recorded' ? arrivalDelay.tone : 'neutral';
  return `
    <div class="summary-row">
      <div class="summary-cell"><span class="summary-label">Théorique</span><span class="summary-value">${theo}</span></div>
      <div class="summary-cell"><span class="summary-label">Réel</span><span class="summary-value">${real}</span></div>
      <div class="summary-cell"><span class="summary-label">Écart</span><span class="summary-value ${statusToneClass(tone)}">${ecart}</span></div>
    </div>`;
}

export function trainCardTemplate(train, { readOnly = false } = {}) {
  const status = computeTrainStatus(train);
  const stepsHTML = train.steps.map((_, i) => stepRowHTML(train, i, readOnly)).join('');

  return `
    <article class="train-card" data-train-id="${train.id}" data-readonly="${readOnly}">
      <header class="card-header">
        ${readOnly ? '' : '<button type="button" class="card-handle" draggable="true" data-action="drag-handle" aria-label="Glisser pour réorganiser">⠿</button>'}
        <h3 class="card-title">TRAIN <span data-role="train-number">${escapeHtml(train.number)}</span></h3>
        <span class="source-badge" data-role="source-badge" title="Synchronisé depuis Google Sheets" ${train.source === 'sheet' ? '' : 'hidden'}>⇄ Sheet</span>
        <span class="status-pill ${statusToneClass(status.tone)}" data-role="status">${status.label}</span>
      </header>

      ${readOnly ? '' : `
        <div class="sillon-lookup">
          <label class="sillon-lookup-label" for="sillon-${train.id}">Heure du sillon (départ pour la ligne + 15 min)</label>
          <div class="sillon-lookup-row">
            <input type="time" id="sillon-${train.id}" class="sillon-lookup-input" data-role="sillon-time" value="${train.sillonTime || ''}">
            <button type="button" class="btn btn-outline btn-sm" data-action="apply-sillon">⚡ Remplir les 7 heures</button>
          </div>
          <p class="sillon-lookup-status" data-role="sillon-status"></p>
        </div>`}

      <div class="cause-panel">
        <div class="cause-panel-title">Cause principale</div>
        <div class="flap-board">
          <div class="flap-row-wrap" data-role="flap-cause"></div>
          <div class="flap-row-wrap flap-row-amount" data-role="flap-amount"></div>
        </div>
      </div>

      <ul class="steps-list" data-role="steps-list">${stepsHTML}</ul>

      <div data-role="summary">${summaryRowHTML(train)}</div>

      <div class="chart-wrap">
        <div class="chart-title">Théorique / Réel</div>
        <div class="chart-canvas-holder"><canvas data-role="chart"></canvas></div>
      </div>

      <footer class="card-actions">
        ${readOnly ? '' : `
          <button type="button" class="btn btn-ghost btn-move" data-action="move-left" aria-label="Déplacer avant">◀</button>
          <button type="button" class="btn btn-ghost btn-move" data-action="move-right" aria-label="Déplacer après">▶</button>
        `}
        <button type="button" class="btn" data-action="copy-train">Copier</button>
        <button type="button" class="btn" data-action="email-train">Email</button>
        ${readOnly ? '' : `
          <button type="button" class="btn btn-outline" data-action="reset-all-steps">↺ Réinitialiser les heures</button>
          <button type="button" class="btn btn-outline" data-action="edit-train">Modifier</button>
          <button type="button" class="btn btn-danger" data-action="delete-train" aria-label="Supprimer">✕</button>
        `}
      </footer>
    </article>`;
}

export function updateCardDynamicParts(cardEl, train) {
  const numberEl = cardEl.querySelector('[data-role="train-number"]');
  if (numberEl) numberEl.textContent = train.number;

  const badgeEl = cardEl.querySelector('[data-role="source-badge"]');
  if (badgeEl) badgeEl.hidden = train.source !== 'sheet';

  const status = computeTrainStatus(train);
  const statusEl = cardEl.querySelector('[data-role="status"]');
  if (statusEl) {
    statusEl.textContent = status.label;
    statusEl.className = `status-pill ${statusToneClass(status.tone)}`;
  }

  const stepsList = cardEl.querySelector('[data-role="steps-list"]');
  if (stepsList) {
    const readOnly = cardEl.dataset.readonly === 'true';
    stepsList.innerHTML = train.steps.map((_, i) => stepRowHTML(train, i, readOnly)).join('');
  }

  const summary = cardEl.querySelector('[data-role="summary"]');
  if (summary) summary.innerHTML = summaryRowHTML(train);

  return computeMainCause(train);
}

export function nowStampLabel() {
  return formatHHMMSS(new Date());
}
