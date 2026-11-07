/**
 * Suivi des circulations - serveur Google Apps Script (version GitHub Pages).
 *
 * Remplace le service local du poste de saisie : il garde les journées, le planning et les paramètres
 * dans un dossier Google Drive, tient un registre (Google Sheets : journal, mails, statistiques)
 * et transmet aux écrans les seules données autorisées à l'affichage.
 *
 * Installation : voir README.md (section « Créer le serveur Google »).
 *   1. Remplacer la valeur de CLE ci-dessous par un mot de passe de votre choix.
 *   2. Déployer > Nouveau déploiement > Application Web, exécuter en tant que « Moi »,
 *      accès « Tout le monde ». Copier l'URL qui se termine par /exec.
 *
 * Sécurité : toutes les opérations exigent la CLE, sauf la lecture du fichier diffusé aux écrans
 * (horaires, voies, wagons, flash info), qui ne contient aucune donnée interne.
 */

const CLE = 'CHANGER-CE-MOT-DE-PASSE';
const VERSION = '2.6.0';
const FUSEAU = 'Europe/Paris';
const NOM_DOSSIER = 'Suivi des circulations - données';

// ------------------------------------------------------------------- entrées HTTP
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'diffusion') { const d = lireDiffusion_(); try { d.travaux = listeTravaux_(); } catch (err) { d.travaux = []; } return json_(d); }
  if (action === 'sante') return json_({ service: 'ok', version: VERSION, maintenant: maintenant_() });
  return ContentService.createTextOutput('Suivi des circulations : serveur en service (version ' + VERSION + ').');
}

function doPost(e) {
  // avis de travaux envoyé par un autre service : ?travaux=<clé d'envoi> (voir plus bas)
  if (e && e.parameter && e.parameter.travaux != null) {
    try { return json_(recevoirTravaux_(e)); } catch (err) { return json_({ ok: false, erreur: String(err && err.message || err) }); }
  }
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ status: 400, data: { erreur: 'requête illisible' } }); }
  if (CLE === 'CHANGER-CE-MOT-DE-PASSE') return json_({ status: 403, data: { erreur: 'Choisissez une clé dans Code.gs (constante CLE) puis redéployez.' } });
  if (req.cle !== CLE) return json_({ status: 403, data: { erreur: 'clé refusée' } });
  try {
    return json_(router_(String(req.methode || 'GET').toUpperCase(), String(req.chemin || ''), req.corps == null ? '' : String(req.corps)));
  } catch (err) {
    return json_({ status: 500, data: { erreur: String(err && err.message || err) } });
  }
}

function router_(m, c, corps) {
  let r;
  if (m === 'GET' && c === '/api/sante') return ok_(sante_());
  if (m === 'GET' && c === '/api/config') return ok_({ parametres: lireJson_('parametres.json', {}), planning: lireJson_('planning.json', { schema: 1, groupes: [], circulations: [] }), service: { version: VERSION, mode: 'google' } });
  if (m === 'PUT' && (c === '/api/parametres' || c === '/api/planning')) return ecrireConfig_(c === '/api/parametres' ? 'parametres.json' : 'planning.json', corps);
  if (m === 'GET' && c === '/api/journees') return ok_({ dates: listeJournees_() });
  if ((r = /^\/api\/journee\/(\d{4}-\d{2}-\d{2})$/.exec(c))) {
    if (m === 'GET') return lireJournee_(r[1]);
    if (m === 'PUT') return avecVerrou_(() => ecrireJournee_(r[1], corps));
  }
  if (m === 'POST' && c === '/api/diffusion') return avecVerrou_(() => publierSiAJour_(corps));
  if (m === 'POST' && c === '/api/battement') return ok_({ battement: battre_() });
  if (m === 'POST' && c === '/api/mail') return avecVerrou_(() => mail_(JSON.parse(corps)));
  if (m === 'POST' && c === '/api/archives') return avecVerrou_(() => archives_(JSON.parse(corps)));
  if (m === 'POST' && c === '/api/suivi-trains') { const b = JSON.parse(corps || '{}'); return suiviTrains_(b.date, b.demain); }
  if (m === 'GET' && c === '/api/travaux') return ok_({ liste: listeTravaux_() });
  if (m === 'POST' && c === '/api/travaux') { const res = appliquerAvisTravaux_(JSON.parse(corps || '{}'), 'saisie'); return res.ok ? ok_(Object.assign(res, { liste: listeTravaux_() })) : { status: 400, data: { erreur: res.erreur } }; }
  return { status: 404, data: { erreur: 'route inconnue : ' + m + ' ' + c } };
}

// ------------------------------------------------------------------ Suivi trains
/**
 * Lignes du jour du classeur de l'application « Suivi trains » (Paramètres › suiviTrains.classeur) :
 * onglet Navettes (Date | Type | Code | Libellé | Heure théorique | Heure réelle…) et onglet Journal
 * (Date | Train | Étape | Heure théorique | Heure réelle…). Lecture seule, gardée 3 s en cache
 * (moins que les 10 s entre deux lectures de la saisie : un seul poste lit toujours des données fraîches).
 * Le classeur doit appartenir au compte qui a déployé ce serveur (ou lui être partagé).
 */
function suiviTrains_(date, jourDemain) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { status: 400, data: { erreur: 'date invalide' } };
  const id = idClasseur_((lireJson_('parametres.json', {}).suiviTrains || {}).classeur);
  if (!id) return { status: 400, data: { erreur: 'adresse du classeur Suivi trains absente ou invalide (Paramètres)' } };
  // « demain » = prochain jour préparé dans la saisie (le vendredi : lundi), sinon le lendemain
  const demain = /^\d{4}-\d{2}-\d{2}$/.test(String(jourDemain || '')) ? String(jourDemain) : Utilities.formatDate(new Date(new Date(date + 'T12:00:00').getTime() + 864e5), FUSEAU, 'yyyy-MM-dd');
  const cache = CacheService.getScriptCache(), cle = 'suivi:' + id + ':' + date + ':' + demain, vu = cache.get(cle);
  if (vu) return ok_(JSON.parse(vu));
  let ss;
  try { ss = SpreadsheetApp.openById(id); }
  catch (e) { return { status: 502, data: { erreur: 'classeur Suivi trains inaccessible : vérifiez l\'adresse et que ce compte Google peut l\'ouvrir' } }; }
  const out = { date: date, lu: maintenant_(), navettes: [], journal: [], coupons: [], couponsDemain: [] };
  // colonnes Voie (I) et Wagons (J) : lignes « Info… » (voie et wagons saisis dans le Suivi trains)
  lignesDuJour_(ss.getSheetByName('Navettes'), date).forEach(r => out.navettes.push({ type: r[1], code: r[2], libelle: r[3], theo: r[4], reel: r[5], voie: r[8] || '', wagons: r[9] || '' }));
  lignesDuJour_(ss.getSheetByName('Journal'), date).forEach(r => out.journal.push({ train: r[1], etape: r[2], theo: r[3], reel: r[4] }));
  // coupons navettes saisis dans le Suivi trains (onglet Coupons) : la journée et le lendemain
  const coupon = r => ({ navette: r[1], ligne: r[2], numero: r[3], site: r[4], dateCoupon: r[5], wagons: r[6], note: r[7] });
  out.dateDemain = demain;
  lignesDuJour_(ss.getSheetByName('Coupons'), date).forEach(r => out.coupons.push(coupon(r)));
  lignesDuJour_(ss.getSheetByName('Coupons'), demain).forEach(r => out.couponsDemain.push(coupon(r)));
  cache.put(cle, JSON.stringify(out), 3);
  return ok_(out);
}
/** Identifiant d'un classeur à partir de son adresse (…/spreadsheets/d/<id>/edit) ou de l'identifiant seul. */
function idClasseur_(adresse) {
  const s = String(adresse || '').trim(), m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  return m ? m[1] : (/^[A-Za-z0-9_-]{20,}$/.test(s) ? s : '');
}
/** Lignes dont la date (texte 2026-10-25 ou date affichée 25/10/2026) est celle demandée, en texte affiché. */
function lignesDuJour_(feuille, date) {
  if (!feuille) return [];
  return feuille.getDataRange().getDisplayValues().slice(1).filter(r => {
    const d = String(r[0] || '').trim(), fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
    return (fr ? fr[3] + '-' + ('0' + fr[2]).slice(-2) + '-' + ('0' + fr[1]).slice(-2) : d.slice(0, 10)) === date;
  }).map(r => r.map(v => String(v == null ? '' : v).trim()));
}

// ------------------------------------------------------------------- travaux (envoi externe)
/**
 * Avis de travaux envoyés par un autre service (ex. automatisation Notion « Envoyer un webhook ») :
 *   POST <adresse /exec>?travaux=<clé d'envoi>   corps JSON :
 *     { "appareil": "RMG4", "couleur": "orange", "message": "…facultatif…" }
 *   ou le corps envoyé tel quel par Notion (propriétés de la page : un titre ou texte « Appareil », un select ou
 *   statut dont la couleur Notion dit l'état : orange / jaune = maintenance, rouge = hors service, vert / gris = fini).
 * Couleurs : orange → « en cours de maintenance », rouge → « hors service », vert (ou « fin », « ok ») → l'avis disparaît.
 * Créneau facultatif ("creneau" ou propriété Notion « Créneau » / « Durée » / « Période ») : « Journée », « Demi-journée »,
 * « 8h-12h », « 13h30 à 17h »… affiché après la phrase ; avec une heure de fin (ou « Journée »), l'avis disparaît seul.
 * La clé d'envoi (Paramètres › Travaux de la saisie) est différente de la CLE de la saisie : elle ne permet que ça.
 * Les avis en cours sont joints aux données des écrans (bandeau « Travaux ») et visibles dans la saisie.
 */
const COULEURS_TRAVAUX = { orange: 'orange', jaune: 'orange', yellow: 'orange', ambre: 'orange', maintenance: 'orange',
  rouge: 'rouge', red: 'rouge', hs: 'rouge', 'hors service': 'rouge', panne: 'rouge',
  vert: 'fin', green: 'fin', fin: 'fin', ok: 'fin', gris: 'fin', gray: 'fin', default: 'fin', termine: 'fin', 'en service': 'fin' };
const PHRASES_TRAVAUX = { orange: '{appareil} est actuellement en cours de maintenance.', rouge: '{appareil} est hors service pour le moment.' };
const APPAREILS_TRAVAUX = [
  { code: 'RMG3', libelle: 'Le portique RMG3' }, { code: 'RMG4', libelle: 'Le portique RMG4' },
  { code: 'PF1', libelle: 'Le portique fluvial 1', alias: 'portique fluvial 1' }, { code: 'PF2', libelle: 'Le portique fluvial 2', alias: 'portique fluvial 2' },
  { code: 'PPMA', libelle: 'La PPM A', alias: 'PPM A' }, { code: 'PPMB', libelle: 'La PPM B', alias: 'PPM B' }, { code: 'PPMC', libelle: 'La PPM C', alias: 'PPM C' }
];
function cleTravaux_(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function configTravaux_() {
  const t = (lireJson_('parametres.json', {}).travaux) || {};
  return { jeton: t.jeton || '', appareils: t.appareils && t.appareils.length ? t.appareils : APPAREILS_TRAVAUX, phrases: Object.assign({}, PHRASES_TRAVAUX, t.phrases || {}) };
}
function trouverAppareil_(cfg, nom) {
  const k = cleTravaux_(nom);
  if (!k) return null;
  return cfg.appareils.filter(a => [a.code, a.libelle].concat(String(a.alias || '').split(/[,;]+/)).some(x => cleTravaux_(x) && (cleTravaux_(x) === k || cleTravaux_(x).replace(/^(le|la|les)/, '') === k)))[0] || null;
}
/** Texte d'une propriété Notion (titre, texte, select, statut, multi-select, formule). */
function texteNotion_(p) {
  if (!p) return '';
  const r = p.title || p.rich_text;
  if (r) return r.map(x => x.plain_text || (x.text && x.text.content) || '').join('').trim();
  if (p.select) return p.select.name || '';
  if (p.status) return p.status.name || '';
  if (p.multi_select) return p.multi_select.map(x => x.name).join(', ');
  if (p.formula) return String(p.formula.string || p.formula.number || '');
  return '';
}
/** { appareil, couleur, message } depuis un corps simple ou un webhook Notion. */
function lireAvisTravaux_(corps) {
  const props = (corps && corps.data && corps.data.properties) || (corps && corps.properties) || null;
  if (!props) {
    return { appareil: corps.appareil || corps.equipement || corps.engin || corps.nom || corps.name || '', couleur: corps.couleur || corps.color || corps.etat || corps.statut || '', message: corps.message || corps.texte || corps.text || '',
      creneau: corps.creneau || corps['créneau'] || corps.duree || corps['durée'] || corps.periode || corps['période'] || corps.horaire || corps.horaires || '' };
  }
  let appareil = '', couleur = '', message = '', creneau = '';
  Object.keys(props).forEach(nom => {
    const p = props[nom], n = cleTravaux_(nom);
    if (/appareil|engin|equipement|portique|machine/.test(n) && !appareil) appareil = texteNotion_(p);
    else if (/couleur|color/.test(n)) couleur = texteNotion_(p) || couleur;
    else if (/message|commentaire|detail|description|texte/.test(n)) message = texteNotion_(p);
    else if (/creneau|duree|periode|horaire|plage|quand/.test(n)) creneau = texteNotion_(p) || (p && p.date && p.date.start ? creneauDate_(p.date) : '');
    const choix = p && (p.select || p.status);
    if (choix && choix.color && !couleur && /etat|statut|status|state|niveau|couleur/.test(n)) couleur = choix.color;
  });
  if (!appareil) Object.keys(props).forEach(nom => { if (!appareil && props[nom] && props[nom].type === 'title') appareil = texteNotion_(props[nom]); });
  return { appareil: appareil, couleur: couleur, message: message, creneau: creneau };
}
/** Propriété Notion « Date » avec début et fin → « 8h00-12h00 ». */
function creneauDate_(d) {
  const h = s => { const m = /T(\d\d):(\d\d)/.exec(s || ''); return m ? (+m[1]) + 'h' + m[2] : ''; };
  return [h(d.start), h(d.end)].filter(String).join('-') || 'Journée';
}
/**
 * Créneau lisible et fin automatique : « journée » → minuit ; « 8h-12h », « de 8h30 à 12h », « 08:00-12:00 » → 8h-12h,
 * fin à 12:00 (le jour de l'envoi) ; « demi-journée » (sans heure) → pas de fin automatique. Renvoie { texte, fin }.
 */
function lireCreneau_(brut, maintenant) {
  const s = String(brut || '').trim().slice(0, 60);
  if (!s) return { texte: '', fin: '' };
  const jour = String(maintenant || maintenant_()).slice(0, 10), n = cleTravaux_(s);
  const heures = [];
  s.replace(/(\d{1,2})\s*(?:h|:)\s*(\d{2})?|(\d{1,2})\s*(?=-|à|a\b)/gi, (m, a, b, c) => { const h = +(a || c); if (h <= 24) heures.push([h, +(b || 0)]); return m; });
  const fmt = x => x[0] + 'h' + (x[1] ? ('0' + x[1]).slice(-2) : '');
  const lendemain = new Date(new Date(jour + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
  // fin déjà passée (créneau de nuit 22h-6h, ou envoyé pour le lendemain) : le lendemain
  const iso = x => { const f = jour + 'T' + ('0' + Math.min(23, x[0])).slice(-2) + ':' + (x[0] >= 24 ? '59' : ('0' + x[1]).slice(-2)) + ':00'; return f <= String(maintenant || '') ? lendemain + f.slice(10) : f; };
  if (heures.length >= 2) return { texte: fmt(heures[0]) + '-' + fmt(heures[1]), fin: iso(heures[1]) };
  if (heures.length === 1 && /jusqu|fin|avant/.test(n)) return { texte: 'jusqu\'à ' + fmt(heures[0]), fin: iso(heures[0]) };
  if (/demi/.test(n)) return { texte: /apres|aprem|pm/.test(n) ? 'demi-journée (après-midi)' : (/matin|am\b/.test(n) ? 'demi-journée (matin)' : 'demi-journée'), fin: '' };
  if (/journee|jour|day/.test(n)) return { texte: 'toute la journée', fin: jour + 'T23:59:00' };
  return { texte: s, fin: '' };
}
function lireTravaux_() {
  const cache = CacheService.getScriptCache(), t = cache.get('travaux');
  if (t) return JSON.parse(t);
  const etat = lireJson_('travaux.json', {});
  cache.put('travaux', JSON.stringify(etat), 21600);
  return etat;
}
function ecrireTravaux_(etat) {
  ecrireTexte_('travaux.json', JSON.stringify(etat));
  CacheService.getScriptCache().put('travaux', JSON.stringify(etat), 21600);
}
/** Liste affichable des avis en cours (rouge d'abord), phrase construite avec les réglages. */
function listeTravaux_() {
  const etat = lireTravaux_(), cfg = configTravaux_();
  const maint = maintenant_();
  return Object.keys(etat).filter(k => !etat[k].fin || etat[k].fin > maint).map(k => {
    const a = etat[k], phrase = String(cfg.phrases[a.couleur] || PHRASES_TRAVAUX[a.couleur] || '{appareil}').replace(/\{appareil\}/g, a.libelle || a.code);
    return { code: a.code, libelle: a.libelle, couleur: a.couleur, texte: phrase.charAt(0).toUpperCase() + phrase.slice(1), message: a.message || '', creneau: a.creneau || '', fin: a.fin || '', depuis: a.depuis, a: a.a };
  }).sort((x, y) => (x.couleur === y.couleur ? String(x.code).localeCompare(String(y.code)) : (x.couleur === 'rouge' ? -1 : 1)));
}
/** Applique un avis : { appareil, couleur, message }. Renvoie { ok, … }. */
function appliquerAvisTravaux_(avis, source) {
  const cfg = configTravaux_();
  const app = trouverAppareil_(cfg, avis.appareil);
  const nom = String(avis.appareil || '').trim();
  if (!nom) return { ok: false, erreur: 'appareil manquant' };
  const couleur = COULEURS_TRAVAUX[cleTravaux_(avis.couleur)] || COULEURS_TRAVAUX[String(avis.couleur || '').toLowerCase().trim()] || '';
  if (!couleur) return { ok: false, erreur: 'couleur inconnue : ' + avis.couleur + ' (orange, rouge ou vert)' };
  const code = app ? app.code : nom.toUpperCase();
  return avecVerrou_(() => {
    const etat = lireTravaux_();
    const cr = lireCreneau_(avis.creneau, maintenant_());
    // un avis échu (fin dépassée) repart de zéro
    const prec = etat[code] && (!etat[code].fin || etat[code].fin > maintenant_()) ? etat[code] : null;
    if (couleur === 'fin') delete etat[code];
    else etat[code] = { code: code, libelle: app ? app.libelle : nom, couleur: couleur, message: String(avis.message || '').slice(0, 200),
      creneau: cr.texte, fin: cr.fin,
      depuis: (prec && prec.couleur === couleur && prec.depuis) || maintenant_(), a: maintenant_(), source: source || '' };
    // ménage : avis échus
    Object.keys(etat).forEach(k => { if (etat[k].fin && etat[k].fin <= maintenant_()) delete etat[k]; });
    ecrireTravaux_(etat);
    try { feuille_('Travaux', ['Horodatage', 'Appareil', 'État', 'Message', 'Source', 'Créneau']).appendRow([maintenant_(), code, couleur, String(avis.message || ''), source || '', String(avis.creneau || '')]); } catch (e) { /* registre facultatif */ }
    return { status: 200, data: { ok: true, appareil: code, etat: couleur, connu: !!app } };
  }).data;
}
function recevoirTravaux_(e) {
  const cfg = configTravaux_();
  if (!cfg.jeton) return { ok: false, erreur: 'réception des travaux désactivée (aucune clé d\'envoi dans Paramètres › Travaux)' };
  if (String(e.parameter.travaux || '') !== cfg.jeton) return { ok: false, erreur: 'clé d\'envoi refusée' };
  let corps = {};
  try { corps = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { corps = {}; }
  if (!corps || typeof corps !== 'object') corps = {};
  ['appareil', 'couleur', 'message', 'creneau'].forEach(k => { if (e.parameter[k] && !corps[k]) corps[k] = e.parameter[k]; });
  return appliquerAvisTravaux_(lireAvisTravaux_(corps), corps.data ? 'notion' : 'externe');
}

// --------------------------------------------------------------------- outils
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function ok_(data) { return { status: 200, data: data }; }
function maintenant_() { return Utilities.formatDate(new Date(), FUSEAU, "yyyy-MM-dd'T'HH:mm:ss"); }
function proprietes_() { return PropertiesService.getScriptProperties(); }
function avecVerrou_(fn) {
  const verrou = LockService.getScriptLock();
  verrou.waitLock(20000);
  try { return fn(); } finally { verrou.releaseLock(); }
}

// ------------------------------------------------------------ dossier et fichiers
function dossier_(sousDossier) {
  const p = proprietes_();
  let id = p.getProperty('DOSSIER_ID'), racine = null;
  if (id) { try { racine = DriveApp.getFolderById(id); } catch (e) { racine = null; } }
  if (!racine) { racine = DriveApp.createFolder(NOM_DOSSIER); p.setProperty('DOSSIER_ID', racine.getId()); }
  if (!sousDossier) return racine;
  let d = racine;
  sousDossier.split('/').forEach(nom => {
    const it = d.getFoldersByName(nom);
    d = it.hasNext() ? it.next() : d.createFolder(nom);
  });
  return d;
}
function fichier_(dossier, nom) {
  const it = dossier.getFilesByName(nom);
  return it.hasNext() ? it.next() : null;
}
function lireTexte_(nom, sousDossier) {
  const f = fichier_(dossier_(sousDossier), nom);
  return f ? f.getBlob().getDataAsString('UTF-8') : null;
}
function ecrireTexte_(nom, texte, sousDossier, type) {
  const d = dossier_(sousDossier), f = fichier_(d, nom);
  if (f) f.setContent(texte);
  else d.createFile(nom, texte, type || 'application/json');
}
function lireJson_(nom, defaut, sousDossier) {
  const t = lireTexte_(nom, sousDossier);
  if (!t) return defaut;
  return JSON.parse(t);
}

// ------------------------------------------------------------------- registre
function registre_() {
  const p = proprietes_();
  let id = p.getProperty('REGISTRE_ID'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Suivi des circulations - registre');
    DriveApp.getFileById(ss.getId()).moveTo(dossier_());
    p.setProperty('REGISTRE_ID', ss.getId());
  }
  return ss;
}
function feuille_(nom, entete) {
  const ss = registre_();
  let f = ss.getSheetByName(nom);
  if (!f) {
    f = ss.insertSheet(nom);
    f.appendRow(entete);
    f.setFrozenRows(1);
  }
  return f;
}

// ------------------------------------------------------------------ configuration
function ecrireConfig_(nom, corps) {
  try { JSON.parse(corps); } catch (e) { return { status: 400, data: { erreur: 'JSON invalide : ' + e.message } }; }
  const ancien = lireTexte_(nom);
  if (ancien) ecrireTexte_(nom + '.precedent', ancien);
  ecrireTexte_(nom, corps);
  return ok_({ ok: true });
}

// ----------------------------------------------------------------------- journées
function versionJournee_(date) { return Number(proprietes_().getProperty('version:' + date) || 0); }
function listeJournees_() {
  const it = dossier_('journees').getFiles(), dates = [];
  while (it.hasNext()) { const n = it.next().getName(); if (/^\d{4}-\d{2}-\d{2}\.json$/.test(n)) dates.push(n.slice(0, 10)); }
  return dates.sort();
}
function lireJournee_(date) {
  const t = lireTexte_(date + '.json', 'journees');
  if (!t) return { status: 404, data: { erreur: 'journée absente' } };
  return ok_({ version: versionJournee_(date), journee: JSON.parse(t) });
}
function ecrireJournee_(date, corps) {
  const i1 = corps.indexOf('\n');
  if (i1 < 0) return { status: 400, data: { erreur: 'format attendu : meta, etat, diffusion' } };
  let i2 = corps.indexOf('\n', i1 + 1);
  if (i2 < 0) i2 = corps.length;
  const meta = JSON.parse(corps.slice(0, i1));
  const etat = corps.slice(i1 + 1, i2).trim();
  const diffusion = i2 < corps.length ? corps.slice(i2 + 1).trim() : '';
  if (etat.charAt(0) !== '{') return { status: 400, data: { erreur: 'état invalide' } };
  const courante = versionJournee_(date);
  if (Number(meta.baseVersion) !== courante) return { status: 409, data: { erreur: 'conflit', version: courante } };
  const nouvelle = courante + 1;
  ecrireTexte_(date + '.json', etat, 'journees');
  proprietes_().setProperty('version:' + date, String(nouvelle));
  try {
    const evt = meta.evenement || {};
    feuille_('Journal', ['Horodatage', 'Journée', 'Version', 'Type', 'Résumé']).appendRow([maintenant_(), date, nouvelle, evt.type || '', evt.resume || (evt.liste ? evt.liste.length + ' modifications' : '')]);
  } catch (e) { /* le registre est facultatif */ }
  if (diffusion.charAt(0) === '{') publierDiffusion_(diffusion);
  return ok_({ version: nouvelle, diffusion: etatDiffusion_() });
}

// ---------------------------------------------------------------------- diffusion
function publierDiffusion_(texte) {
  if (String(texte).charAt(0) !== '{') throw new Error('diffusion invalide');
  const cache = CacheService.getScriptCache();
  const meta = { battement: Number(cache.get('battement') || 0) + 1, ecritA: maintenant_() };
  cache.putAll({ diffusion: texte, battement: String(meta.battement), ecritA: meta.ecritA }, 21600);
  ecrireTexte_('diffusion.json', texte);
  proprietes_().setProperty('DIFFUSION_A', meta.ecritA);
}
/**
 * Publication seule (toutes les minutes depuis la saisie) : refusée si elle vient d'une fenêtre restée sur une version
 * plus ancienne de la journée. Sinon cette fenêtre remettrait aux écrans (et au Suivi trains) une navette « pas partie ».
 */
function publierSiAJour_(corps) {
  const d = JSON.parse(corps);
  const courante = d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? versionJournee_(d.date) : 0;
  if (d && d.version != null && Number(d.version) < courante) return { status: 409, data: { erreur: 'journée modifiée depuis une autre fenêtre', version: courante } };
  publierDiffusion_(corps);
  return ok_({ diffusion: etatDiffusion_() });
}
function battre_() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('battement') || 0) + 1;
  cache.putAll({ battement: String(n), ecritA: maintenant_() }, 21600);
  if (!cache.get('diffusion')) { const t = lireTexte_('diffusion.json'); if (t) cache.put('diffusion', t, 21600); }
  return n;
}
function lireDiffusion_() {
  const cache = CacheService.getScriptCache();
  let texte = cache.get('diffusion');
  if (!texte) { texte = lireTexte_('diffusion.json'); if (texte) cache.put('diffusion', texte, 21600); }
  return {
    diffusion: texte ? JSON.parse(texte) : null,
    meta: { battement: Number(cache.get('battement') || 0), ecritA: cache.get('ecritA') || proprietes_().getProperty('DIFFUSION_A') || '' }
  };
}
function etatDiffusion_() {
  return [{ dossier: 'Écrans (serveur Google)', ok: true, a: proprietes_().getProperty('DIFFUSION_A') || '', erreur: null }];
}
function sante_() {
  const params = lireJson_('parametres.json', {});
  return {
    service: 'ok', version: VERSION, mode: 'google', maintenant: maintenant_(),
    battement: Number(CacheService.getScriptCache().get('battement') || 0),
    diffusion: etatDiffusion_(), sauvegarde: { ok: true, a: '', erreur: null },
    mails: { mode: (params.mails && params.mails.mode) || 'simulation', signature: false }
  };
}

// --------------------------------------------------------------------------- mails
function mail_(m) {
  const id = String(m.id || '');
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(id)) return { status: 400, data: { erreur: 'identifiant de mail invalide' } };
  if (['simulation', 'brouillon', 'auto'].indexOf(m.mode) < 0) return { status: 400, data: { erreur: 'mode inconnu : ' + m.mode } };
  const to = (m.to || []).filter(String);
  if (!to.length) return { status: 400, data: { erreur: 'aucun destinataire' } };
  const cle = 'mails:' + id.slice(0, 10), p = proprietes_();
  const deja = JSON.parse(p.getProperty(cle) || '[]');
  if (deja.indexOf(id) >= 0) return ok_({ statut: 'deja', id: id });
  const html = String(m.html || '').replace('<!--signature-->', '');
  let statut = 'simule';
  if (m.mode === 'auto') {
    MailApp.sendEmail({ to: to.join(','), cc: (m.cc || []).join(','), bcc: (m.bcc || []).join(','), subject: String(m.sujet || ''), htmlBody: html });
    statut = 'envoye';
  } else if (m.mode === 'brouillon') {
    GmailApp.createDraft(to.join(','), String(m.sujet || ''), '', { cc: (m.cc || []).join(','), bcc: (m.bcc || []).join(','), htmlBody: html });
    statut = 'brouillon';
  }
  deja.push(id);
  p.setProperty(cle, JSON.stringify(deja));
  try {
    feuille_('Mails', ['Horodatage', 'Identifiant', 'Statut', 'Objet', 'À', 'Cc', 'Cci']).appendRow([maintenant_(), id, statut, m.sujet || '', to.join('; '), (m.cc || []).join('; '), (m.bcc || []).join('; ')]);
  } catch (e) { /* le registre est facultatif */ }
  return ok_({ statut: statut, id: id, a: maintenant_() });
}

// ------------------------------------------------------------------------ archives
function archives_(a) {
  const date = String(a.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: 400, data: { erreur: 'date invalide' } };
  const sous = 'archives/' + date.slice(0, 4), ecrits = [];
  for (const f of (a.fichiers || [])) {
    const nom = String(f.nom || '');
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(nom)) return { status: 400, data: { erreur: 'nom de fichier invalide : ' + nom } };
    ecrireTexte_(nom, (/\.csv$/.test(nom) ? '﻿' : '') + String(f.contenu || ''), sous, /\.csv$/.test(nom) ? 'text/csv' : 'application/json');
    ecrits.push(nom);
  }
  const j = lireTexte_(date + '.json', 'journees');
  if (j) { ecrireTexte_(date + '_journee.json', j, sous); ecrits.push(date + '_journee.json'); }
  if (a.statistiques) {
    const entete = String(a.statistiques.entete).split(';'), ligne = String(a.statistiques.ligne).split(';');
    const f = feuille_('Statistiques', entete), valeurs = f.getDataRange().getValues();
    // colonnes ajoutées en fin d'en-tête (ex. manœuvres NRS) : la première ligne du registre est complétée
    if ((valeurs[0] || []).filter(String).length < entete.length) f.getRange(1, 1, 1, entete.length).setValues([entete]);
    let rang = -1;
    for (let i = 1; i < valeurs.length; i++) {
      const v = valeurs[i][0], d = v instanceof Date ? Utilities.formatDate(v, FUSEAU, 'yyyy-MM-dd') : String(v);
      if (d === date) { rang = i + 1; break; }
    }
    if (rang > 0) f.getRange(rang, 1, 1, ligne.length).setValues([ligne]);
    else f.appendRow(ligne);
    ecrits.push('Statistiques (registre)');
  }
  return ok_({ dossier: 'Google Drive › ' + NOM_DOSSIER + ' › ' + sous, fichiers: ecrits });
}
