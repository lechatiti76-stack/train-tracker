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

// Libellé de l'écart affiché : distingue les cas où le calcul est
// impossible (voir computeStepDelay dans delay-calc.js), pour ne jamais
// laisser un « — » ambigu sans explication — notamment 'badTheoretical'
// (heure théorique renseignée mais dans un format non reconnu), qui sinon
// se traduit par un écart silencieusement vide en permanence.
function ecartLabel(delay) {
  if (delay.status === 'recorded') return formatDelayLabel(delay.diffMin, DELAY_THRESHOLDS);
  if (delay.status === 'badTheoretical') return 'Théo. illisible';
  if (delay.status === 'noTheoretical') return 'Théo. manquante';
  return '—';
}

// Résumé affiché à côté du bouton "Composition" une fois les champs
// renseignés (wagons / poids en tonnes / longueur en mètres / traction).
// Chaque champ est optionnel : seuls ceux renseignés apparaissent, séparés
// par " · ". Vide (chaîne vide) tant que rien n'a été saisi.
export function formatCompositionSummary(composition) {
  if (!composition) return '';
  const parts = [];
  if (composition.wagons) parts.push(`${composition.wagons} wagons`);
  if (composition.weightTons) parts.push(`${composition.weightTons} t`);
  if (composition.lengthM) parts.push(`${composition.lengthM} m`);
  if (composition.traction) parts.push(composition.traction === 'electrique' ? 'Électrique' : composition.traction === 'thermique' ? 'Thermique' : '');
  return parts.filter(Boolean).join(' · ');
}

// Résumé affiché à côté du bouton "Infos SLOT" une fois la fenêtre
// renseignée (type SLOT / wagons / heure d'arrivée / heure de
// recomposition / départ FA ou LHTE) — voir openSlotModal dans app.js.
// Vide tant que rien n'a été saisi (train.slot === null).
export function formatSlotSummary(slot) {
  if (!slot) return '';
  const parts = [];
  if (slot.type) parts.push(`SLOT ${slot.type}`);
  if (slot.wagons) parts.push(`${slot.wagons} wagons`);
  if (slot.arrivalTime) parts.push(`Arr. ${slot.arrivalTime}`);
  if (slot.recompositionTime) parts.push(`Recomp. ${slot.recompositionTime}`);
  if (slot.departure) parts.push(slot.departure);
  return parts.filter(Boolean).join(' · ');
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
           <span class="step-delay-badge">${ecartLabel(delay)}</span>
         </div>`
      : `<span class="step-empty">Non enregistré</span>`;
  } else if (hasReal) {
    actionHTML = `
      <div class="step-recorded ${statusToneClass(delay.tone)}">
        <span class="step-real-time">${formatHHMM(delay.realDate)}</span>
        <span class="step-delay-badge">${ecartLabel(delay)}</span>
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

function midRowHTML(train) {
  return `
    <div class="card-mid-row">
      <div class="cause-panel">
        <div class="cause-panel-title">Cause principale</div>
        <div class="flap-board">
          <div class="flap-row-wrap" data-role="flap-cause"></div>
          <div class="flap-row-wrap flap-row-amount" data-role="flap-amount"></div>
        </div>
      </div>
      <div data-role="summary">${summaryRowHTML(train)}</div>
    </div>`;
}

function summaryRowHTML(train) {
  const delays = computeAllStepDelays(train);
  const lastIndex = train.steps.length - 1;
  const arrival = train.steps[lastIndex];
  const arrivalDelay = delays[lastIndex];
  const theo = arrival.theoretical || '--:--';
  const real = arrivalDelay.status === 'recorded' ? formatHHMM(arrivalDelay.realDate) : '—';
  const ecart = ecartLabel(arrivalDelay);
  const tone = arrivalDelay.status === 'recorded' ? arrivalDelay.tone : 'neutral';
  return `
    <div class="summary-row">
      <div class="summary-cell"><span class="summary-label">Théorique</span><span class="summary-value">${theo}</span></div>
      <div class="summary-cell"><span class="summary-label">Réel</span><span class="summary-value">${real}</span></div>
      <div class="summary-cell"><span class="summary-label">Écart</span><span class="summary-value ${statusToneClass(tone)}">${ecart}</span></div>
    </div>`;
}

// Libellé affiché sur la vignette réduite : "{numéro} départ à {HH:MM}"
// (heure réelle de la dernière étape, "Départ pour la ligne" par défaut) —
// ou, pour un train SLOT parti en FA sans aucune étape encore enregistrée,
// un libellé dédié expliquant pourquoi la vignette est réduite.
function collapsedStripLabel(train) {
  const lastStep = train.steps[train.steps.length - 1];
  if (lastStep?.real) return `départ à ${formatHHMM(new Date(lastStep.real))}`;
  if (train.trainType === 'slots' && train.slot?.departure === 'FA') return 'SLOT FA — repart de chez eux, plus suivi ici';
  return 'départ à --:--';
}

export function trainCardTemplate(train, { readOnly = false, destination = null } = {}) {
  const status = computeTrainStatus(train);
  const stepsHTML = train.steps.map((_, i) => stepRowHTML(train, i, readOnly)).join('');
  const lastStep = train.steps[train.steps.length - 1];
  // Réduction possible une fois la dernière étape ("Départ pour la ligne",
  // par défaut) enregistrée — voir maybeCollapseAfterLastStep dans app.js,
  // qui bascule train.collapsed automatiquement à ce moment — OU dès qu'un
  // train SLOT est renseigné avec un départ "FA" (voir openSlotModal dans
  // app.js) : le train repart alors de l'autre site et n'est plus suivi ici,
  // donc la vignette se réduit immédiatement, même sans aucune étape
  // enregistrée.
  const isSlotFA = train.trainType === 'slots' && train.slot?.departure === 'FA';
  const isCollapsible = !readOnly && (Boolean(lastStep?.real) || isSlotFA);
  const isCollapsed = isCollapsible && Boolean(train.collapsed);

  return `
    <article class="train-card${isCollapsed ? ' is-collapsed' : ''}" data-train-id="${train.id}" data-readonly="${readOnly}">
      ${readOnly ? '' : `
      <button type="button" class="train-card-collapsed-strip" data-role="collapsed-strip" data-action="expand-card" ${isCollapsed ? '' : 'hidden'}>
        <span class="train-card-collapsed-number">TRAIN <span data-role="collapsed-number">${escapeHtml(train.number)}</span></span>
        <span class="train-card-collapsed-text" data-role="collapsed-text">${escapeHtml(collapsedStripLabel(train))}</span>
        <span class="train-card-collapsed-hint" aria-hidden="true">▸ tout afficher</span>
      </button>`}
      <div class="train-card-body" data-role="card-body" ${isCollapsed ? 'hidden' : ''}>
        <header class="card-header">
          ${readOnly ? '' : '<button type="button" class="card-handle" draggable="true" data-action="drag-handle" aria-label="Glisser pour réorganiser">⠿</button>'}
          <h3 class="card-title">TRAIN <span data-role="train-number">${escapeHtml(train.number)}</span>${destination ? `<span class="card-destination" data-role="train-destination"> — à destination de ${escapeHtml(destination)}</span>` : ''}</h3>
          <span class="source-badge" data-role="source-badge" title="Synchronisé depuis Google Sheets" ${train.source === 'sheet' ? '' : 'hidden'}>⇄ Sheet</span>
          <span class="status-pill ${statusToneClass(status.tone)}" data-role="status">${status.label}</span>
          ${readOnly ? '' : `<button type="button" class="card-collapse-btn" data-action="collapse-card" data-role="collapse-btn" title="Réduire cette vignette" aria-label="Réduire cette vignette" ${isCollapsible ? '' : 'hidden'}>▾</button>`}
        </header>

        ${readOnly ? '' : `
          <div class="sillon-lookup">
            <label class="sillon-lookup-label" for="sillon-${train.id}">Heure du sillon (départ pour la ligne + 15 min)</label>
            <div class="sillon-lookup-row">
              <input type="time" id="sillon-${train.id}" class="sillon-lookup-input" data-role="sillon-time" value="${train.sillonTime || ''}">
              <button type="button" class="btn btn-outline btn-sm" data-action="apply-sillon">⚡ Remplir les 7 heures</button>
            </div>
            <p class="sillon-lookup-status" data-role="sillon-status"></p>
                  </div>
          <div class="composition-row">
            <button type="button" class="btn btn-outline btn-sm" data-action="open-composition">🚃 Composition</button>
            <span class="composition-summary" data-role="composition-summary">${escapeHtml(formatCompositionSummary(train.composition))}</span>
          </div>
          <div class="train-type-row" data-role="train-type-row">
            <div class="train-type-toggle" role="group" aria-label="Type de train" data-role="train-type-toggle">
              <button type="button" class="train-type-btn${train.trainType === 'slots' ? '' : ' is-active'}" data-action="set-train-type" data-type="complet">Train complet</button>
              <button type="button" class="train-type-btn${train.trainType === 'slots' ? ' is-active' : ''}" data-action="set-train-type" data-type="slots">Train avec slots</button>
            </div>
            <span data-role="slot-tools" ${train.trainType === 'slots' ? '' : 'hidden'}>
              <button type="button" class="btn btn-outline btn-sm" data-action="open-slot">🎰 Infos SLOT</button>
              <span class="slot-summary" data-role="slot-summary">${escapeHtml(formatSlotSummary(train.slot))}</span>
            </span>
          </div>`}

        <ul class="steps-list" data-role="steps-list">${stepsHTML}</ul>

        ${midRowHTML(train)}

        <div class="chart-wrap">
          <div class="chart-title">Théorique / Réel — au fil des étapes</div>
          <div class="chart-canvas-holder"><canvas data-role="chart"></canvas></div>
        </div>

        <footer class="card-actions">
          ${readOnly ? '' : `
            <button type="button" class="btn btn-ghost btn-move" data-action="move-left" aria-label="Déplacer avant">◀</button>
            <button type="button" class="btn btn-ghost btn-move" data-action="move-right" aria-label="Déplacer après">▶</button>
          `}
          <button type="button" class="btn" data-action="copy-train">Copier</button>
          <button type="button" class="btn btn-outline" data-action="copy-html-train" title="Copier une version stylée avec couleurs, à coller dans un email">🎨 Copier stylé</button>
          <button type="button" class="btn" data-action="email-train">Email</button>
          ${readOnly ? '' : `
            <button type="button" class="btn btn-outline" data-action="reset-all-steps">↺ Réinitialiser les heures</button>
            <button type="button" class="btn btn-outline" data-action="edit-train">Modifier</button>
            <button type="button" class="btn btn-danger" data-action="delete-train" aria-label="Supprimer">✕</button>
          `}
        </footer>
      </div>
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

  const compositionSummaryEl = cardEl.querySelector('[data-role="composition-summary"]');
  if (compositionSummaryEl) compositionSummaryEl.textContent = formatCompositionSummary(train.composition);

  const typeToggleEl = cardEl.querySelector('[data-role="train-type-toggle"]');
  if (typeToggleEl) {
    typeToggleEl.querySelectorAll('.train-type-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.type === (train.trainType === 'slots' ? 'slots' : 'complet'));
    });
  }
  const slotToolsEl = cardEl.querySelector('[data-role="slot-tools"]');
  if (slotToolsEl) slotToolsEl.hidden = train.trainType !== 'slots';
  const slotSummaryEl = cardEl.querySelector('[data-role="slot-summary"]');
  if (slotSummaryEl) slotSummaryEl.textContent = formatSlotSummary(train.slot);

  const stepsList = cardEl.querySelector('[data-role="steps-list"]');
  if (stepsList) {
    const readOnly = cardEl.dataset.readonly === 'true';
    stepsList.innerHTML = train.steps.map((_, i) => stepRowHTML(train, i, readOnly)).join('');
  }

  const summary = cardEl.querySelector('[data-role="summary"]');
  if (summary) summary.innerHTML = summaryRowHTML(train);

  const lastStep = train.steps[train.steps.length - 1];
  const isSlotFA = train.trainType === 'slots' && train.slot?.departure === 'FA';
  const isCollapsible = cardEl.dataset.readonly !== 'true' && (Boolean(lastStep?.real) || isSlotFA);
  const isCollapsed = isCollapsible && Boolean(train.collapsed);
  cardEl.classList.toggle('is-collapsed', isCollapsed);

  const stripEl = cardEl.querySelector('[data-role="collapsed-strip"]');
  if (stripEl) {
    stripEl.hidden = !isCollapsed;
    const numberEl = stripEl.querySelector('[data-role="collapsed-number"]');
    if (numberEl) numberEl.textContent = train.number;
    const textEl = stripEl.querySelector('[data-role="collapsed-text"]');
    if (textEl) textEl.textContent = collapsedStripLabel(train);
  }
  const bodyEl = cardEl.querySelector('[data-role="card-body"]');
  if (bodyEl) bodyEl.hidden = isCollapsed;
  const collapseBtn = cardEl.querySelector('[data-role="collapse-btn"]');
  if (collapseBtn) collapseBtn.hidden = !isCollapsible;

  return computeMainCause(train);
}

export function nowStampLabel() {
  return formatHHMMSS(new Date());
}
