// Configuration centrale de l'application.
// Rien de secret ici : l'URL Google Apps Script pointe vers un Web App
// en lecture seule (voir /apps-script/Code.gs) — aucune clé API n'est
// jamais exposée côté client.
export const APP_VERSION = '1.0.0';

export const DEFAULT_SETTINGS = {
  // Renseignez ici l'URL de votre déploiement Google Apps Script (Web App)
  // si vous voulez une valeur par défaut pour tous les visiteurs.
  // Sinon, laissez vide : chaque utilisateur peut la définir via Réglages
  // (elle est alors stockée dans son navigateur).
  sheetsWebAppUrl: '',
  defaultStepLabels: ['Départ', 'Point 1', 'Point 2', 'Point 3', 'Point 4', 'Point 5', 'Arrivée'],
  theme: 'auto', // 'auto' | 'light' | 'dark'
  hasSeeded: false,
  lastSyncAt: null,
  lastSyncStatus: null, // 'ok' | 'error' | null
};

export const STEP_COUNT = 7;

// Seuils (en minutes) utilisés pour la sévérité visuelle des écarts.
export const DELAY_THRESHOLDS = {
  onTime: 1, // |écart| < 1 min => "à l'heure"
  moderate: 5, // écart >= 5 min => palier "orange"
  severe: 10, // écart >= 10 min => palier "rouge"
};

export const STORAGE_KEYS = {
  trains: 'traintrack:trains:v1',
  settings: 'traintrack:settings:v1',
};
