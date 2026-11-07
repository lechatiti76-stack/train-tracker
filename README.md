# Suivi des circulations

Application web de saisie et d'affichage des circulations d'un terminal ferroviaire. Elle remplace deux classeurs Excel :

- **SAISIE** (`saisie.html`) : poste opérateur. Journal des mouvements, circulations du jour, préparation du lendemain, flash info, mails aux EF, clôture.
- **ÉCRANS** (`visuel.html`) : affichage plein écran des TV, en lecture seule.

Les pages sont publiées par **GitHub Pages**. Les données (journées, planning, paramètres) sont gardées dans le **Google Drive** de l'utilisateur par un petit script **Google Apps Script** (`apps-script/Code.gs`), qui transmet aux écrans les seules informations autorisées à l'affichage.

> Outil d'information d'exploitation : il ne remplace ni les procédures réglementaires de circulation, ni les installations de sécurité.

Aucune donnée de l'entreprise n'est dans ce dépôt : le planning, les voies, la base N° → EF et les destinataires des mails sont importés une fois depuis l'écran Connexion (fichier `donnees-initiales.json`, conservé hors du dépôt).

---

## Installation (une seule fois)

### 1. Publier les pages (GitHub Pages)

1. Sur GitHub, dépôt `suivi-circulations` › **Settings** › **Pages**.
2. **Source** : *Deploy from a branch*, branche **main**, dossier **/ (root)**, puis **Save**.
3. Une minute plus tard, le site répond à `https://lechatiti76-stack.github.io/suivi-circulations/`.

### 2. Créer le serveur Google (Apps Script)

1. Aller sur <https://script.google.com> › **Nouveau projet**. Le nommer « Suivi des circulations ».
2. Remplacer le contenu de `Code.gs` par celui de [`apps-script/Code.gs`](apps-script/Code.gs).
3. Ligne `const CLE = 'CHANGER-CE-MOT-DE-PASSE';` : mettre un mot de passe de votre choix (lettres et chiffres). Il sera demandé une fois sur le poste de saisie.
4. **Paramètres du projet** (roue dentée) › fuseau horaire **(GMT+01:00) Paris**.
5. **Déployer** › **Nouveau déploiement** › type **Application Web** :
   - *Exécuter en tant que* : **Moi** ;
   - *Qui a accès* : **Tout le monde**.
6. **Déployer**, autoriser l'accès demandé (Drive, Sheets, mails), puis copier l'**URL de l'application Web** (elle se termine par `/exec`).

Au premier appel, le script crée dans votre Drive le dossier **« Suivi des circulations - données »** (journées, planning, archives) et le classeur **« Suivi des circulations - registre »** (onglets Journal, Mails, Statistiques).

### 3. Connecter la saisie

1. Ouvrir `https://lechatiti76-stack.github.io/suivi-circulations/saisie.html`.
2. La fenêtre **Connexion** s'ouvre : coller l'URL `/exec`, la clé, puis **Tester la connexion**.
3. **Données initiales** : choisir `donnees-initiales.json` puis **Importer**. La page se recharge avec le planning du jour.
4. Recopier le **lien des écrans** affiché dans cette même fenêtre.

### 4. Les deux applications (ou raccourcis)

**Application sur le bureau (recommandé, comme le Suivi trains)** : dans la saisie, bouton **⬇ Installer l'application** (ou **Raccourcis ⬇** › « Installer l'application Saisie »). Pour le PC des TV : **Raccourcis ⬇** › « Ouvrir la page Écrans pour l'installer », puis **Installer l'application** sur cette page (à faire sur le PC des TV). Chaque application a son icône sur le bureau et dans le menu Démarrer, et s'ouvre sur une courte animation, des lettres qui tombent en cascade et forment le titre (« Passer » ou une touche pour l'écourter ; pas d'animation après une mise à jour automatique). L'application Écrans retient l'adresse du serveur ; F11 pour le plein écran si besoin.

**Ou des raccourcis .bat** (bouton **Raccourcis ⬇**, déjà remplis avec l'adresse du serveur) :

| Poste | Fichier | Réglage |
|---|---|---|
| Poste de saisie | [`raccourcis/Saisie.bat`](raccourcis/Saisie.bat) | aucun |
| PC des TV | [`raccourcis/Ecrans.bat`](raccourcis/Ecrans.bat) | remplacer `COLLER-ICI-L-ADRESSE-EXEC` par l'URL `/exec` |

Copier chaque fichier sur le bureau du poste concerné. `Ecrans.bat` ouvre la page en plein écran (Alt+F4 pour quitter). Pour un démarrage automatique, placer aussi le raccourci dans le dossier ouvert par Windows+R › `shell:startup`.

---

## Utilisation

- **N° train** : dès les premières lettres, une liste propose les numéros du jour (avec leur circulation), les mouvements internes et la base N° → EF (« loc » → locom, loco, locosup…) ; ↓ ↑ pour choisir, Entrée pour prendre. L'EF se remplit d'après la base N° → EF (Paramètres). Une EF corrigée à la main peut y être ajoutée d'un clic.
- **Entrée** passe au champ suivant (voie, wagons, chargés/vides, situation, vers, commentaire) jusqu'à **Valider** ; un champ obligatoire vide bloque le passage. **Ctrl+Entrée** enregistre directement. La voie de destination est obligatoire pour les locomotives et manœuvres (réglable).
- **Tableau de droite** : heure, HLR, wagons et voie de chaque navette ou train se modifient sur place et s'affichent sur les écrans. **Garder pour tous les lundis** (selon le jour) les reprend automatiquement les semaines suivantes. L'onglet **Demain** prépare le lendemain.
- **Tableau de droite** : chaque groupe a sa couleur (TDF orange, TN bleu, ATL jaune, Naviland violet, Ferovergne vert…). Dans **Navettes** et **Trains de ligne**, on choisit le groupe (TDF, TN, ATL, ou l'EF du train, ou Tous) puis **Départs** ou **Arrivées** (ou Tous) : seules ces lignes s'affichent, et le badge de chaque bouton compte ce qui reste à faire (en rouge s'il y a un retard). Le choix est gardé sur le poste. Pas de HLR pour les arrivées. Onglets **Demain** et **après-demain** (ex. « Mercredi 28 ») : la préparation d'après-demain devient celle de demain le jour suivant, et les deux s'affichent sur les écrans sous « Prochaines navettes ».
- **Arrivées de trains** : **FA** (arrivé au faisceau, pas encore chez nous), **Déjà là** (déjà chez nous), **En approche** (parti de FA vers chez nous ; délai du Suivi trains), **Arrivée** (chez nous). **Navettes** : **Partie** quand la navette quitte son terminal (les écrans suivent ses points de passage), puis **Arrivée**. **Départs** : **Parti**. **Non prévue** retire la circulation des écrans (Rétablir pour la remettre). **F2** : arrivé ou parti maintenant pour le numéro tapé.
- **Journal des mouvements** : une Arrivée ou un Parti (saisi ici ou venu du Suivi trains) ajoute la ligne automatiquement (numéro, EF, voie et wagons prévus), en couleur ; « Annuler » la retire. Les boutons **Réel**, **Modifier** et **Suppr.** restent collés au bord droit du journal, même sur un petit écran.
- **Plusieurs fenêtres de saisie** ouvertes en même temps (deux PC, ou l'application et un onglet) : chaque fenêtre relit la journée avant de republier l'affichage ; une fenêtre restée en arrière ne remet plus une navette « pas partie » sur les écrans et dans le Suivi trains.
- **Planning** (aussi depuis Paramètres) : jours de circulation de chaque train et navette, et sous chaque ligne le **n° ou sillon par jour** (vide = n° habituel).
- La saisie et les écrans se rechargent seuls quand une nouvelle version est publiée (pas pendant une saisie en cours).
- **Suivi trains** (Paramètres) : avec l'adresse du classeur Google de l'application Suivi trains, la saisie le lit toutes les 10 secondes (délai complet jusqu'aux écrans : 10 à 20 secondes, serveur 2.3.0 ou plus récent). Navette validée (FL1…) → en route sur les écrans ; arrivée, tableau des départs (LF1…), arrivées fret et « Départ pour la ligne » → heure réelle ; étapes d'un train (mise en tête…) → déroulé du départ et état sur les écrans. Une correction faite dans la saisie reste tant que le Suivi trains n'envoie pas une nouvelle heure. Le classeur doit être dans le même compte Google que ce serveur (ou lui être partagé). Les durées de trajet et points de passage se règlent dans Paramètres. **Temps d'arrivée des trains de ligne** (Paramètres) : minutes entre « En approche » et l'arrivée, par train (BDX, VNX…), à régler comme dans le Suivi trains (vide = 180 min).
- **Écrans** : sur les trains de ligne, le nom de l'EF est à sa couleur (Naviland violet clair, Ferovergne vert, les autres bleu clair). L'état des **départs et des arrivées de trains** s'affiche en lettres à volets sur fond noir, comme dans un aéroport (Prévu blanc, Dans 12 min jaune, en approche bleu, Retard rouge, Parti vert, Supprimé rouge…) ; les lettres tournent quand l'état change, un peu plus lentement pour les arrivées. Une heure prévue est affichée, l'heure réelle est dans l'état (« Parti 10:02 », « Arrivée 10:42 »). À **5 minutes ou moins**, l'état clignote en rouge. Les voies multiples (VR5+VF3) s'écrivent sur deux lignes ; une voie encore trop longue est resserrée ou défile sans repartir de zéro. Un train déclaré **⛔ calé** dans le Suivi trains s'affiche en priorité (« Calé à 08:41 », dernière étape en dessous). Les villes des trains de ligne (« En provenance de… / À destination de… ») se règlent dans Paramètres › Écrans. L'onglet **Demain** de la saisie a un texte libre par groupe de navettes, affiché sous « Prochaines navettes ».
- **Dans l'autre sens**, le Suivi trains relit toutes les 20 secondes ce que reçoivent les écrans (adresse `/exec` à mettre dans ses Réglages, sans clé) : une navette marquée **Partie**, **Parti** ou **Arrivée** dans la saisie, ou une arrivée fret, y apparaît automatiquement.
- **Mails** : livrés en mode **Simulation** (rien ne part, chaque mail est noté dans l'onglet Mails du registre). En mode Brouillon ou Automatique, ils partent du compte Google qui a déployé le script. Les adresses se règlent dans Paramètres › Mails : une ligne par EF pour les trains de ligne, une ligne par groupe pour les navettes, plus la copie cachée des trains et la copie des navettes.
- **Statistiques** : LHTE (locom, loco), locosup et manœuvres NRS, chacun en HLP ou chargé, le matin, l'après-midi et sur la journée (coupure réglable dans Paramètres).
- **Clôturer** : archives CSV dans Drive › archives › année, ligne ajoutée à l'onglet Statistiques du registre (les colonnes NRS sont ajoutées en fin de ligne, serveur 2.3.0).

## Écrans dynamiques (vedettes) et démonstration

- **Navettes et trains en vedette**, seulement sur des événements réels (jamais sur l'heure théorique) :
  - **arrivées** (navettes et trains) : quand elles sont **en route** (Partie / En approche) puis dans les 5 dernières minutes avant l'arrivée estimée, jusqu'à l'arrivée ;
  - **départ d'un train** : « Départ imminent » dès que **Annoncé Bon au départ** est validé dans le Suivi trains ;
  - **départ d'une navette** : « Départ imminent » dès le bouton **▲** de la saisie (sur la ligne de départ de la navette ; un second clic retire l'annonce) ;
  - une fois **Parti**, « ✓ Partie » 10 secondes puis retour à l'écran principal.
  Le carré de la navette (couleur du groupe) prend toute la partie haute, avec la **voie de départ saisie** en grand ; les trains ont une bande animée en bas. Plusieurs en même temps se partagent la place.
- **2 ou 3 fenêtres** : un groupe sans navette dans les 3 prochaines heures passe en colonne étroite (prochaine navette du jour + Prochaines navettes de demain et après-demain). Le matin, TDF et TN en grand ; ATL revient en grand quand sa navette approche.
- Réglages dans l'adresse de la page Écrans : `avant=5` (minutes avant l'arrivée estimée), `apres=1` (minutes après une arrivée), `apresDepart=10` (secondes après un départ), `garde=5` (secondes minimum d'affichage en grand d'une arrivée/départ validé avant le retour au tableau), `horizon=180` (minutes), `groupes=tous` (toujours 3 fenêtres), `vedette=0` (désactiver). Exemple : `visuel.html?source=…&avant=4&apres=2`.
- **Démonstration** (sans serveur) : `https://lechatiti76-stack.github.io/suivi-circulations/visuel.html?demo=1` : une journée simulée qui tourne en boucle toutes les 7 minutes (départs simultanés LF1 + LN1, arrivées, train qui arrive pendant qu'un autre part, ATL qui passe de la petite colonne à la grande fenêtre).

## Coupons navettes (repris du Suivi trains)

- Les coupons saisis dans le Suivi trains (bouton 🎫 Coupons) partent dans l'onglet **Coupons** de son classeur (adresse du Web App dans les Réglages du Suivi trains, `apps-script/Code.gs` du Suivi trains à redéployer).
- La saisie les relit avec le reste toutes les 10 secondes (serveur 2.4.0) : bouton **🎫 Coupons** (aujourd'hui et demain, par site et par navette, totaux de wagons) et pastille « 🎫 2 · 22 wg » sous chaque départ de navette concerné. Lecture seule : les coupons se saisissent dans le Suivi trains.

## Voie, wagons et annonce depuis le Suivi trains

- Dans le Suivi trains, chaque arrivée/départ de navette et chaque train (fenêtre Composition) a les champs **Voie** et **Wagons**. Ils remplissent la voie et le nombre de wagons du tableau de droite de la saisie (lecture toutes les 4 s). Une correction faite dans la saisie reste prioritaire tant que le Suivi trains ne change pas la valeur.
- Le **▲** d'une case « Départs navettes » du Suivi trains annonce le départ : ▲ allumé dans la saisie et « Départ imminent » sur les écrans, avant la validation du départ.
- Rafraîchissement : écrans toutes les 2 s ; délai saisie → écran d'environ 1 à 3 s (aller-retour Google).

## Travaux (avis envoyés par un autre service)

1. Saisie › **Paramètres › Travaux** : cliquez **Générer** (clé d'envoi), vérifiez la liste des appareils (`CODE | Libellé | alias`) et les phrases orange / rouge (`{appareil}` est remplacé par le libellé), puis **Enregistrer**.
2. Donnez à l'autre service l'**Adresse d'envoi** affichée (`…/exec?travaux=CLÉ`). C'est vous qui donnez la clé ; il n'a rien à vous transmettre. Ce n'est pas le mot de passe de la saisie : vous pouvez la changer à tout moment (Générer + Enregistrer) pour couper l'accès.
3. Il envoie une requête **POST** à cette adresse avec `{"appareil":"RMG4","couleur":"orange","message":"graissage"}` (message facultatif). Couleurs : `orange` = maintenance, `rouge` = hors service, `vert` (ou `fin`) = fin de l'avis.
   - Depuis **Notion** : base « Appareils » avec une propriété titre (nom de l'appareil) et une propriété Sélection/Statut « Couleur » (orange / rouge / vert) ; automatisation « Quand Couleur change → Envoyer un webhook » vers l'adresse d'envoi, en cochant ces propriétés.
4. Un **nouvel avis** s'affiche d'abord **en grand sur les écrans pendant 5 secondes** (« Alerte travaux », réglable avec `&alerteTravaux=8` dans l'adresse des écrans, `0` pour désactiver), puis reste en bandeau **Travaux** en bas des écrans (rouge en premier) et dans la saisie (bouton Retirer). Boutons d'essai dans Paramètres. Historique dans l'onglet **Travaux** du classeur.
5. **Créneau** (facultatif) : champ `"creneau"` du message, ou propriété Notion **Créneau** / **Durée** / **Période** (texte, sélection ou date avec heure de début et de fin). Exemples : `Journée`, `Demi-journée matin`, `8h-12h`, `de 13h30 à 17h`, `jusqu'à 16h`. Il s'affiche à côté de la phrase ; avec une heure de fin (ou « Journée » = jusqu'à minuit), l'avis disparaît tout seul à cette heure. Exemple : `{"appareil":"RMG4","couleur":"orange","creneau":"8h-12h"}`.

## Flash info

- Bouton **Flash info** : phrases toutes prêtes (un clic), **complément** ajouté à la suite (ex. « Défaillance des installations de sécurité » + « ADV 5011 »), créneau **De / Jusqu'à** (boutons rapides 6h–13h30, 13h30–21h, 8h–12h, 1 h, 2 h…). Le flash ne passe sur les écrans que pendant le créneau ; « Indiquer le créneau dans le texte » ajoute « — de 8h à 12h ». « Afficher sur les écrans » est coché d'office. Aperçu en bas de la fenêtre.
- La liste des phrases se modifie dans **Paramètres › Écrans et fichiers** (une par ligne).

## Saisie rapide et jours préparés

- Champ **Wagons** : taper `h` écrit aussitôt **HLP**.
- Onglets **Demain / Après-demain** : sans samedi ni dimanche (le vendredi : **Lundi** et **Mardi** ; une préparation faite le vendredi est reprise le lundi). Réglage dans **Paramètres › Exploitation**. Les écrans (Prochaines navettes) et les coupons « demain » suivent.
- Écrans : un groupe dont **toutes les navettes du jour sont faites** passe 1 minute après en petite colonne « ✓ Terminé pour la journée » avec ses navettes cochées en vert (`&fini=30` pour régler le délai en secondes).

## Modifier l'application

- **Pages** (`*.html`, `*.js`, `*.css`) : modifier sur GitHub et valider ; le site est à jour une minute plus tard. Recharger les pages avec Ctrl+F5.
- **Serveur** (`Code.gs`) : après modification dans Apps Script, **Déployer** › **Gérer les déploiements** › crayon › **Version : nouvelle version** › **Déployer**. L'URL `/exec` ne change pas.
- **Tests** : `node tests/test-apps-script.js` teste le serveur sur un simulateur des services Google. `node tests/serveur-simule.js` lance une démonstration locale complète (pages + serveur simulé).

## Limites

- Les deux postes ont besoin d'Internet (github.io et script.google.com).
- Un seul poste de saisie à la fois.
- Données dans le compte Google qui a déployé le script : pour une utilisation définitive, prévoir un compte de l'entreprise.
- Délai saisie → écrans : environ 5 à 10 secondes. Si le poste de saisie s'arrête, les écrans affichent « Liaison interrompue » au bout de 2 minutes et gardent les dernières données.
