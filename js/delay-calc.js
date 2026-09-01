// Logique métier : calcul des écarts, du statut global et de la cause
// principale de retard. Fonctions pures (aucun accès au DOM ni au stockage)
// pour rester faciles à faire évoluer.
import { combineDateAndTime, diffMinutes, formatDelayLabel, delayTone } from './time-utils.js';
import { DELAY_THRESHOLDS } from './config.js';

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
  const isArrival = lastRecordedIndex === train.steps.length - 1;
  if (isArrival) {
    return { label: label === "À L'HEURE" ? 'ARRIVÉ À L\'HEURE' : `ARRIVÉ ${label}`, tone: d.tone };
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
