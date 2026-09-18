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
  // Trains à accès rapide : un bouton par train sous les navettes, pour
  // indiquer en un clic que ce train circule aujourd'hui (ajoute sa
  // vignette) ou ne circule pas (la retire). Opérateur + destination sont
  // affichés au-dessus du numéro sur le bouton. Tout est modifiable dans
  // Réglages (numéro, opérateur, destination, ajout/suppression).
  quickTrains: [
    { number: '50238', operator: 'NAVILAND', destination: 'Vénissieux' },
    { number: '50276', operator: 'NAVILAND', destination: 'Bordeaux' },
    { number: '50274', operator: 'NAVILAND', destination: 'SPCO' },
    { number: '52006', operator: 'NAVILAND', destination: 'Montoir' },
    { number: '52232', operator: 'FERROVERGNE', destination: 'Clermont-Ferrand' },
    { number: '70630', operator: 'FERROVERGNE', destination: 'Vierzon' },
  ],
  // Navettes ajoutées par l'utilisateur en plus de FL/NL/AL (voir "+ Ajouter
  // une navette" → "Personnalisée"). Même forme que les entrées de
  // SHUTTLE_GROUPS.
  customShuttleGroups: [],
  // Codes supplémentaires ajoutés à une famille intégrée (FL/NL/AL) via
  // "+ Ajouter une navette" → préréglage FL/NL/AL (par ex. { FL: ['FL4'] }).
  // Ces codes réutilisent automatiquement la couleur, le décalage d'arrivée
  // et les passages intermédiaires de leur famille.
  shuttleExtraCodes: {},
  // Réglages FL/NL/AL personnalisés (décalage d'arrivée, seuil de
  // clignotement, passages intermédiaires), saisis dans Réglages →
  // "Navettes". Une famille absente d'ici garde les valeurs par défaut de
  // SHUTTLE_GROUPS ci-dessous. Forme d'une entrée : { offsetMinutes,
  // imminentMin, stops: [{ label, offsetMin }] }.
  shuttleTimings: {},
  // Arrivées (trains fret en provenance d'autres sites) ajoutées par
  // l'utilisateur en plus des 6 destinations intégrées (voir "+ Arrivée").
  // Même forme que les entrées de ARRIVAL_GROUPS.
  customArrivalGroups: [],
  // Réglages par défaut des 6 arrivées intégrées (décalage d'arrivée, seuil
  // de clignotement, étapes), saisis dans Réglages → "Arrivées". Une
  // destination absente d'ici garde les valeurs par défaut de
  // ARRIVAL_GROUPS ci-dessous. Forme d'une entrée : { offsetMinutes,
  // imminentMin, stops: [{ label, offsetMin }] }. Ne pas confondre avec les
  // étapes modifiées directement depuis la vignette (au clic), qui ne
  // valent que pour la journée en cours — voir loadArrivals/saveArrivals
  // dans storage.js.
  arrivalTimings: {},
  theme: 'auto', // 'auto' | 'light' | 'dark'
  hasSeeded: false,
  lastSyncAt: null,
  lastSyncStatus: null, // 'ok' | 'error' | null
  // Indicateur one-shot de migration des trains à accès rapide vers le
  // format enrichi (opérateur/destination) — voir loadSettings() dans
  // storage.js.
  quickTrainsEnrichedV2: false,
};

export const STEP_COUNT = 7;

// Navettes internes : chaque groupe a son propre décalage d'arrivée (arrivée
// = départ Terminal + offsetMinutes), sa couleur de cadre, et la liste des
// passages intermédiaires (nom + minutes depuis le départ). Ces passages
// sont désormais utilisés pour l'affichage EN TEMPS RÉEL de la progression
// de la navette (voir computeShuttleProgress dans app.js) : dès que le
// départ est validé, la vignette affiche automatiquement le dernier passage
// atteint selon le temps écoulé, jusqu'au clignotement rouge "imminente" à
// `imminentMin` minutes de l'arrivée estimée. `offsetMinutes`, `imminentMin`
// et `stops` sont réglables par famille (FL/NL/AL) dans Réglages → Navettes
// — voir DEFAULT_SETTINGS.shuttleTimings, qui prévaut sur ces valeurs par
// défaut quand renseigné.
export const SHUTTLE_DEFAULT_IMMINENT_MIN = 10;

export const SHUTTLE_GROUPS = [
  {
    id: 'FL', codes: ['FL1', 'FL2', 'FL3'], color: '#f59e0b', offsetMinutes: 35, imminentMin: SHUTTLE_DEFAULT_IMMINENT_MIN,
    stops: [
      { label: 'Départ FS', offsetMin: 2 },
      { label: 'CV 1474', offsetMin: 5 },
      { label: 'Entrée GB', offsetMin: 15 },
      { label: 'Sortie GB', offsetMin: 23 },
    ],
  },
  {
    id: 'NL', codes: ['NL1', 'NL2'], color: '#1e3a8a', offsetMinutes: 35, imminentMin: SHUTTLE_DEFAULT_IMMINENT_MIN,
    stops: [
      { label: 'Départ FS', offsetMin: 2 },
      { label: 'CV 1474', offsetMin: 5 },
      { label: 'Entrée GB', offsetMin: 15 },
      { label: 'Sortie GB', offsetMin: 23 },
    ],
  },
  {
    id: 'AL', codes: ['AL1', 'AL2'], color: '#eab308', offsetMinutes: 35, imminentMin: SHUTTLE_DEFAULT_IMMINENT_MIN,
    stops: [
      { label: 'Départ Maritime', offsetMin: 2 },
      { label: 'Départ 4R', offsetMin: 5 },
      { label: 'Pont rouge', offsetMin: 15 },
      { label: 'Point X', offsetMin: 20 },
      { label: 'passage FA', offsetMin: 25 },
    ],
  },
];

// Arrivées (trains fret en provenance d'autres sites) : même principe que
// les navettes internes (SHUTTLE_GROUPS ci-dessus) — une vignette par
// destination, avec décalage d'arrivée, couleur, et étapes intermédiaires
// (nom + minutes depuis le départ saisi). `offsetMinutes` par défaut est une
// estimation générique (3h) à ajuster dans Réglages → Arrivées selon la
// réalité du terrain pour chaque destination ; les étapes peuvent aussi être
// modifiées au jour le jour directement depuis la vignette (au clic), sans
// toucher aux valeurs par défaut ci-dessous. Couleurs choisies et validées
// (contraste + distinction daltonisme) avec l'outil de validation de
// palette catégorielle.
export const ARRIVAL_DEFAULT_IMMINENT_MIN = 10;

export const ARRIVAL_GROUPS = [
  { id: 'venissieux', label: 'Vénissieux', color: '#1baf7a', offsetMinutes: 180, imminentMin: ARRIVAL_DEFAULT_IMMINENT_MIN, stops: [] },
  { id: 'spco', label: 'Saint-Pierre-des-Corps', color: '#4f46e5', offsetMinutes: 180, imminentMin: ARRIVAL_DEFAULT_IMMINENT_MIN, stops: [] },
  { id: 'bordeaux', label: 'Bordeaux', color: '#be123c', offsetMinutes: 180, imminentMin: ARRIVAL_DEFAULT_IMMINENT_MIN, stops: [] },
  { id: 'vierzon', label: 'Vierzon', color: '#0ea5e9', offsetMinutes: 180, imminentMin: ARRIVAL_DEFAULT_IMMINENT_MIN, stops: [] },
  { id: 'clermont', label: 'Clermont-Ferrand', color: '#ca8a04', offsetMinutes: 180, imminentMin: ARRIVAL_DEFAULT_IMMINENT_MIN, stops: [] },
  { id: 'montoir', label: 'Montoir', color: '#0891b2', offsetMinutes: 180, imminentMin: ARRIVAL_DEFAULT_IMMINENT_MIN, stops: [] },
];

// Couleurs de cadre des trains à accès rapide, par opérateur (voir
// quickTrainOperatorColor dans app.js) — calculées dynamiquement à partir du
// champ `operator` de chaque train (voir DEFAULT_SETTINGS.quickTrains
// ci-dessus), donc aucune migration de données n'est nécessaire : ça
// s'applique automatiquement à tout train dont l'opérateur correspond,
// existant ou ajouté ensuite dans Réglages. Couleurs validées (contraste +
// distinction daltonisme).
export const QUICK_TRAIN_OPERATOR_COLORS = {
  NAVILAND: '#7c3aed',
  FERROVERGNE: '#ea580c',
};

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
  arrivals: 'traintrack:arrivals:v1',
};
