// Utilitaires de date/heure. Toute la logique de franchissement de minuit
// et de comparaison théorique/réel est centralisée ici pour rester testable.

export function pad2(n) {
  return String(Math.abs(n)).padStart(2, '0');
}

export function parseHHMM(hhmm) {
  if (!hhmm || typeof hhmm !== 'string' || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

// Construit un Date local à partir d'une date 'YYYY-MM-DD' et d'une heure 'HH:MM'.
export function combineDateAndTime(dateISO, hhmm) {
  const parsed = parseHHMM(hhmm);
  if (!parsed || !dateISO) return null;
  const [y, mo, d] = dateISO.split('-').map(Number);
  return new Date(y, mo - 1, d, parsed.h, parsed.m, 0, 0);
}

export function formatHHMM(date) {
  if (!date) return '—';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatHHMMSS(date) {
  if (!date) return '—';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// Écart en minutes (réel - théorique), avec correction du passage à minuit :
// si l'écart brut dépasse 12h dans un sens, on suppose un changement de jour
// et on réaligne de 24h (utile pour un train dont le départ est à 23h50 et
// le passage suivant enregistré à 00h05).
export function diffMinutes(theoreticalDate, realDate) {
  if (!theoreticalDate || !realDate) return null;
  let diffMs = realDate.getTime() - theoreticalDate.getTime();
  const twelveHoursMs = 12 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  if (diffMs > twelveHoursMs) diffMs -= dayMs;
  else if (diffMs < -twelveHoursMs) diffMs += dayMs;
  return Math.round(diffMs / 60000);
}

export function formatDelayLabel(diffMin, { onTimeThreshold = 1 } = {}) {
  if (diffMin === null || diffMin === undefined) return '—';
  if (Math.abs(diffMin) < onTimeThreshold) return "À L'HEURE";
  if (diffMin > 0) return `+${pad2(diffMin)} MIN`;
  return `-${pad2(diffMin)} MIN`;
}

export function delayTone(diffMin, thresholds) {
  if (diffMin === null || diffMin === undefined) return 'neutral';
  if (Math.abs(diffMin) < thresholds.onTime) return 'onTime';
  if (diffMin < 0) return 'early';
  if (diffMin >= thresholds.severe) return 'severe';
  if (diffMin >= thresholds.moderate) return 'moderate';
  return 'late';
}

export function nowLocalISOWithSeconds() {
  return new Date().toISOString();
}
