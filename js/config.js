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
  // Décalages (minutes, par rapport à "l'heure du sillon" = le départ pour
  // la ligne + 15 min) utilisés par "Remplir les 7 heures" sur chaque
  // vignette. Alignés par position sur `defaultStepLabels` (pas par nom).
  // Modifiable dans Réglages sans toucher au code — voir la section
  // "Décalages du remplissage automatique" du README pour les ajuster si
  // les horaires calculés ne correspondent pas à la réalité du terrain.
  // Valeurs vérifiées à partir de la séquence réelle (feuille de calcul) :
  // 16:36 → +15 → 16:51 → +5 → 16:56 → +45 → 17:41 → +3 → 17:44 → +2 →
  // 17:46 → +2 → 17:48 → +15 → 18:03 (sillon), soit -87/-72/-67/-22/-19/-17/-15.
  sillonStepOffsets: [-87, -72, -67, -22, -19, -17, -15],
  // Numéros de trains à accès rapide : un bouton par numéro sous les
  // navettes, pour indiquer en un clic que ce train circule aujourd'hui
  // (ajoute sa vignette) ou ne circule pas (la retire). Modifiable dans
  // Réglages.
  quickTrainNumbers: ['50238', '52232', '70630', '52006'],
  // Navettes ajoutées par l'utilisateur en plus de FL/NL/AL (voir "+ Ajouter
  // une navette"). Même forme que les entrées de SHUTTLE_GROUPS.
  customShuttleGroups: [],
  theme: 'auto', // 'auto' | 'light' | 'dark'
  hasSeeded: false,
  lastSyncAt: null,
  lastSyncStatus: null, // 'ok' | 'error' | null
};

export const STEP_COUNT = 7;

// Navettes internes : chaque groupe a son propre décalage (arrivée = départ
// Terminal + offsetMinutes), sa couleur de cadre, et la liste des passages
// intermédiaires (nom + minutes depuis le départ) affichée dans sa fenêtre —
// à titre indicatif seulement : les états visuels (en approche / imminente /
// arrivée) restent calculés à partir du temps restant avant l'arrivée
// (voir computeShuttleState dans app.js), pas à partir de ces passages.
export const SHUTTLE_GROUPS = [
  {
    id: 'FL', codes: ['FL1', 'FL2', 'FL3'], color: '#f59e0b', offsetMinutes: 35,
    stops: [
      { label: 'Départ FS', offsetMin: 2 },
      { label: 'CV 1474', offsetMin: 5 },
      { label: 'Entrée GB', offsetMin: 15 },
      { label: 'Sortie GB', offsetMin: 23 },
    ],
  },
  {
    id: 'NL', codes: ['NL1', 'NL2'], color: '#1e3a8a', offsetMinutes: 35,
    stops: [
      { label: 'Départ FS', offsetMin: 2 },
      { label: 'CV 1474', offsetMin: 5 },
      { label: 'Entrée GB', offsetMin: 15 },
      { label: 'Sortie GB', offsetMin: 23 },
    ],
  },
  {
    id: 'AL', codes: ['AL1', 'AL2'], color: '#ca8a04', offsetMinutes: 35,
    stops: [
      { label: 'Départ Maritime', offsetMin: 2 },
      { label: 'Départ 4R', offsetMin: 5 },
      { label: 'Pont rouge', offsetMin: 15 },
      { label: 'Point X', offsetMin: 20 },
      { label: 'passage FA', offsetMin: 25 },
    ],
  },
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
