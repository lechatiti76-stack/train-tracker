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

export function loadSettings() {
  const stored = safeParse(localStorage.getItem(STORAGE_KEYS.settings), {});
  return { ...DEFAULT_SETTINGS, ...stored };
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
    steps: Array.from({ length: STEP_COUNT }, (_, i) => ({
      key: `step${i + 1}`,
      label: stepLabels[i] || `Étape ${i + 1}`,
      theoretical: null, // 'HH:MM'
      real: null, // ISO string complet (avec secondes)
      cause: '',
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
      number: '1234',
      theoretical: ['08:15', '08:30', '08:45', '09:00', '09:15', '09:30', '09:45'],
      real: [2, 4, 5, 8, 5, 8, 9],
      cause: [null, null, null, 'Ralentissement signalisation', null, null, null],
    },
    {
      number: '5678',
      theoretical: ['09:00', '09:12', '09:24', '09:36', '09:48', '10:00', '10:12'],
      real: [0, 0, -1, 0, 0, 0, 0],
      cause: [null, null, null, null, null, null, null],
    },
    {
      number: '9021',
      theoretical: ['10:05', '10:20', '10:35', '10:50', '11:05', '11:20', '11:35'],
      real: [null, null, null, null, null, null, null],
      cause: [null, null, null, null, null, null, null],
    },
    {
      number: '4456',
      theoretical: ['07:50', '08:05', '08:20', '08:35', '08:50', '09:05', '09:20'],
      real: [1, 3, 12, 14, 13, 15, 16],
      cause: [null, null, 'Incident voyageur', null, null, null, 'Retard cumulé'],
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
