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
    return true;
  } catch (err) {
    console.error('Impossible d\'enregistrer les arrivées.', err);
    return false;
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
