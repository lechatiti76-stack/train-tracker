# 🚄 Suivi Trains — Tableau de bord temps réel

Application web (HTML/CSS/JavaScript, sans framework lourd) pour suivre en
temps réel plusieurs trains : théorique vs réel, écarts calculés
automatiquement, cause principale du retard façon panneau d'aéroport,
graphique d'évolution, et installation en PWA sur mobile.

## Sommaire

1. [Arborescence du projet](#1-arborescence-du-projet)
2. [Choix techniques](#2-choix-techniques)
3. [Lancer le projet en local](#3-lancer-le-projet-en-local)
4. [Créer le dépôt GitHub](#4-créer-le-dépôt-github)
5. [Publier sur GitHub Pages](#5-publier-sur-github-pages)
6. [Connecter Google Sheets](#6-connecter-google-sheets)
7. [Installer la PWA sur smartphone](#7-installer-la-pwa-sur-smartphone)
8. [Ajouter / modifier un train](#8-ajouter--modifier-un-train)
9. [Modifier les 7 étapes](#9-modifier-les-7-étapes)
10. [Cas particuliers gérés](#10-cas-particuliers-gérés)
11. [Limites connues](#11-limites-connues)

---

## 1. Arborescence du projet

```
/
├── index.html                  Page principale (structure du dashboard)
├── manifest.json                Manifeste PWA (installation mobile)
├── service-worker.js            Cache hors-ligne (app shell)
├── css/
│   └── style.css                Design system, thèmes clair/sombre, responsive
├── js/
│   ├── config.js                 Constantes (clés de stockage, seuils, valeurs par défaut)
│   ├── storage.js                 Persistance localStorage + données de démo
│   ├── time-utils.js              Parsing d'heures, calcul d'écarts, franchissement de minuit
│   ├── delay-calc.js              Statut global, cause principale (logique métier pure)
│   ├── sheets-sync.js             Récupération + fusion des horaires Google Sheets
│   ├── splitflap.js               Composant panneau à palettes façon aéroport
│   ├── charts.js                  Graphique théorique/réel en heure absolue (Chart.js)
│   ├── card.js                    Génération/mise à jour du HTML d'une vignette
│   ├── stopwatch.js               Chronomètre de pause indépendant (feu tricolore)
│   └── app.js                     Orchestrateur : état, événements, modales
├── apps-script/
│   └── Code.gs                   Web App Google Apps Script (lecture seule, sans clé API)
├── data/
│   └── exemple-google-sheet.csv  Exemple de feuille à importer dans Google Sheets
├── assets/
│   └── icons/                    Icônes PWA (générées, voir tools/generate-icons.js)
├── tools/
│   ├── generate-icons.js         Script Node pour régénérer les icônes (aucune dépendance)
│   ├── dev-server.js              Petit serveur statique pour tester en local sans rien installer
│   └── build-demo.js              Assemble une démo mono-fichier (js/* fusionnés, sans Chart.js/PWA)
│                                   pratique pour un aperçu rapide en dehors du dépôt
└── README.md
```

## 2. Choix techniques

- **Pas de framework** (React/Vue/etc.) : le besoin (vignettes, formulaires,
  graphiques) ne le justifie pas et ça garde le projet 100 % statique,
  donc compatible GitHub Pages sans étape de build.
- **JavaScript en modules ES** (`type="module"`) : découpage clair
  (stockage / calculs / rendu / réseau) sans outil de bundling.
- **Chart.js** (chargé depuis un CDN, mis en cache par le Service Worker
  pour l'usage hors-ligne) pour les graphiques d'évolution.
- **localStorage** pour la persistance immédiate ; toute la couche d'accès
  aux données passe par `js/storage.js`, qui peut être remplacé demain par
  des appels à une API/BDD sans toucher au reste de l'application.
- **Google Apps Script en Web App** pour les horaires théoriques : c'est la
  façon standard de publier un Google Sheet en JSON en lecture seule
  **sans jamais exposer de clé API côté navigateur** (Apps Script s'exécute
  sous l'identité du propriétaire de la feuille).
- **Logique de calcul des écarts séparée du DOM** (`delay-calc.js`,
  `time-utils.js`) : testable indépendamment, gère le franchissement de
  minuit et les étapes sans heure théorique.

## 3. Lancer le projet en local

Comme l'app utilise des modules ES (`import`/`export`), elle doit être
servie via HTTP (pas en ouvrant `index.html` directement en `file://`).
Le plus simple :

```bash
cd train-tracker
node tools/dev-server.js 8080
```

(alternative sans rien installer, un simple serveur statique maison) ou,
si vous avez déjà les outils correspondants :

```bash
npx serve .
# ou
python -m http.server 8080
```

Puis ouvrez `http://localhost:8080`.

## 4. Créer le dépôt GitHub

```bash
cd train-tracker
git init
git add .
git commit -m "Première version : suivi trains temps réel"
git branch -M main
git remote add origin https://github.com/<votre-utilisateur>/<nom-du-repo>.git
git push -u origin main
```

(Créez d'abord le dépôt vide sur github.com si ce n'est pas déjà fait,
via "New repository".)

## 5. Publier sur GitHub Pages

1. Sur GitHub, ouvrez **Settings → Pages** du dépôt.
2. Dans "Build and deployment", choisissez **Source : Deploy from a branch**.
3. Branche : `main`, dossier : `/ (root)`.
4. Enregistrez. L'URL publique apparaît sous la forme
   `https://<votre-utilisateur>.github.io/<nom-du-repo>/`.
5. Le manifeste et le service worker utilisent des chemins **relatifs**
   (`./...`), donc l'app fonctionne aussi bien à la racine d'un domaine que
   dans un sous-dossier de type Pages — aucune adaptation nécessaire.

## 6. Connecter Google Sheets

Aucune clé API n'est jamais placée dans le code : on publie le Google Sheet
via un petit script serveur (Google Apps Script), qui renvoie du JSON en
lecture seule.

### 6.1. Préparer la feuille

1. Créez un Google Sheet avec un onglet nommé **`Horaires`**.
2. Première ligne = en-têtes : `Train | Étape | Heure théorique | Cause | Jours de circulation`
3. Importez ou recopiez le contenu de [`data/exemple-google-sheet.csv`](data/exemple-google-sheet.csv)
   pour voir un exemple fonctionnel (`Fichier → Importer` dans Google Sheets).
4. Le libellé de la colonne **Étape** doit correspondre exactement aux
   libellés configurés côté app (par défaut : `Départ FA / Titoir-Fosse`,
   `Arrivée LHTE`, `Mise en tête`, `Annoncé Bon au départ`, `Retour du
   régulateur`, `Ouverture du signal`, `Départ pour la ligne` — voir
   [section 9](#9-modifier-les-7-étapes)).
5. **Jours de circulation** : le planning est basé sur des jours de la
   semaine récurrents, pas sur une date précise — un sillon n'a besoin
   d'être saisi qu'une seule fois, pas rejoué chaque jour. Écrivez les jours
   séparés par une virgule, en français, complets ou abrégés (3 lettres
   suffisent) : `Mardi,Jeudi`, `Lundi,Mercredi,Vendredi`, ou `Tous les
   jours` pour un service quotidien. Toutes les lignes d'un même sillon
   (même numéro de train) doivent avoir les mêmes jours.

### 6.2. Déployer le Web App

1. Dans le Google Sheet : **Extensions → Apps Script**.
2. Supprimez le contenu par défaut et collez celui de
   [`apps-script/Code.gs`](apps-script/Code.gs).
3. Enregistrez le projet Apps Script (nommez-le par exemple "Suivi Trains API").
4. Cliquez sur **Déployer → Nouveau déploiement**.
5. Type : **Application Web**.
6. "Exécuter en tant que" : **Moi**.
7. "Qui a accès" : **Tout le monde** (c'est un accès en LECTURE SEULE aux
   horaires théoriques, sans donnée sensible ; si besoin d'un accès plus
   restreint, changez cette option, mais l'app devra alors être utilisée
   par des comptes Google autorisés).
8. Cliquez sur **Déployer**, autorisez les permissions demandées, puis
   copiez l'**URL du Web App** (se termine par `/exec`).

### 6.3. Renseigner l'URL dans l'application

1. Ouvrez l'application, cliquez sur **⚙ Réglages**.
2. Collez l'URL dans "URL du Web App Google Apps Script".
3. Cliquez sur **Synchroniser maintenant**, puis **Enregistrer**.

L'URL est stockée dans le navigateur de chaque utilisateur (localStorage).
Pour qu'elle soit préconfigurée pour tout le monde sans passer par les
Réglages, vous pouvez aussi la coder en dur dans
`js/config.js` → `DEFAULT_SETTINGS.sheetsWebAppUrl` avant de publier.

Si le Sheet est injoignable (pas de réseau, mauvaise URL, quota Apps
Script dépassé...), l'application affiche un indicateur d'erreur discret
dans l'en-tête et continue de fonctionner avec les données déjà en local —
elle ne plante jamais.

### 6.4. Remplissage automatique des 7 heures depuis "l'heure du sillon"

Chaque vignette a un champ **"Heure du sillon (départ pour la ligne + 15
min)"** juste sous son en-tête. C'est un calcul 100 % local (aucun appel
réseau) qui évite de ressaisir les 7 horaires théoriques à la main :

1. Tapez l'heure du sillon et cliquez sur **⚡ Remplir les 7 heures** (ou
   appuyez sur Entrée).
2. L'application calcule automatiquement l'heure théorique des 7 étapes à
   partir de cette seule valeur, selon un enchaînement fixe :

   | Étape                     | Décalage vs heure du sillon |
   | ------------------------- | ---------------------------: |
   | Départ FA / Titoir-Fosse  | -240 min |
   | Arrivée LHTE               | -161 min |
   | Mise en tête                | -97 min |
   | Annoncé Bon au départ      | -38 min |
   | Retour du régulateur        | -19 min |
   | Ouverture du signal          | -17 min |
   | Départ pour la ligne          | -15 min |

3. Les heures **réelles déjà enregistrées ne sont jamais touchées** — seul
   le théorique change, donc les écarts et le graphique se recalculent en
   conséquence.
4. **Cas particuliers** : rien n'empêche de corriger ensuite une étape à la
   main via **"Modifier"** si un train a besoin d'un enchaînement différent
   ce jour-là — le remplissage automatique est un point de départ, pas une
   contrainte figée.

Ces décalages sont définis une fois pour toutes dans `js/config.js` →
`SILLON_STEP_OFFSETS` (alignés par position sur les 7 étapes, pas par nom :
si vous renommez une étape, gardez le même ordre).

## 7. Installer la PWA sur smartphone

### Android (Chrome)

1. Ouvrez l'URL GitHub Pages de l'application dans Chrome.
2. Un bouton **"Installer l'app"** apparaît dans l'en-tête dès que le
   navigateur juge l'app installable (sinon : menu ⋮ → "Installer
   l'application" / "Ajouter à l'écran d'accueil").

### iPhone / iPad (Safari)

iOS n'affiche pas de bouton d'installation automatique : il faut passer par
le menu de partage.

1. Ouvrez l'URL dans **Safari** (pas Chrome iOS).
2. Appuyez sur l'icône Partager (carré avec une flèche).
3. Choisissez **"Sur l'écran d'accueil"**.
4. L'application s'ouvre ensuite en plein écran, comme une app native.

## 8. Ajouter / modifier un train

- **Ajouter** : bouton **"+ Ajouter un train"** en haut à droite → renseignez
  le numéro, la date de circulation, et pour chaque étape le libellé,
  l'heure théorique et une cause optionnelle.
- **Un train qui circule sur plusieurs dates précises** : dans le formulaire
  d'ajout, cliquez **"+ Ajouter une autre date de circulation"** autant de
  fois que nécessaire. Une vignette indépendante est créée par date (chacune
  garde ses propres heures réelles). Pour un train qui circule chaque
  semaine les mêmes jours, préférez plutôt la synchronisation Google Sheets
  avec la colonne "Jours de circulation" (section 6.1) — plus adapté à un
  service récurrent.
- **Modifier** : bouton **"Modifier"** sur la vignette du train. Les heures
  réelles déjà enregistrées ne sont jamais touchées par ce formulaire —
  seules les infos générales (numéro, date, libellés, heures théoriques,
  causes) sont modifiées ici. Ne modifie qu'une seule vignette à la fois
  (pas de "date multiple" en édition).
- **Supprimer** : bouton **✕** sur la vignette (confirmation demandée).
- **Réinitialiser toutes les heures** : bouton **"↺ Réinitialiser les
  heures"** dans le pied de la vignette — efface en un clic les 7 heures
  réelles enregistrées (confirmation demandée), sans toucher aux horaires
  théoriques. Pour ne réinitialiser qu'une seule étape, utilisez plutôt
  l'icône ↺ à côté de cette étape.
- **Réorganiser** : boutons **◀ ▶** dans le pied de la vignette (fonctionne
  partout, y compris tactile) ; sur ordinateur, on peut aussi glisser une
  vignette par sa poignée **⠿**.
- Par défaut, l'app crée 3 trains de démonstration au tout premier
  lancement (une seule fois) pour montrer un tableau de bord déjà rempli.

### 8.1. Voir tous les trains enregistrés (calendrier / vue globale)

Le tableau de bord n'affiche que les trains **de la date du jour**. Pour
voir tous les trains déjà enregistrés, quelle que soit leur date (passée
ou à venir — par exemple un train ajouté pour lundi prochain), cliquez sur
**"📅 Calendrier"** dans l'en-tête. Chaque date apparaît avec son nombre de
trains ; cliquez dessus pour voir le détail (statut, cause principale,
écart max) en lecture seule. Aucune donnée n'est jamais supprimée par le
changement de date — cette vue permet justement de les retrouver.

### 8.2. Chronomètre de pause

Un chronomètre indépendant (pas lié à un train en particulier) est affiché
en permanence sous l'en-tête, pour mesurer un temps de pause/arrêt :

- **▶ Démarrer** lance le décompte, **⏸ Arrêter** le met en pause (un
  nouveau **Démarrer** reprend où il s'était arrêté), **↺ Réinitialiser**
  remet à zéro (confirmation demandée si un temps est en cours).
- Un indicateur façon **feu tricolore** s'allume selon le temps écoulé :
  **rouge** de 0 à 15 min, **orange** de 15 à 20 min, **vert** au-delà de
  20 min.
- L'état survit à un rechargement accidentel de la page (sauvegardé dans le
  navigateur).

### 8.3. Navettes internes

Une rangée de vignettes cliquables pour les navettes internes est affichée
sous le chronomètre, groupées par couleur de cadre :

| Groupe | Lignes | Couleur | Arrivée = départ + |
| ------ | ------ | ------- | ------------------: |
| FL | FL1, FL2, FL3 | orange | 35 min |
| NL | NL1, NL2 | bleu foncé | 35 min |
| AL | AL1, AL2 | jaune | 40 min |

Cliquez sur une navette pour ouvrir une fenêtre où saisir son **heure de
départ du Terminal** ; l'heure d'arrivée estimée se calcule et s'affiche
immédiatement (et se met à jour en direct pendant la saisie). Un bouton
**"Effacer"** réinitialise cette navette. Les lignes, couleurs et décalages
se modifient dans `js/config.js` → `SHUTTLE_GROUPS`.

## 9. Modifier les 7 étapes

- **Pour un train existant** : bouton "Modifier" sur sa vignette → chaque
  étape a son propre champ "Libellé".
- **Pour tous les nouveaux trains** : ⚙ **Réglages** → "Libellés par défaut
  des 7 étapes". Ça ne change pas les trains déjà créés.
- Si vous utilisez Google Sheets, pensez à renommer la colonne **Étape**
  dans le Sheet pour qu'elle corresponde exactement aux nouveaux libellés
  (la comparaison ignore la casse et les accents, mais pas les libellés
  complètement différents).

### 9.1. Étapes de préparation avant le départ (décalage automatique)

Certaines étapes se déroulent **avant** le départ commercial (préparation
du train, essais, formation...) et ont des horaires théoriques fixes par
rapport à celui-ci, plutôt que des horaires qui viennent du Sheet. Pour ça,
dans le formulaire "Modifier" de chaque étape (sauf la 1ʳᵉ, "Départ", qui
sert de référence), un champ **"Décalage / Départ (min)"** est disponible :

- Renseignez un nombre de minutes **négatif** pour une étape avant le
  départ (ex : `-91` pour une étape 1h31 avant), ou **positif** pour une
  étape après.
- Dès que ce décalage est renseigné, l'heure théorique de cette étape est
  **calculée automatiquement** à partir de celle du Départ — inutile de la
  ressaisir, et le champ "Heure théorique" de cette étape est alors ignoré.
- Le recalcul se refait à chaque fois que l'heure théorique du Départ
  change : en la modifiant à la main, ou automatiquement via la recherche
  de sillon (section 6.4) ou la synchronisation Google Sheets.
- L'écart (retard/avance) de ces étapes de préparation se calcule et
  s'affiche exactement comme pour les autres : heure réelle enregistrée
  comparée à l'heure théorique (ici, dérivée du Départ).
- Laissez le champ vide pour une étape dont l'heure théorique doit rester
  saisie manuellement ou venir du Sheet (comportement par défaut, inchangé).

## 10. Cas particuliers gérés

- Aucune heure réelle enregistrée → statut **"EN ATTENTE"**, étape affichée
  avec un bouton d'enregistrement.
- Train à l'heure (écart < 1 min) → **"À L'HEURE"** (affichage neutre/vert).
- Train en avance → écart négatif affiché distinctement (bleu).
- Retards successifs → le graphique et la cause principale se
  recalculent après chaque clic, en prenant toujours le plus gros écart.
- Correction d'une heure → icône ✎ sur une étape déjà enregistrée.
- Réinitialisation d'une heure → icône ↺ (confirmation demandée).
- Changement de date en cours de journée → l'horloge vérifie la date
  chaque seconde ; à minuit, le tableau de bord bascule automatiquement
  sur les trains du nouveau jour, sans recharger la page. Les trains de la
  veille restent consultables via **Historique**, jamais supprimés.
- Franchissement de minuit sur un même trajet (ex : départ 23h50, arrivée
  00h05) → pris en compte dans le calcul de l'écart (`time-utils.js`).
- Étape sans heure théorique → l'heure réelle est quand même affichée,
  simplement sans écart calculable ("—").
- Google Sheet inaccessible ou mal configuré → indicateur d'erreur discret,
  aucune donnée locale perdue, aucun plantage.
- Recherche de sillon sans correspondance dans le Sheet (heure inconnue, ou
  sillon qui ne circule pas ce jour de la semaine) → message explicite sous
  le champ, rien n'est modifié sur la vignette.
- Dernière étape qui n'est pas une arrivée (ex : "Départ pour la ligne")
  → le statut global reprend automatiquement le libellé réel de cette
  dernière étape plutôt qu'un mot "ARRIVÉ" figé.

## 11. Limites connues

- Les données sont stockées **dans le navigateur de chaque utilisateur**
  (localStorage) : deux personnes ouvrant l'app sur deux appareils ne
  voient pas les mêmes heures réelles saisies. Pour une utilisation
  multi-utilisateurs en temps réel, il faudra brancher une vraie base de
  données/API à la place de `js/storage.js` (l'architecture est prévue pour
  ça).
- Le bouton "Email" ouvre le client mail par défaut avec un brouillon
  pré-rempli (`mailto:`) — il n'envoie rien automatiquement, l'utilisateur
  doit cliquer sur "Envoyer" dans son application mail. Un envoi
  automatique côté serveur nécessiterait un vrai backend (ex : une
  fonction cloud avec une API d'emailing) pour ne jamais exposer
  d'identifiants dans le navigateur.
- Le glisser-déposer natif (souris) fonctionne pour réorganiser les
  vignettes ; sur tactile, utilisez les boutons ◀ ▶ (le drag-and-drop HTML5
  n'est pas fiable sur mobile).
