// Logique métier : calcul des écarts, du statut global et de la cause
// principale de retard. Fonctions pures (aucun accès au DOM ni au stockage)
// pour rester faciles à faire évoluer.
import { combineDateAndTime, diffMinutes, formatDelayLabel, delayTone, formatHHMM } from './time-utils.js';
import { DELAY_THRESHOLDS, SILLON_STEP_OFFSETS } from './config.js';

// Remplit automatiquement l'heure théorique des 7 étapes à partir d'une
// seule heure de référence : "l'heure du sillon" (départ pour la ligne +
// 15 min). Les décalages sont fixes (SILLON_STEP_OFFSETS, alignés par
// position) et reflètent l'enchaînement réel de la préparation. Ne touche
// jamais aux heures réelles ; chaque étape reste modifiable au cas par cas
// ensuite via "Modifier".
export function applySillonSequence(train, sillonHHMM, offsets = SILLON_STEP_OFFSETS) {
  const sillonDate = combineDateAndTime(train.date, sillonHHMM);
  if (!sillonDate) return;
  train.steps.forEach((step, i) => {
    const offset = offsets[i];
    if (offset === undefined) return;
    const computed = new Date(sillonDate.getTime() + offset * 60000);
    step.theoretical = formatHHMM(computed);
  });
}

// Calcule automatiquement l'heure théorique des étapes qui ont un décalage
// (en minutes, positif ou négatif) défini par rapport à l'étape de référence
// (la première, "Départ" par convention). Utile pour les étapes de
// préparation avant le départ commercial (décalage négatif) : leur horaire
// théorique se déduit de celui du Départ plutôt que d'être ressaisi à la
// main à chaque fois. N'a aucun effet sur une étape sans décalage défini.
export function applyOffsetSteps(train) {
  const anchor = train.steps[0];
  if (!anchor || !anchor.theoretical) return;
  const anchorDate = combineDateAndTime(train.date, anchor.theoretical);
  if (!anchorDate) return;

  train.steps.forEach((step, i) => {
    if (i === 0) return;
    if (step.offsetMinutes === null || step.offsetMinutes === undefined || step.offsetMinutes === '') return;
    const offset = Number(step.offsetMinutes);
    if (!Number.isFinite(offset)) return;
    const computed = new Date(anchorDate.getTime() + offset * 60000);
    step.theoretical = formatHHMM(computed);
  });
}

export function computeStepDelay(train, stepIndex) {
  const step = train.steps[stepIndex];
  if (!step) return { status: 'missing', diffMin: null, realDate: null, tone: 'neutral' };

  const realDate = step.real ? new Date(step.real) : null;

  if (!step.theoretical) {
    // Heure réelle éventuellement connue, mais rien à comparer : on l'affiche
    // quand même (via realDate) sans pouvoir calculer d'écart.
    return { status: realDate ? 'noTheoretical' : 'pending', diffMin: null, realDate, tone: 'neutral' };
  }
  if (!realDate) return { status: 'pending', diffMin: null, realDate: null, tone: 'neutral' };

  const theoreticalDate = combineDateAndTime(train.date, step.theoretical);
  const diffMin = diffMinutes(theoreticalDate, realDate);
  const tone = delayTone(diffMin, DELAY_THRESHOLDS);
  return { status: 'recorded', diffMin, tone, theoreticalDate, realDate };
}

export function computeAllStepDelays(train) {
  return train.steps.map((_, i) => computeStepDelay(train, i));
}

// Statut global affiché sur l'en-tête de la vignette, sans avoir à l'ouvrir.
export function computeTrainStatus(train) {
  const delays = computeAllStepDelays(train);
  let lastRecordedIndex = -1;
  for (let i = delays.length - 1; i >= 0; i--) {
    if (delays[i].status === 'recorded') {
      lastRecordedIndex = i;
      break;
    }
  }
  if (lastRecordedIndex === -1) {
    return { label: 'EN ATTENTE', tone: 'neutral' };
  }
  const d = delays[lastRecordedIndex];
  const label = formatDelayLabel(d.diffMin, { onTimeThreshold: DELAY_THRESHOLDS.onTime });
  const isLastStep = lastRecordedIndex === train.steps.length - 1;
  if (isLastStep) {
    // Le préfixe reprend le libellé réel de la dernière étape (ex : "Arrivée"
    // ou "Départ pour la ligne") plutôt qu'un mot figé : ce n'est pas
    // toujours une arrivée (checklist de préparation avant départ, etc.).
    const prefix = normalize(train.steps[lastRecordedIndex].label).toUpperCase();
    return { label: label === "À L'HEURE" ? `${prefix} À L'HEURE` : `${prefix} ${label}`, tone: d.tone };
  }
  if (d.tone === 'early') return { label: `EN AVANCE ${label}`, tone: d.tone };
  return { label, tone: d.tone };
}

function normalize(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// Cause principale = la cause associée à l'étape présentant le plus gros
// écart positif (le plus gros retard constaté).
export function computeMainCause(train) {
  const delays = computeAllStepDelays(train);
  const recorded = delays
    .map((d, i) => ({ ...d, index: i, step: train.steps[i] }))
    .filter((d) => d.status === 'recorded');

  if (recorded.length === 0) {
    return { cause: 'EN ATTENTE DE DONNÉES', amountLabel: '--', stepLabel: null, tone: 'neutral' };
  }

  const worst = recorded.reduce((acc, cur) => (cur.diffMin > acc.diffMin ? cur : acc), recorded[0]);

  if (worst.diffMin <= 0) {
    return { cause: 'AUCUN RETARD SIGNIFICATIF', amountLabel: formatDelayLabel(worst.diffMin, DELAY_THRESHOLDS), stepLabel: normalize(worst.step.label).toUpperCase(), tone: 'onTime' };
  }

  const causeText = worst.step.cause && worst.step.cause.trim() ? worst.step.cause.trim() : 'CAUSE NON RENSEIGNÉE';
  return {
    cause: normalize(causeText).toUpperCase(),
    amountLabel: formatDelayLabel(worst.diffMin, DELAY_THRESHOLDS),
    stepLabel: normalize(worst.step.label).toUpperCase(),
    tone: worst.tone,
  };
}
