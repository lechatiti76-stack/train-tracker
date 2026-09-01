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

// Fusionne les lignes issues du Sheet dans la liste de trains existante.
// - Ne touche JAMAIS aux heures réelles déjà enregistrées.
// - Met à jour l'heure théorique + la cause d'une étape existante.
// - Crée un nouveau train si son numéro n'existe pas encore pour cette date.
export function mergeSheetRowsIntoTrains(rows, trains, dateISO, defaultStepLabels) {
  const result = trains.map((t) => ({ ...t, steps: t.steps.map((s) => ({ ...s })) }));
  const touchedNumbers = new Set();

  const byTrainNumber = new Map();
  for (const row of rows) {
    const dateStr = normalizeSheetDate(row.date || row.Date);
    if (dateStr !== dateISO) continue;
    const number = String(row.train ?? row.Train ?? '').trim();
    if (!number) continue;
    if (!byTrainNumber.has(number)) byTrainNumber.set(number, []);
    byTrainNumber.get(number).push(row);
  }

  let maxOrder = result.reduce((m, t) => Math.max(m, t.order || 0), -1);

  for (const [number, sheetRows] of byTrainNumber) {
    touchedNumbers.add(number);
    let train = result.find((t) => t.number === number && t.date === dateISO);
    if (!train) {
      train = createEmptyTrain({ number, date: dateISO, stepLabels: defaultStepLabels, order: ++maxOrder, source: 'sheet' });
      result.push(train);
    }
    for (const row of sheetRows) {
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
