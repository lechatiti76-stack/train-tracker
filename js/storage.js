// Couche de persistance. Aujourd'hui : localStorage.
// Demain : il suffit de remplacer le corps de ces fonctions par des appels
// réseau (fetch vers une API/BDD) sans toucher au reste de l'application,
// qui ne connaît que `loadTrains/saveTrains/loadSettings/saveSettings`.
import { STORAGE_KEYS, DEFAULT_SETTINGS, STEP_COUNT } from './config.js';

function safeParse(json, fallback) {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch (err) {
    console.warn('Données locales corrompues, réinitialisation.', err);
    return fallback;
  }
}

export function loadTrains() {
  const raw = safeParse(localStorage.getItem(STORAGE_KEYS.trains), []);
  return Array.isArray(raw) ? raw : [];
}

export function saveTrains(trains) {
  try {
    localStorage.setItem(STORAGE_KEYS.trains, JSON.stringify(trains));
    return true;
  } catch (err) {
    console.error('Impossible d\'enregistrer les trains (quota ?).', err);
    return false;
  }
}

// Anciens décalages de sillon (calculés à partir d'une mauvaise lecture de
// la séquence réelle) — remplacés par des valeurs vérifiées, voir
// DEFAULT_SETTINGS.sillonStepOffsets. Les navigateurs ayant déjà ces
// valeurs exactes enregistrées (donc jamais personnalisées à la main) sont
// migrés automatiquement ci-dessous, pour ne pas dépendre d'une action
// manuelle dans Réglages.
const LEGACY_SILLON_OFFSETS = [-240, -161, -97, -38, -19, -17, -15];

// Ancien format des trains à accès rapide : un simple tableau de numéros
// (`quickTrainNumbers`), sans opérateur ni destination. Remplacé par
// `quickTrains` (tableau d'objets { number, operator, destination }) —
// migré automatiquement ci-dessous en enrichissant chaque numéro connu avec
// son opérateur/destination par défaut (voir DEFAULT_SETTINGS.quickTrains),
// et en ajoutant les nouveaux trains par défaut (50276, 50274) qui
// n'existaient pas dans l'ancien format. Idempotent et protégé par un
// indicateur one-shot pour ne jamais réajouter un train que l'utilisateur a
// sciemment retiré ensuite.
export function loadSettings() {
  const stored = safeParse(localStorage.getItem(STORAGE_KEYS.settings), {});
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  const isLegacy = Array.isArray(stored.sillonStepOffsets)
    && stored.sillonStepOffsets.length === LEGACY_SILLON_OFFSETS.length
    && stored.sillonStepOffsets.every((v, i) => v === LEGACY_SILLON_OFFSETS[i]);
  if (isLegacy) {
    merged.sillonStepOffsets = DEFAULT_SETTINGS.sillonStepOffsets;
  }
  let needsSave = isLegacy;

  if (!Array.isArray(stored.quickTrains) && Array.isArray(stored.quickTrainNumbers)) {
    const defaultsByNumber = new Map(DEFAULT_SETTINGS.quickTrains.map((t) => [t.number, t]));
    merged.quickTrains = stored.quickTrainNumbers.map((number) => {
      const def = defaultsByNumber.get(number);
      return def ? { ...def } : { number, operator: '', destination: '' };
    });
    needsSave = true;
  }
  if (!merged.quickTrainsEnrichedV2) {
    const defaultsByNumber = new Map(DEFAULT_SETTINGS.quickTrains.map((t) => [t.number, t]));
    merged.quickTrains = (merged.quickTrains || []).map((t) => {
      if (t.operator || t.destination) return t;
      const def = defaultsByNumber.get(t.number);
      return def ? { ...def } : t;
    });
    const known = new Set(merged.quickTrains.map((t) => t.number));
    const missingDefaults = DEFAULT_SETTINGS.quickTrains.filter((t) => !known.has(t.number));
    merged.quickTrains = [...merged.quickTrains, ...missingDefaults];
    merged.quickTrainsEnrichedV2 = true;
    needsSave = true;
  }

  if (needsSave) saveSettings(merged);
  return merged;
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    return true;
  } catch (err) {
    console.error('Impossible d\'enregistrer les réglages.', err);
    return false;
  }
}

// Les navettes internes sont remises à zéro automatiquement chaque jour :
// le départ saisi hier n'a plus de sens aujourd'hui. On stocke donc la date
// à laquelle les données ont été enregistrées à côté des données elles-
// mêmes ({ date, data }) ; si la date lue ne correspond pas à aujourd'hui,
// on repart d'un objet vide plutôt que de réafficher des navettes de la
// veille. Ancien format (objet plat de navettes, sans date) : traité comme
// "d'aujourd'hui" une seule fois lors de la mise à jour de l'app, pour ne
// pas effacer des données en cours d'utilisation.
export function loadShuttles() {
  const raw = safeParse(localStorage.getItem(STORAGE_KEYS.shuttles), {});
  if (raw && typeof raw === 'object' && 'date' in raw && 'data' in raw) {
    if (raw.date !== todayISO()) return {};
    return raw.data && typeof raw.data === 'object' ? raw.data : {};
  }
  return raw && typeof raw === 'object' ? raw : {};
}

export function saveShuttles(shuttles) {
  try {
    localStorage.setItem(STORAGE_KEYS.shuttles, JSON.stringify({ date: todayISO(), data: shuttles }));
    recordDayPart(todayISO(), 'shuttles', shuttles);
    return true;
  } catch (err) {
    console.error('Impossible d\'enregistrer les navettes.', err);
    return false;
  }
}

// Arrivées (trains fret en provenance d'autres sites) : même remise à zéro
// quotidienne automatique que les navettes ci-dessus, et pour la même
// raison (un départ saisi hier n'a plus de sens aujourd'hui) — voir
// loadShuttles/saveShuttles.
export function loadArrivals() {
  const raw = safeParse(localStorage.getItem(STORAGE_KEYS.arrivals), {});
  if (raw && typeof raw === 'object' && 'date' in raw && 'data' in raw) {
    if (raw.date !== todayISO()) return {};
    return raw.data && typeof raw.data === 'object' ? raw.data : {};
  }
  return raw && typeof raw === 'object' ? raw : {};
}

export function saveArrivals(arrivals) {
  try {
    localStorage.setItem(STORAGE_KEYS.arrivals, JSON.stringify({ date: todayISO(), data: arrivals }));
    recordDayPart(todayISO(), 'arrivals', arrivals);
    return true;
  } catch (err) {
    console.error('Impossible d\'enregistrer les arrivées.', err);
    return false;
  }
}

// Tableau rapide des départs navettes (case "Réserve" par famille FL/NL/AL,
// à côté des vignettes navettes) : même remise à zéro quotidienne
// automatique que loadShuttles/saveShuttles ci-dessus, et pour la même
// raison. Forme des données : { FL: 'HH:MM'|null, NL: ..., AL: ... }.
export function loadShuttleReserves() {
  const raw = safeParse(localStorage.getItem(STORAGE_KEYS.shuttleReserves), {});
  if (raw && typeof raw === 'object' && 'date' in raw && 'data' in raw) {
    if (raw.date !== todayISO()) return {};
    return raw.data && typeof raw.data === 'object' ? raw.data : {};
  }
  return raw && typeof raw === 'object' ? raw : {};
}

export function saveShuttleReserves(shuttleReserves) {
  try {
    localStorage.setItem(STORAGE_KEYS.shuttleReserves, JSON.stringify({ date: todayISO(), data: shuttleReserves }));
    recordDayPart(todayISO(), 'reserves', shuttleReserves);
    return true;
  } catch (err) {
    console.error('Impossible d\'enregistrer les réserves navettes.', err);
    return false;
  }
}

// Mémoire du lien avec le suivi des circulations ({ clé: 'HH:MM' }), du jour
// seulement, comme les navettes.
export function loadCirculationsSeen() {
  const raw = safeParse(localStorage.getItem(STORAGE_KEYS.circulationsSeen), {});
  return raw && raw.date === todayISO() && raw.data && typeof raw.data === 'object' ? raw.data : {};
}

export function saveCirculationsSeen(seen) {
  try {
    localStorage.setItem(STORAGE_KEYS.circulationsSeen, JSON.stringify({ date: todayISO(), data: seen }));
  } catch (err) {
    console.error('Impossible d\'enregistrer le lien avec le suivi des circulations.', err);
  }
}

// Numéros des trains retirés à la main aujourd'hui (voir STORAGE_KEYS.removedTrains).
export function loadRemovedTrains() {
  const raw = safeParse(localStorage.getItem(STORAGE_KEYS.removedTrains), {});
  return raw && raw.date === todayISO() && Array.isArray(raw.numbers) ? raw.numbers : [];
}

export function saveRemovedTrains(numbers) {
  try {
    localStorage.setItem(STORAGE_KEYS.removedTrains, JSON.stringify({ date: todayISO(), numbers }));
  } catch (err) {
    console.error('Impossible d\'enregistrer les trains retirés.', err);
  }
}

function uuid() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function createEmptyTrain({ number, date, stepLabels, order = 0, source = 'manual' }) {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    number: String(number || '').trim(),
    date, // 'YYYY-MM-DD'
    order,
    source, // 'manual' | 'sheet'
    sillonTime: null, // 'HH:MM' — heure de référence pour le remplissage auto des 7 étapes
    // Composition du train (wagons / poids / longueur / traction), saisie via
    // le bouton "Composition" sur la vignette — voir openCompositionModal
    // dans app.js. null tant que rien n'a été renseigné.
    composition: null, // { wagons: number, weightTons: number, lengthM: number, traction: 'electrique'|'thermique' } | null
    // Vignette réduite à une ligne ("{numéro} départ à HH:MM") une fois la
    // dernière étape validée — voir setCardCollapsed/maybeCollapseAfterLastStep
    // dans app.js, et .train-card.is-collapsed dans style.css. Sans effet
    // tant que la dernière étape n'a pas d'heure réelle enregistrée (sauf
    // train SLOT en départ FA, voir `slot` ci-dessous, qui force aussi la
    // réduction).
    collapsed: false,
    // "Train complet" (suivi classique des 7 étapes, défaut) ou "Train avec
    // slots" (en plus de la composition) — bascule à côté du bouton
    // Composition, voir openSlotModal dans app.js.
    trainType: 'complet', // 'complet' | 'slots'
    // Renseigné uniquement si trainType === 'slots' (fenêtre "Infos SLOT") :
    // { type: 'TDF'|'TN'|'ATL', wagons: number|null, arrivalTime: 'HH:MM'|null,
    //   recompositionTime: 'HH:MM'|null, departure: 'FA'|'LHTE'|null }.
    // `departure` distingue QUI gère le train à partir de là : 'FA' = le
    // train complet repart de l'autre site ("chez eux") — ce n'est plus la
    // responsabilité de l'utilisateur, donc la vignette se réduit
    // automatiquement (comme après la case 7). 'LHTE' = départ depuis le
    // site de l'utilisateur ("chez moi") — le suivi complet (7 étapes +
    // graphique) reste nécessaire, et ces infos SLOT s'affichent en plus, à
    // côté de Composition. null tant que la fenêtre n'a pas été validée.
    slot: null,
    // Train "calé" (bouton "⛔ Train calé") : validé sans avoir fini la
    // séquence ; stalledAt = heure (ISO) où il a été déclaré calé. Les
    // étapes déjà enregistrées restent affichées — voir computeTrainStatus.
    stalled: false,
    stalledAt: null,
    // Voyage supprimé (bouton "🚫 Supprimer le voyage") : le train ne roule
    // pas aujourd'hui — vignette grisée avec bannière "SUPPRIMÉ".
    cancelled: false,
    cancelledAt: null,
    // Observation libre (bouton "📝 Observation"), reprise dans le PDF
    // récap, la copie stylée et l'email.
    observation: '',
    // Infos départ (ligne "⚡ Poussé sous caténaire / 🚂 N° machine / ✉ Mail
    // reçu" de la vignette), reprises dans l'email, la copie et le PDF récap.
    pushedCatenary: false,
    pushedCatenaryAt: null,
    machineNumber: '',
    mailReceived: false,
    mailReceivedAt: null,
    steps: Array.from({ length: STEP_COUNT }, (_, i) => ({
      key: `step${i + 1}`,
      label: stepLabels[i] || `Étape ${i + 1}`,
      theoretical: null, // 'HH:MM'
      real: null, // ISO string complet (avec secondes)
      cause: '',
      offsetMinutes: null, // décalage (min, +/-) vs l'étape Départ ; recalcule l'heure théorique automatiquement si défini
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Jeu de données de démonstration, créé une seule fois (au tout premier
// lancement) pour que l'utilisateur voie immédiatement un tableau de bord
// fonctionnel. Ne réapparaît pas si l'utilisateur supprime ensuite ses trains.
export function seedDemoTrains(stepLabels) {
  const today = todayISO();
  const at = (h, m, offsetMin = 0) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    d.setMinutes(d.getMinutes() + offsetMin);
    return d.toISOString();
  };
  const demo = [
    {
      // Exemple repris tel quel : préparation avec un retard croissant.
      number: '50238',
      theoretical: ['16:30', '16:45', '16:55', '17:40', '17:42', '17:43', '17:47'],
      real: [2, 3, 5, 8, 5, 8, 9],
      cause: [null, null, null, 'Attente formation', null, null, null],
    },
    {
      number: '61175',
      theoretical: ['05:10', '05:25', '05:35', '06:20', '06:22', '06:23', '06:27'],
      real: [0, 0, -1, 0, 0, 0, 0],
      cause: [null, null, null, null, null, null, null],
    },
    {
      number: '72410',
      theoretical: ['13:05', '13:20', '13:30', '14:05', '14:07', '14:08', '14:12'],
      real: [null, null, null, null, null, null, null],
      cause: [null, null, null, null, null, null, null],
    },
  ];

  return demo.map((t, idx) => {
    const train = createEmptyTrain({ number: t.number, date: today, stepLabels, order: idx, source: 'manual' });
    train.steps.forEach((step, i) => {
      step.theoretical = t.theoretical[i];
      if (t.real[i] !== null) {
        const [h, m] = t.theoretical[i].split(':').map(Number);
        step.real = at(h, m, t.real[i]);
      }
      if (t.cause[i]) step.cause = t.cause[i];
    });
    return train;
  });
}

// ---------- Historique jour par jour (bouton "📊 Statistiques") ----------
// Navettes, tableau rapide des départs et arrivées sont remis à zéro chaque
// jour (voir loadShuttles plus haut) : pour pouvoir faire des statistiques
// à la semaine / au mois / à l'année, chaque enregistrement est AUSSI copié
// dans une entrée par jour, clé "traintrack:day:YYYY-MM-DD" →
// { date, shuttles, reserves, arrivals, theo }. `theo` (heures théoriques
// en vigueur ce jour-là) est renseigné par app.js (recordDayTheo). Les
// trains, eux, sont déjà conservés jour par jour dans STORAGE_KEYS.trains.
// Stockage local à cet appareil, comme le reste ; nettoyé au-delà de
// DAY_HISTORY_RETENTION_DAYS jours.
const DAY_HISTORY_PREFIX = 'traintrack:day:';
export const DAY_HISTORY_RETENTION_DAYS = 800;

function readDayHistory(dateISO) {
  return safeParse(localStorage.getItem(DAY_HISTORY_PREFIX + dateISO), null);
}

export function recordDayPart(dateISO, part, data) {
  try {
    const day = readDayHistory(dateISO) || { date: dateISO };
    day[part] = data;
    day.updatedAt = new Date().toISOString();
    localStorage.setItem(DAY_HISTORY_PREFIX + dateISO, JSON.stringify(day));
    return true;
  } catch (err) {
    console.warn("Historique du jour non enregistré (stockage plein ?)", err);
    return false;
  }
}

// Jours enregistrés entre fromISO et toISO inclus, triés par date.
export function loadDayHistory(fromISO, toISO) {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(DAY_HISTORY_PREFIX)) continue;
    const date = key.slice(DAY_HISTORY_PREFIX.length);
    if ((fromISO && date < fromISO) || (toISO && date > toISO)) continue;
    const day = safeParse(localStorage.getItem(key), null);
    if (day && typeof day === 'object') out.push({ ...day, date });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Au démarrage : récupère dans l'historique les données d'un jour précédent
// encore présentes (application fermée pendant la nuit, ou données saisies
// avant la mise en place de l'historique), AVANT qu'un premier
// enregistrement du jour ne les écrase.
export function harvestStaleDayData() {
  [['shuttles', STORAGE_KEYS.shuttles], ['arrivals', STORAGE_KEYS.arrivals], ['reserves', STORAGE_KEYS.shuttleReserves]].forEach(([part, key]) => {
    const raw = safeParse(localStorage.getItem(key), null);
    if (!raw || typeof raw !== 'object' || !raw.date || !raw.data || typeof raw.data !== 'object') return;
    if (Object.keys(raw.data).length === 0) return;
    const day = readDayHistory(raw.date);
    if (day && day[part] && Object.keys(day[part]).length) return;
    recordDayPart(raw.date, part, raw.data);
  });
}

export function pruneDayHistory(maxDays = DAY_HISTORY_RETENTION_DAYS) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  const pad = (n) => String(n).padStart(2, '0');
  const cutoffISO = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
  const stale = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(DAY_HISTORY_PREFIX) && key.slice(DAY_HISTORY_PREFIX.length) < cutoffISO) stale.push(key);
  }
  stale.forEach((key) => localStorage.removeItem(key));
}

try {
  harvestStaleDayData();
  pruneDayHistory();
} catch (err) {
  console.warn('Historique : initialisation impossible', err);
}
