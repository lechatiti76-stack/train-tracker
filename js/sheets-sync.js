// Récupération des horaires théoriques depuis Google Sheets, via un Web App
// Google Apps Script en lecture seule (voir /apps-script/Code.gs).
// Aucune clé API n'est manipulée côté client : l'autorisation est gérée par
// Apps Script sous le compte du propriétaire de la feuille.
//
// Cette fonction est la SEULE porte d'entrée des données théoriques.
// Pour brancher une autre source plus tard (API REST, base de données...),
// il suffit de réécrire `fetchTheoreticalFromSheet` en gardant la même
// forme de retour : { ok: true, rows: [...] } ou { ok: false, reason }.
import { createEmptyTrain } from './storage.js';
import { applyOffsetSteps } from './delay-calc.js';
import { weekdayOf } from './time-utils.js';

const WEEKDAY_PREFIXES = [
  { prefix: 'dim', day: 0 },
  { prefix: 'lun', day: 1 },
  { prefix: 'mar', day: 2 },
  { prefix: 'mer', day: 3 },
  { prefix: 'jeu', day: 4 },
  { prefix: 'ven', day: 5 },
  { prefix: 'sam', day: 6 },
];

function stripAccentsLower(str) {
  return (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Convertit la colonne "Jours de circulation" (ex : "Mardi,Jeudi", "Lun Mer
// Ven", "Tous les jours") en une liste de jours (0 = dimanche ... 6 =
// samedi, comme Date.getDay()). Insensible à la casse, aux accents et aux
// abréviations (3 lettres suffisent : "mar", "jeu"...).
export function parseJoursDeCirculation(value) {
  const norm = stripAccentsLower(value);
  if (!norm) return [];
  if (/tous|tlj|quotidien/.test(norm)) return [0, 1, 2, 3, 4, 5, 6];
  const tokens = norm.split(/[,;/\s]+/).filter(Boolean);
  const days = new Set();
  for (const token of tokens) {
    const match = WEEKDAY_PREFIXES.find((w) => token.startsWith(w.prefix));
    if (match) days.add(match.day);
  }
  return [...days].sort();
}

export async function fetchTheoreticalFromSheet(webAppUrl, dateISO, { timeoutMs = 8000 } = {}) {
  if (!webAppUrl) return { ok: false, reason: 'not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${webAppUrl}${webAppUrl.includes('?') ? '&' : '?'}date=${encodeURIComponent(dateISO)}`;
    const res = await fetch(url, { signal: controller.signal, method: 'GET' });
    if (!res.ok) return { ok: false, reason: 'http_error', status: res.status };
    const data = await res.json();
    if (!Array.isArray(data)) return { ok: false, reason: 'bad_format' };
    return { ok: true, rows: data };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLabel(str) {
  return (str || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

// Applique un jeu de lignes Sheet (un seul sillon) sur les 7 étapes d'un
// train, en faisant correspondre chaque ligne à une étape par libellé
// (insensible à la casse/aux accents). Ne touche jamais aux heures réelles.
export function applySillonRowsToTrain(train, rows) {
  for (const row of rows) {
    const etapeLabel = row.etape ?? row.Etape ?? row['Étape'] ?? '';
    const heureTheorique = row.heureTheorique ?? row['Heure théorique'] ?? row.heure ?? '';
    const cause = row.cause ?? row.Cause ?? '';
    const norm = normalizeLabel(etapeLabel);
    const step = train.steps.find((s) => normalizeLabel(s.label) === norm);
    if (step) {
      if (heureTheorique) step.theoretical = normalizeSheetTime(heureTheorique);
      if (cause && cause !== '-') step.cause = cause;
    }
  }
}

// Un sillon "circule" pour une date donnée si son jour de la semaine fait
// partie de sa colonne "Jours de circulation". Repli sur une correspondance
// de date exacte (ancien schéma, colonne "Date") si "Jours" est absente ;
// si aucune des deux n'est renseignée, on considère que le sillon circule
// tous les jours plutôt que de le faire disparaître silencieusement.
function rowRunsOn(row, dateISO) {
  const jours = row.jours ?? row.Jours ?? row['Jours de circulation'] ?? '';
  if (jours) return parseJoursDeCirculation(jours).includes(weekdayOf(dateISO));
  const dateValue = row.date ?? row.Date ?? '';
  if (dateValue) return normalizeSheetDate(dateValue) === dateISO;
  return true;
}

function groupRowsByTrainForDate(rows, dateISO) {
  const byTrainNumber = new Map();
  for (const row of rows) {
    if (!rowRunsOn(row, dateISO)) continue;
    const number = String(row.train ?? row.Train ?? '').trim();
    if (!number) continue;
    if (!byTrainNumber.has(number)) byTrainNumber.set(number, []);
    byTrainNumber.get(number).push(row);
  }
  return byTrainNumber;
}

// Fusionne les lignes issues du Sheet dans la liste de trains existante.
// - Ne touche JAMAIS aux heures réelles déjà enregistrées.
// - Met à jour l'heure théorique + la cause d'une étape existante.
// - Crée un nouveau train si son numéro n'existe pas encore pour cette date.
export function mergeSheetRowsIntoTrains(rows, trains, dateISO, defaultStepLabels) {
  const result = trains.map((t) => ({ ...t, steps: t.steps.map((s) => ({ ...s })) }));
  const touchedNumbers = new Set();
  const byTrainNumber = groupRowsByTrainForDate(rows, dateISO);
  let maxOrder = result.reduce((m, t) => Math.max(m, t.order || 0), -1);

  for (const [number, sheetRows] of byTrainNumber) {
    touchedNumbers.add(number);
    let train = result.find((t) => t.number === number && t.date === dateISO);
    if (!train) {
      train = createEmptyTrain({ number, date: dateISO, stepLabels: defaultStepLabels, order: ++maxOrder, source: 'sheet' });
      result.push(train);
    }
    applySillonRowsToTrain(train, sheetRows);
    applyOffsetSteps(train);
    train.updatedAt = new Date().toISOString();
  }

  return { trains: result, touchedNumbers };
}

function normalizeSheetDate(value) {
  if (!value) return '';
  const str = String(value).trim();
  // Format attendu dans le Sheet : JJ/MM/AAAA -> converti en AAAA-MM-JJ.
  const fr = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (fr) {
    const [, d, m, y] = fr;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  return str;
}

function normalizeSheetTime(value) {
  const str = String(value).trim();
  const m = str.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

// ---------- Écriture vers Google Sheets (journal des heures réelles) ----------
// Même Web App que la lecture (voir /apps-script/Code.gs), avec une action
// distincte ('logStep') qui écrit une ligne par étape enregistrée dans un
// onglet "Journal" séparé (créé automatiquement si absent) — l'onglet
// "Horaires" utilisé pour la lecture n'est jamais modifié. Utilise
// `Content-Type: text/plain` pour éviter un préflight CORS (Apps Script ne
// gère pas les requêtes OPTIONS).
async function postToSheet(webAppUrl, payload, { timeoutMs = 8000 } = {}) {
  if (!webAppUrl) return { ok: false, reason: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(webAppUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, reason: 'http_error', status: res.status };
    const data = await res.json().catch(() => ({}));
    if (data && data.error) return { ok: false, reason: 'server_error', detail: data.error };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

function stepLogPayload(train, stepIndex, delay) {
  const step = train.steps[stepIndex];
  return {
    action: 'logStep',
    date: train.date,
    train: train.number,
    etape: step.label,
    heureTheorique: step.theoretical || '',
    heureReelle: delay.realDate ? `${String(delay.realDate.getHours()).padStart(2, '0')}:${String(delay.realDate.getMinutes()).padStart(2, '0')}:${String(delay.realDate.getSeconds()).padStart(2, '0')}` : '',
    ecartMin: delay.status === 'recorded' ? delay.diffMin : '',
    cause: step.cause || '',
    misAJour: new Date().toISOString(),
  };
}

export async function pushStepToSheet(webAppUrl, train, stepIndex, computeAllStepDelaysFn) {
  const delays = computeAllStepDelaysFn(train);
  return postToSheet(webAppUrl, stepLogPayload(train, stepIndex, delays[stepIndex]));
}

export async function pushAllStepsToSheet(webAppUrl, train, computeAllStepDelaysFn) {
  const delays = computeAllStepDelaysFn(train);
  const results = [];
  for (let i = 0; i < train.steps.length; i++) {
    if (!train.steps[i].real) continue;
    // Envoyées séquentiellement (plutôt qu'en parallèle) pour rester
    // compatible avec LockService côté Apps Script et éviter de saturer les
    // quotas d'exécution simultanée.
    results.push(await postToSheet(webAppUrl, stepLogPayload(train, i, delays[i])));
  }
  return results;
}
