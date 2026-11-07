/*
 * Tests du serveur Google Apps Script (apps-script/Code.gs) sur le simulateur des services Google.
 * Lancement : node tests/test-apps-script.js
 */
'use strict';
var assert = require('assert');
var simulateur = require('./simulateur-apps-script.js');

var reussis = 0, echecs = 0;
function test(nom, fn) {
  try { fn(); reussis++; console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.log('  ÉCHEC ' + nom + '\n        ' + (e && e.stack || e)); }
}
function corpsJournee(base, etat, diffusion) {
  return JSON.stringify({ baseVersion: base, evenement: { type: 'test', resume: 'essai' } }) + '\n' + JSON.stringify(etat) + '\n' + (diffusion ? JSON.stringify(diffusion) : '');
}

console.log('Sécurité');
test('clé d\'origine non changée : tout est refusé avec un message clair', function () {
  var g = simulateur.charger(null);
  var r = g.appel('GET', '/api/sante', null, 'CHANGER-CE-MOT-DE-PASSE');
  assert.strictEqual(r.status, 403); assert.ok(/Choisissez une clé/.test(r.data.erreur));
});
test('mauvaise clé refusée, requête illisible refusée', function () {
  var g = simulateur.charger('secret-essai');
  assert.strictEqual(g.appel('GET', '/api/sante', null, 'autre').status, 403);
  assert.strictEqual(JSON.parse(g.doPost('pas du json').getContent()).status, 400);
});
test('lecture publique limitée à la diffusion et à l\'état du service', function () {
  var g = simulateur.charger('secret-essai');
  assert.ok(/en service/.test(g.doGet({}).getContent()));
  assert.strictEqual(JSON.parse(g.doGet({ action: 'sante' }).getContent()).service, 'ok');
  assert.deepStrictEqual(JSON.parse(g.doGet({ action: 'diffusion' }).getContent()).diffusion, null);
});

console.log('Configuration et journées');
var G = simulateur.charger('secret-essai');
test('serveur neuf : configuration vide, dossier Drive créé', function () {
  var r = G.appel('GET', '/api/config');
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.data.parametres, {});
  assert.strictEqual(r.data.planning.circulations.length, 0); assert.strictEqual(r.data.service.mode, 'google');
  assert.ok(G.etat.proprietes.DOSSIER_ID);
});
test('import des paramètres et du planning, copie .precedent', function () {
  assert.strictEqual(G.appel('PUT', '/api/parametres', JSON.stringify({ voies: ['vf1'], mails: { mode: 'simulation' } })).status, 200);
  assert.strictEqual(G.appel('PUT', '/api/planning', JSON.stringify({ schema: 1, groupes: [], circulations: [{ id: 'A' }] })).status, 200);
  assert.strictEqual(G.appel('PUT', '/api/parametres', JSON.stringify({ voies: ['vf1', 'vf2'], mails: { mode: 'simulation' } })).status, 200);
  var r = G.appel('GET', '/api/config');
  assert.deepStrictEqual(r.data.parametres.voies, ['vf1', 'vf2']); assert.strictEqual(r.data.planning.circulations.length, 1);
  var noms = Object.keys(G.etat.fichiers).map(function (k) { return G.etat.fichiers[k].nom; });
  assert.ok(noms.indexOf('parametres.json.precedent') >= 0);
  assert.strictEqual(G.appel('PUT', '/api/planning', '{ cassé').status, 400);
});
var etat = { date: '2026-10-22', version: 1, mouvements: [], circulations: [] };
var diffusion = { schema: 1, date: '2026-10-22', navettes: [], trains: [], flash: { texte: 'Essai é à ç' } };
test('journée versionnée : enregistrement, conflit, relecture, liste', function () {
  var r = G.appel('PUT', '/api/journee/2026-10-22', corpsJournee(0, etat, diffusion));
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.version, 1);
  r = G.appel('PUT', '/api/journee/2026-10-22', corpsJournee(0, etat, null));
  assert.strictEqual(r.status, 409); assert.strictEqual(r.data.version, 1);
  etat.version = 2; etat.mouvements.push({ n: 1, num: 'locom' });
  assert.strictEqual(G.appel('PUT', '/api/journee/2026-10-22', corpsJournee(1, etat, null)).data.version, 2);
  r = G.appel('GET', '/api/journee/2026-10-22');
  assert.strictEqual(r.data.version, 2); assert.strictEqual(r.data.journee.mouvements[0].num, 'locom');
  assert.strictEqual(G.appel('GET', '/api/journee/2026-10-23').status, 404);
  assert.deepStrictEqual(G.appel('GET', '/api/journees').data.dates, ['2026-10-22']);
  assert.strictEqual(G.appel('GET', '/api/inconnu').status, 404);
});
test('registre : chaque enregistrement tracé dans l\'onglet Journal', function () {
  var ss = G.etat.classeurs[G.etat.proprietes.REGISTRE_ID];
  assert.strictEqual(ss.feuilles.Journal.lignes.length, 3);
});

console.log('Écrans');
test('diffusion publiée, lisible sans clé, battement croissant', function () {
  var r = JSON.parse(G.doGet({ action: 'diffusion' }).getContent());
  assert.strictEqual(r.diffusion.flash.texte, 'Essai é à ç');
  var b = r.meta.battement;
  G.appel('POST', '/api/battement', '');
  assert.strictEqual(JSON.parse(G.doGet({ action: 'diffusion' }).getContent()).meta.battement, b + 1);
});
test('cache vidé (6 h) : relecture depuis Drive', function () {
  G.viderCache();
  var r = JSON.parse(G.doGet({ action: 'diffusion' }).getContent());
  assert.strictEqual(r.diffusion.date, '2026-10-22');
});
test('publication seule (POST /api/diffusion) sans changer la journée', function () {
  var d2 = JSON.parse(JSON.stringify(diffusion)); d2.flash = null;
  assert.strictEqual(G.appel('POST', '/api/diffusion', JSON.stringify(d2)).status, 200);
  assert.strictEqual(JSON.parse(G.doGet({ action: 'diffusion' }).getContent()).diffusion.flash, null);
  assert.strictEqual(G.appel('POST', '/api/diffusion', 'pas du json').status, 500);
});
test('publication d\'une fenêtre restée sur une ancienne version : refusée, l\'affichage reste à jour', function () {
  var vieille = JSON.parse(JSON.stringify(diffusion)); vieille.version = 1; vieille.flash = { texte: 'ancienne' };
  var r = G.appel('POST', '/api/diffusion', JSON.stringify(vieille));
  assert.strictEqual(r.status, 409); assert.strictEqual(r.data.version, 2);
  assert.strictEqual(JSON.parse(G.doGet({ action: 'diffusion' }).getContent()).diffusion.flash, null);
  vieille.version = 2;
  assert.strictEqual(G.appel('POST', '/api/diffusion', JSON.stringify(vieille)).status, 200);
  assert.strictEqual(JSON.parse(G.doGet({ action: 'diffusion' }).getContent()).diffusion.flash.texte, 'ancienne');
});

console.log('Mails');
var mail = { id: '2026-10-22_TDF-LF1_navetteDepart', mode: 'simulation', to: ['gare@exemple.test'], cc: ['copie@exemple.test'], bcc: [], sujet: 'Départ navette LF1 vers TDF à 7h27', html: '<p>Départ LF1</p><!--signature-->' };
test('simulation : rien n\'est envoyé, trace dans l\'onglet Mails, pas de doublon', function () {
  assert.strictEqual(G.appel('POST', '/api/mail', JSON.stringify(mail)).data.statut, 'simule');
  assert.strictEqual(G.appel('POST', '/api/mail', JSON.stringify(mail)).data.statut, 'deja');
  assert.strictEqual(G.etat.envois.length, 0);
  assert.strictEqual(G.etat.classeurs[G.etat.proprietes.REGISTRE_ID].feuilles.Mails.lignes.length, 2);
});
test('envoi automatique et brouillon Gmail', function () {
  var a = Object.assign({}, mail, { id: '2026-10-22_TN-LN1_navetteDepart', mode: 'auto' });
  assert.strictEqual(G.appel('POST', '/api/mail', JSON.stringify(a)).data.statut, 'envoye');
  assert.strictEqual(G.etat.envois[0].to, 'gare@exemple.test'); assert.ok(G.etat.envois[0].htmlBody.indexOf('signature') < 0);
  var b = Object.assign({}, mail, { id: '2026-10-22_ATL-LA1_navetteDepart', mode: 'brouillon' });
  assert.strictEqual(G.appel('POST', '/api/mail', JSON.stringify(b)).data.statut, 'brouillon');
  assert.strictEqual(G.etat.brouillons.length, 1);
});
test('mails invalides refusés', function () {
  assert.strictEqual(G.appel('POST', '/api/mail', JSON.stringify(Object.assign({}, mail, { id: '../x' }))).status, 400);
  assert.strictEqual(G.appel('POST', '/api/mail', JSON.stringify(Object.assign({}, mail, { id: 'y', mode: 'fusee' }))).status, 400);
  assert.strictEqual(G.appel('POST', '/api/mail', JSON.stringify(Object.assign({}, mail, { id: 'z', to: [] }))).status, 400);
});

console.log('Archives');
test('fichiers CSV avec BOM dans Drive › archives › année, statistiques sans doublon', function () {
  var a = { date: '2026-10-22', fichiers: [{ nom: '2026-10-22_mouvements.csv', contenu: 'n;numero\r\n1;locom\r\n' }], statistiques: { entete: 'date;mouvements', ligne: '2026-10-22;1' } };
  var r = G.appel('POST', '/api/archives', JSON.stringify(a));
  assert.strictEqual(r.status, 200); assert.ok(/archives\/2026/.test(r.data.dossier));
  a.statistiques.ligne = '2026-10-22;2';
  G.appel('POST', '/api/archives', JSON.stringify(a));
  var stats = G.etat.classeurs[G.etat.proprietes.REGISTRE_ID].feuilles.Statistiques.lignes;
  assert.strictEqual(stats.length, 2); assert.strictEqual(stats[1][1], '2');
  // nouvelles colonnes en fin d'en-tête : la première ligne du registre est complétée
  a.statistiques = { entete: 'date;mouvements;nrs_hlp_matin', ligne: '2026-10-22;2;5' };
  G.appel('POST', '/api/archives', JSON.stringify(a));
  assert.strictEqual(stats[0].join(';'), 'date;mouvements;nrs_hlp_matin'); assert.strictEqual(stats.length, 2);
  var csv = Object.keys(G.etat.fichiers).map(function (k) { return G.etat.fichiers[k]; }).filter(function (f) { return f.nom === '2026-10-22_mouvements.csv'; })[0];
  assert.strictEqual(csv.contenu.charCodeAt(0), 0xFEFF);
  assert.strictEqual(G.appel('POST', '/api/archives', JSON.stringify({ date: '2026-10-22', fichiers: [{ nom: '../x.csv', contenu: '' }] })).status, 400);
});

console.log('Suivi trains');
test('lecture des onglets Navettes, Journal et Coupons du jour, adresse vérifiée', function () {
  var g = simulateur.charger('secret-essai');
  g.appel('PUT', '/api/parametres', JSON.stringify({ voies: ['vf1'] }));
  assert.strictEqual(g.appel('POST', '/api/suivi-trains', JSON.stringify({ date: '2026-10-25' })).status, 400);
  var id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', ss = g.creerClasseur('Suivi trains', id);
  var nav = ss.insertSheet('Navettes');
  nav.appendRow(['Date', 'Type', 'Code', 'Libellé', 'Heure théorique', 'Heure réelle', 'Écart (min)', 'Mis à jour le']);
  nav.appendRow(['2026-10-25', 'Navette', 'FL1', 'FL1 (départ)', '', '14:05', '', '']);
  nav.appendRow(['2026-10-25', 'Quickboard', 'LF2', 'LF2', '15:30', '15:34', 4, '']);
  nav.appendRow(['2026-10-24', 'Navette', 'FL1', 'FL1 (départ)', '', '09:00', '', '']);
  var jr = ss.insertSheet('Journal');
  jr.appendRow(['Date', 'Train', 'Étape', 'Heure théorique', 'Heure réelle']);
  jr.appendRow(['2026-10-25', '50238', 'Mise en tête', '16:56', '16:58:12']);
  var cp = ss.insertSheet('Coupons');
  cp.appendRow(['Date', 'Navette', 'Ligne', 'N° coupon', 'Code site', 'Date coupon', 'Wagons', 'Note', 'Mis à jour le']);
  cp.appendRow(['2026-10-25', 'LF1', 1, '02', 'LHTTDF', '2410', 18, '', '']);
  cp.appendRow(['2026-10-25', 'LF1', 2, '07', 'LHTTDF', '2410', 4, '', '']);
  cp.appendRow(['2026-10-26', 'LN1', 1, '11', 'LHTTMS', '2510', 20, '', '']);
  cp.appendRow(['2026-10-24', 'LA1', 1, '01', 'LHTATL', '2310', 9, '', '']);
  g.appel('PUT', '/api/parametres', JSON.stringify({ voies: ['vf1'], suiviTrains: { classeur: 'https://docs.google.com/spreadsheets/d/' + id + '/edit#gid=0' } }));
  var r = g.appel('POST', '/api/suivi-trains', JSON.stringify({ date: '2026-10-25' }));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.navettes.map(function (x) { return x.code + ' ' + x.reel; }), ['FL1 14:05', 'LF2 15:34']);
  assert.deepStrictEqual(r.data.journal, [{ train: '50238', etape: 'Mise en tête', theo: '16:56', reel: '16:58:12' }]);
  // coupons navettes du Suivi trains : la journée et le lendemain
  assert.deepStrictEqual(r.data.coupons.map(function (x) { return x.navette + ' ' + x.numero + ' ' + x.site + ' ' + x.dateCoupon + ' ' + x.wagons; }), ['LF1 02 LHTTDF 2410 18', 'LF1 07 LHTTDF 2410 4']);
  assert.deepStrictEqual(r.data.couponsDemain.map(function (x) { return x.navette + ' ' + x.numero; }), ['LN1 11']);
  g.appel('PUT', '/api/parametres', JSON.stringify({ voies: ['vf1'], suiviTrains: { classeur: 'https://docs.google.com/spreadsheets/d/inconnu0123456789abcdef/edit' } }));
  assert.strictEqual(g.appel('POST', '/api/suivi-trains', JSON.stringify({ date: '2026-10-25' })).status, 502);
  assert.strictEqual(g.appel('POST', '/api/suivi-trains', JSON.stringify({ date: 'hier' })).status, 400);
});

console.log('Travaux (envoi externe)');
test('avis par clé d\'envoi : format simple et webhook Notion, fin, clé refusée', function () {
  var g = simulateur.charger('secret-essai');
  var post = function (cle, corps) { return JSON.parse(g.doPostParams({ travaux: cle }, JSON.stringify(corps)).getContent()); };
  assert.strictEqual(post('x', { appareil: 'RMG4', couleur: 'orange' }).ok, false); // pas encore de clé
  g.appel('PUT', '/api/parametres', JSON.stringify({ voies: ['vf1'], travaux: { jeton: 'jeton-essai-123', phrases: { rouge: '{appareil} est hors service pour le moment.' } } }));
  assert.strictEqual(post('mauvais', { appareil: 'RMG4', couleur: 'orange' }).erreur, 'clé d\'envoi refusée');
  var r = post('jeton-essai-123', { appareil: 'rmg 4', couleur: 'orange' });
  assert.ok(r.ok && r.appareil === 'RMG4' && r.connu);
  // webhook Notion : titre = appareil, statut dont la couleur Notion est rouge
  r = post('jeton-essai-123', { source: { type: 'automation' }, data: { object: 'page', properties: {
    'Appareil': { type: 'title', title: [{ plain_text: 'Portique fluvial 2' }] }, 'Statut': { type: 'status', status: { name: 'Hors service', color: 'red' } },
    'Commentaire': { type: 'rich_text', rich_text: [{ plain_text: 'câble' }] } } } });
  assert.ok(r.ok && r.appareil === 'PF2' && r.etat === 'rouge');
  var d = JSON.parse(g.doGet({ action: 'diffusion' }).getContent());
  assert.deepStrictEqual(d.travaux.map(function (t) { return t.code + ' ' + t.couleur + ' ' + t.texte; }),
    ['PF2 rouge Le portique fluvial 2 est hors service pour le moment.', 'RMG4 orange Le portique RMG4 est actuellement en cours de maintenance.']);
  assert.strictEqual(d.travaux[0].message, 'câble');
  assert.strictEqual(post('jeton-essai-123', { appareil: 'RMG4', couleur: 'vert' }).etat, 'fin');
  assert.strictEqual(post('jeton-essai-123', { appareil: 'RMG4', couleur: 'violet' }).ok, false);
  var l = g.appel('GET', '/api/travaux');
  assert.deepStrictEqual(l.data.liste.map(function (t) { return t.code; }), ['PF2']);
  assert.strictEqual(g.appel('POST', '/api/travaux', JSON.stringify({ appareil: 'PF2', couleur: 'fin' })).data.liste.length, 0);
  // créneau : texte lisible ; « journée » et heure de fin → fin automatique ; Notion « Créneau »
  r = post('jeton-essai-123', { appareil: 'PPM A', couleur: 'orange', creneau: 'journée' });
  assert.ok(r.ok && r.appareil === 'PPMA');
  r = post('jeton-essai-123', { data: { properties: { 'Appareil': { type: 'title', title: [{ plain_text: 'RMG3' }] },
    'Couleur': { type: 'select', select: { name: 'Rouge', color: 'red' } }, 'Créneau': { type: 'select', select: { name: 'Demi-journée matin' } } } } });
  assert.ok(r.ok && r.appareil === 'RMG3' && r.etat === 'rouge');
  var lc = g.appel('GET', '/api/travaux').data.liste;
  assert.deepStrictEqual(lc.map(function (t) { return t.code + ' ' + t.creneau; }), ['RMG3 demi-journée (matin)', 'PPMA toute la journée']);
  assert.ok(/T23:59:00$/.test(lc[1].fin) && !lc[0].fin);
});

console.log('Jours préparés (samedi / dimanche)');
test('le vendredi, Demain = lundi et Après-demain = mardi ; préparations reprises', function () {
  var SC = require('../commun.js');
  var plan = { groupes: [{ id: 'TDF', famille: 'navette' }], circulations: [{ id: 'p1', groupe: 'TDF', code: 'LF1', sens: 'D', heure: '06:00', jours: [1, 2, 3, 4, 5] }] };
  SC.regler({ sauterWeekend: true });
  var ven = SC.nouvelleJournee(plan, '2026-11-06', null, new Date(2026, 10, 6, 6, 0));
  assert.strictEqual(ven.demain.date, '2026-11-09'); assert.strictEqual(ven.surlendemain.date, '2026-11-10');
  assert.strictEqual(SC.libellePrep('2026-11-09', '2026-11-06'), 'Lundi 9');
  assert.strictEqual(SC.libellePrep('2026-11-06', '2026-11-05'), 'Demain · vendredi');
  ven.demain.circulations[0].wagonsDemandes = 21;
  // samedi (si ouvert) puis lundi : la préparation du vendredi suit
  var sam = SC.nouvelleJournee(plan, '2026-11-07', ven.demain, new Date(), ven.surlendemain);
  assert.strictEqual(sam.demain.date, '2026-11-09'); assert.strictEqual(sam.demain.circulations[0].wagonsDemandes, 21);
  var lun = SC.nouvelleJournee(plan, '2026-11-09', ven.demain, new Date(), ven.surlendemain);
  assert.strictEqual(lun.circulations[0].wagonsDemandes, 21); assert.strictEqual(lun.demain.date, '2026-11-10');
  // ancienne journée (demain = samedi) recalée, réglage désactivé = jours civils
  var j = { date: '2026-11-06', demain: { date: '2026-11-07', circulations: [] }, surlendemain: { date: '2026-11-08', circulations: [] } };
  assert.ok(SC.recalerPreps(j, plan)); assert.strictEqual(j.demain.date, '2026-11-09'); assert.ok(!SC.recalerPreps(j, plan));
  SC.regler({ sauterWeekend: false });
  assert.strictEqual(SC.jourPrep('2026-11-06', 1), '2026-11-07');
  SC.regler({ sauterWeekend: true });
});

console.log('\n' + reussis + ' tests réussis, ' + echecs + ' en échec.');
process.exit(echecs ? 1 : 0);
