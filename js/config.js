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
  // Checklist de préparation avant le départ commercial (100 % modifiable
  // par train via "Modifier", ou ici pour changer le défaut des nouveaux
  // trains). La dernière étape n'est pas forcément une "arrivée" : le
  // statut affiché reprend automatiquement le libellé réel de la dernière
  // étape enregistrée (voir computeTrainStatus dans delay-calc.js).
  defaultStepLabels: [
    'Départ FA / Titoir-Fosse',
    'Arrivée LHTE',
    'Mise en tête',
    'Annoncé Bon au départ',
    'Retour du régulateur',
    'Ouverture du signal',
    'Départ pour la ligne',
  ],
  theme: 'auto', // 'auto' | 'light' | 'dark'
  hasSeeded: false,
  lastSyncAt: null,
  lastSyncStatus: null, // 'ok' | 'error' | null
};

export const STEP_COUNT = 7;

// Décalages (minutes, par rapport à "l'heure du sillon" = le départ pour la
// ligne + 15 min) utilisés par le remplissage automatique des 7 étapes.
// Alignés par position sur `DEFAULT_SETTINGS.defaultStepLabels` : si les
// libellés d'un train sont personnalisés, l'ordre (pas le nom) fait
// toujours foi. Reste modifiable au cas par cas après coup via "Modifier".
export const SILLON_STEP_OFFSETS = [-240, -161, -97, -38, -19, -17, -15];

// Navettes internes : chaque groupe a son propre décalage (arrivée = départ
// Terminal + offsetMinutes) et sa couleur de cadre.
export const SHUTTLE_GROUPS = [
  { id: 'FL', codes: ['FL1', 'FL2', 'FL3'], color: '#f59e0b', offsetMinutes: 35 },
  { id: 'NL', codes: ['NL1', 'NL2'], color: '#1e3a8a', offsetMinutes: 35 },
  { id: 'AL', codes: ['AL1', 'AL2'], color: '#ca8a04', offsetMinutes: 40 },
];

// Seuils (en minutes) utilisés pour la sévérité visuelle des écarts.
export const DELAY_THRESHOLDS = {
  onTime: 1, // |écart| < 1 min => "à l'heure"
  moderate: 5, // écart >= 5 min => palier "orange"
  severe: 10, // écart >= 10 min => palier "rouge"
};

export const STORAGE_KEYS = {
  trains: 'traintrack:trains:v1',
  settings: 'traintrack:settings:v1',
  shuttles: 'traintrack:shuttles:v1',
};
