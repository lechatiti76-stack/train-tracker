/*
 * Suivi des circulations - logique commune aux modes SAISIE et VISUEL.
 * Aucune dépendance. Utilisable dans le navigateur (window.SC) et sous Node (tests).
 * Les dates sont des chaînes locales "AAAA-MM-JJTHH:MM:SS" (sans fuseau).
 */
(function (racine, fabrique) {
  var SC = fabrique();
  if (typeof module === 'object' && module.exports) module.exports = SC;
  else racine.SC = SC;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  var JOURS_COURTS = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var SCHEMA_DIFFUSION = 1;

  // ------------------------------------------------------------------ dates
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function lireDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  function iso(d) {
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function cleDate(d) { return iso(d).slice(0, 10); }
  function ajouterJours(cle, n) { var d = lireDate(cle); d.setDate(d.getDate() + n); return cleDate(d); }
  /** Lundi = 1 ... dimanche = 7 (comme JOURSEM(...;2) dans Excel). */
  function jourSemaine(cle) { var d = lireDate(cle); return ((d.getDay() + 6) % 7) + 1; }
  /**
   * Jours préparés (« Demain », « Après-demain ») : par défaut sans samedi ni dimanche (le vendredi : lundi et mardi).
   * Réglage Paramètres › Exploitation (sauterWeekend) appliqué par regler().
   */
  var REGLAGES = { sauterWeekend: true };
  function regler(o) { Object.keys(o || {}).forEach(function (k) { REGLAGES[k] = o[k]; }); }
  function jourPrep(cle, n) {
    var d = cle, k = 0;
    while (k < n) { d = ajouterJours(d, 1); if (!REGLAGES.sauterWeekend || jourSemaine(d) <= 5) k++; }
    return d;
  }
  /** « Demain · samedi » si c'est le lendemain, sinon « Lundi 9 ». */
  function libellePrep(date, ref) {
    var nom = JOURS[jourSemaine(date) - 1];
    return date === ajouterJours(ref, 1) ? 'Demain · ' + nom : nom.charAt(0).toUpperCase() + nom.slice(1) + ' ' + lireDate(date).getDate();
  }
  function libelleJour(cle) {
    var d = lireDate(cle);
    return JOURS[jourSemaine(cle) - 1] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()];
  }
  function libelleDateCourte(cle) { var d = lireDate(cle); return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function hm(s) { return s ? String(s).slice(11, 16) : ''; }
  /** Format des mails existants : 9h15. */
  function hhmm(s) { if (!s) return ''; var h = +String(s).slice(11, 13), m = String(s).slice(14, 16); return h + 'h' + m; }
  /** Accepte 915, 9:15, 9h15, 09.15, 9 ; renvoie "HH:MM" ou null. */
  function normHeure(txt) {
    var t = String(txt == null ? '' : txt).trim().toLowerCase().replace(/\s+/g, '');
    if (!t) return null;
    var m = /^(\d{1,2})(?:[:h.](\d{0,2}))?$/.exec(t);
    if (!m && /^\d{3,4}$/.test(t)) m = [t, t.slice(0, t.length - 2), t.slice(-2)];
    if (!m) return null;
    var h = +m[1], mi = m[2] ? +m[2] : 0;
    if (h > 23 || mi > 59 || (m[2] && m[2].length === 1)) return null;
    return p2(h) + ':' + p2(mi);
  }
  function combiner(cle, heure) { var h = normHeure(heure); return h ? cle + 'T' + h + ':00' : null; }
  /** Heure saisie "HH:MM" placée la veille, le jour même ou le lendemain, au plus près de la référence. */
  function heureProche(cle, heure, refIso) {
    var base = combiner(cle, heure);
    if (!base || !refIso) return base;
    var ref = lireDate(refIso).getTime(), best = base, ecartMin = Infinity;
    [-1, 0, 1].forEach(function (k) {
      var c = combiner(ajouterJours(cle, k), heure), e = Math.abs(lireDate(c).getTime() - ref);
      if (e < ecartMin) { ecartMin = e; best = c; }
    });
    return best;
  }
  function minutesEntre(a, b) { return Math.round((lireDate(a).getTime() - lireDate(b).getTime()) / 60000); }
  function fmtEcart(min) {
    if (min == null || isNaN(min)) return '';
    var a = Math.abs(min);
    return (min > 0 ? '+' : (min < 0 ? '−' : '')) + Math.floor(a / 60) + ':' + p2(a % 60);
  }
  function minutesDuJour(heure) { var h = normHeure(heure); return h ? (+h.slice(0, 2)) * 60 + (+h.slice(3, 5)) : null; }

  // ------------------------------------------------------------- utilitaires
  function copie(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function estNumeroTrain(num) { return /^\d{4,}$/.test(norm(num)); }
  function groupeDe(planning, id) {
    var g = (planning && planning.groupes) || [];
    for (var i = 0; i < g.length; i++) if (g[i].id === id) return g[i];
    return null;
  }
  function familleDe(planning, c) { var g = groupeDe(planning, c.groupe); return g ? g.famille : 'ligne'; }

  // --------------------------------------------------------- règles métier
  function normaliserVoie(v, params) {
    var s = norm(v);
    var alias = (params && params.aliasVoies) || {};
    return alias[s] || s;
  }
  function voieConnue(v, params) { return ((params && params.voies) || []).indexOf(normaliserVoie(v, params)) >= 0; }

  /** EF de la base de correspondances (Paramètres), sinon '' . */
  function efDeLaBase(num, params) {
    var s = norm(num), base = (params && params.correspondancesEF) || {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k) && norm(k) === s) return base[k];
    return '';
  }
  /** Base de correspondances d'abord, puis règles reprises de la colonne C du classeur (Nom de l'EF). */
  function deduireEF(num, journee, planning, params) {
    var s = norm(num);
    if (!s) return '';
    var connu = efDeLaBase(s, params);
    if (connu) return connu;
    var internes = (params && params.mouvementsInternes) || {};
    for (var ef in internes) if (Object.prototype.hasOwnProperty.call(internes, ef) && internes[ef].indexOf(s) >= 0) return ef;
    if (/^nrs/.test(s)) return 'NRS';
    if (/^\d+$/.test(s)) {
      if (s.charAt(1) === '0' && '964'.indexOf(s.charAt(2)) >= 0) return 'NRS';
      if (/^(11|51)/.test(s)) return 'NRS';
    }
    var c = journee ? trouverCirculation(journee, s) : null;
    if (c) { var g = groupeDe(planning, c.groupe); if (g && g.ef) return g.ef; }
    return '';
  }
  /** Règles reprises de la colonne G (Provenance / Destination). */
  function deduireZone(num) {
    var s = norm(num);
    if (!/^\d{4,}$/.test(s)) return '';
    var p = s.charAt(2) + s.charAt(3);
    var a = { '49': 'F. Soutien', '94': 'F. Soutien', '19': 'F.A.', '91': 'F.A.', '69': 'Maritime', '96': 'Maritime', '09': 'Soquence', '90': 'Soquence' };
    if (a[p]) return a[p];
    if (s.charAt(1) === '0' || s.charAt(1) === '2') return 'RFN';
    var b = { '79': 'Maprosol', '97': 'Maprosol', '39': 'Chevron', '93': 'Chevron', '89': 'Eramet', '98': 'Eramet', '29': 'TPF', '92': 'TPF' };
    return b[p] || '';
  }
  function deduireTraction(ef, params) {
    if (!ef) return '';
    return ((params && params.efElectriques) || []).indexOf(String(ef).toUpperCase()) >= 0 ? 'Élec.' : 'Th.';
  }

  // ------------------------------------------------------------- planning
  function appliquerVariantes(pc, jour) {
    var r = copie(pc);
    (pc.variantes || []).forEach(function (v) {
      if ((v.jours || []).indexOf(jour) >= 0) {
        ['hlr', 'heure', 'numero', 'sillon', 'wagonsDemandes', 'voiePrevue'].forEach(function (k) { if (v[k] !== undefined) r[k] = v[k]; });
      }
    });
    return r;
  }
  function numerosDe(c) {
    var out = [];
    [c.numero, c.sillon].forEach(function (n) { n = norm(n); if (n && out.indexOf(n) < 0) out.push(n); });
    return out;
  }
  function instancier(pc, cle, planning) {
    var r = appliquerVariantes(pc, jourSemaine(cle));
    return {
      id: r.id, planId: r.id, groupe: r.groupe, code: r.code, sens: r.sens,
      numero: r.numero || '', sillon: r.sillon || '',
      hlr: normHeure(r.hlr) || '', theo: combiner(cle, r.heure),
      wagonsDemandes: r.wagonsDemandes == null || r.wagonsDemandes === '' ? null : +r.wagonsDemandes,
      voiePrevue: r.voiePrevue || '',
      etat: null, reel: null, partie: null, mails: {}, deroule: {}, ajoutee: false
    };
  }
  /** Circulations prévues pour une date, selon les jours de circulation et les variantes. */
  function genererCirculations(planning, cle) {
    var jour = jourSemaine(cle);
    return ((planning && planning.circulations) || [])
      .filter(function (pc) { return (appliquerVariantes(pc, jour).jours || []).indexOf(jour) >= 0; })
      .map(function (pc) { return instancier(pc, cle, planning); });
  }
  /** Préparations de la veille (demain, après-demain) reprises telles quelles quand leur date correspond. */
  function nouvelleJournee(planning, cle, prepVeille, maintenant, prepSurveille) {
    var preps = [prepVeille, prepSurveille];
    var reprise = function (date) {
      var p = preps.filter(function (x) { return x && x.date === date && x.circulations; })[0];
      return p ? copie(p.circulations) : genererCirculations(planning, date);
    };
    var d1 = jourPrep(cle, 1), d2 = jourPrep(cle, 2);
    return {
      schema: 1, date: cle, version: 0, creeA: iso(maintenant || new Date()),
      mouvements: [], circulations: reprise(cle),
      flash: { actif: false, texte: '', jusqua: '' },
      demain: { date: d1, circulations: reprise(d1) },
      surlendemain: { date: d2, circulations: reprise(d2) },
      cloture: null
    };
  }
  /**
   * Remet « Demain » et « Après-demain » sur les bons jours (réglage samedi/dimanche changé, ancienne journée) :
   * une préparation déjà faite pour ce jour est gardée. Renvoie true si quelque chose a changé.
   */
  function recalerPreps(j, planning) {
    var d1 = jourPrep(j.date, 1), d2 = jourPrep(j.date, 2), avant = [j.demain && j.demain.date, j.surlendemain && j.surlendemain.date].join();
    if (avant === d1 + ',' + d2) return false;
    var preps = [j.demain, j.surlendemain];
    var pour = function (date) { return preps.filter(function (x) { return x && x.date === date; })[0] || { date: date, circulations: genererCirculations(planning, date) }; };
    j.demain = pour(d1); j.surlendemain = pour(d2);
    return true;
  }
  /** Préparation d'après-demain, créée depuis le planning pour une journée qui n'en a pas encore. */
  function assurerSurlendemain(j, planning) {
    var d2 = jourPrep(j.date, 2);
    if (!j.surlendemain || j.surlendemain.date !== d2) j.surlendemain = { date: d2, circulations: genererCirculations(planning, d2) };
    return j.surlendemain;
  }

  // ------------------------------------------------- journal et rapprochement
  function mouvementsActifs(j) { return (j.mouvements || []).filter(function (m) { return !m.supprime; }); }
  /** Circulation prévue correspondant à un numéro (n° interne ou sillon). Les circulations déjà réalisées passent après. */
  function trouverCirculation(j, num) {
    var s = norm(num);
    if (!s) return null;
    var cand = (j.circulations || []).filter(function (c) { return numerosDe(c).indexOf(s) >= 0 && c.etat !== 'supprime'; });
    if (!cand.length) return null;
    var libre = cand.filter(function (c) { return !etatCirculation(c, j).reel; });
    return (libre[0] || cand[0]);
  }
  /** Valeurs d'une circulation déduites des mouvements qui lui sont rattachés. */
  function etatCirculation(c, j) {
    var liens = mouvementsActifs(j).filter(function (m) { return m.lien === c.id; })
      .sort(function (a, b) { return a.annonce < b.annonce ? -1 : (a.annonce > b.annonce ? 1 : a.n - b.n); });
    var d = { annonce: liens.length ? liens[0].annonce : null, voie: null, wagons: null, cv: null, reel: c.reel || null, liens: liens.length };
    if (liens.length) d.voie = liens[liens.length - 1].voie || null;
    for (var i = liens.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(String(liens[i].compo || ''))) { d.wagons = +liens[i].compo; d.cv = liens[i].cv || null; break; }
    }
    if (!d.reel) for (var k = 0; k < liens.length; k++) if (liens[k].reel) { d.reel = liens[k].reel; break; }
    return d;
  }
  /** Statut d'une circulation : supprime, fait, deja, annonce, retard, prevu. */
  function statutCirculation(c, d, maintenantIso, seuilMin) {
    if (c.etat === 'nonprevu') return 'nonprevu';
    if (c.etat === 'supprime') return 'supprime';
    if (d.reel) return 'fait';
    if (c.etat === 'deja') return 'deja';
    if (d.annonce) return 'annonce';
    if (c.theo && maintenantIso && minutesEntre(maintenantIso, c.theo) > (seuilMin == null ? 15 : seuilMin)) return 'retard';
    return 'prevu';
  }
  function libelleStatut(st, sens) {
    return { nonprevu: 'Non prévue', supprime: 'Supprimé', fait: sens === 'D' ? 'Parti' : 'Arrivée', deja: 'Déjà là', annonce: 'Annoncé', retard: 'Retard', prevu: 'Prévu' }[st] || '';
  }
  function derniereVoie(j, num) {
    var s = norm(num), mv = mouvementsActifs(j);
    for (var i = mv.length - 1; i >= 0; i--) if (norm(mv[i].num) === s) return mv[i].vers || mv[i].voie || '';
    return '';
  }
  function prochainNumeroLigne(j) {
    var n = 0;
    (j.mouvements || []).forEach(function (m) { if (m.n > n) n = m.n; });
    return n + 1;
  }
  /**
   * Circulation validée (Arrivée, Parti) : si aucune ligne active du journal ne lui est rattachée, une ligne est créée
   * (numéro, EF, voie et wagons prévus, marquée auto) ; sinon l'heure réelle de la dernière est complétée.
   * Renvoie la ligne créée, ou null.
   */
  function journaliserCirculation(j, c, t, planning, params, id) {
    var liens = mouvementsActifs(j).filter(function (m) { return m.lien === c.id; });
    if (liens.length) { if (!liens[liens.length - 1].reel) liens[liens.length - 1].reel = t; return null; }
    var num = c.numero || c.sillon || c.code;
    var m = {
      id: id, n: prochainNumeroLigne(j), annonce: t, num: num, ef: deduireEF(num, j, planning, params) || '',
      voie: c.voiePrevue ? normaliserVoie(c.voiePrevue, params) : '', compo: c.wagonsDemandes != null ? String(c.wagonsDemandes) : '',
      cv: '', sit: '', vers: '', reel: t, comm: c.code + (c.sens === 'D' ? ' parti' : ' arrivée') + ' (saisie)', lien: c.id, supprime: false, auto: true
    };
    j.mouvements = j.mouvements || [];
    j.mouvements.push(m);
    return m;
  }
  /** Mouvement interne (locomotive, manœuvre NRS) : pas un numéro de train. */
  function estMouvementInterne(num, params) {
    var s = norm(num), internes = (params && params.mouvementsInternes) || {};
    for (var ef in internes) if (Object.prototype.hasOwnProperty.call(internes, ef) && internes[ef].indexOf(s) >= 0) return true;
    return /^(loco|nrs)/.test(s);
  }
  /** La voie de destination est-elle obligatoire pour ce numéro ? (Paramètres › saisie.versObligatoire) */
  function versObligatoire(num, params) {
    var regle = (params && params.saisie && params.saisie.versObligatoire) || 'internes';
    if (regle === 'toujours') return true;
    if (regle === 'jamais') return false;
    return estMouvementInterne(num, params);
  }
  /** Contrôle d'un champ de la saisie ; renvoie le message d'erreur ou ''. */
  function verifierChamp(champ, m, params) {
    var v = String(m[champ] == null ? '' : m[champ]).trim().toLowerCase();
    if (champ === 'num') return v ? '' : 'Le numéro est obligatoire.';
    if (champ === 'voie') return !v ? 'La voie est obligatoire.' : (voieConnue(v, params) ? '' : 'Voie « ' + v + ' » inconnue.');
    if (champ === 'compo') return !v ? 'Wagons : un nombre ou « hlp ».' : (v === 'hlp' || /^\d{1,3}$/.test(v) ? '' : 'Wagons : un nombre ou « hlp ».');
    if (champ === 'vers') {
      if (!v) return versObligatoire(m.num, params) ? 'La voie de destination est obligatoire pour ' + norm(m.num) + '.' : '';
      return voieConnue(v, params) ? '' : 'Voie de destination « ' + v + ' » inconnue.';
    }
    return '';
  }
  /** Contrôles avant enregistrement d'un mouvement. */
  function verifierMouvement(m, j, params, idIgnore) {
    var erreurs = [], avert = [];
    ['num', 'voie', 'compo', 'vers'].forEach(function (k) { var e = verifierChamp(k, m, params); if (e) erreurs.push(e); });
    var c = String(m.compo || '').trim().toLowerCase();
    if (/^\d+$/.test(c) && +c > 80) avert.push('Plus de 80 wagons : à vérifier.');
    if (m.reel && m.annonce && minutesEntre(m.reel, m.annonce) < 0) avert.push('Heure réelle antérieure à l\'annonce.');
    if (estNumeroTrain(m.num)) {
      var dbl = mouvementsActifs(j).filter(function (x) { return x.id !== idIgnore && norm(x.num) === norm(m.num); })[0];
      if (dbl) avert.push('Numéro déjà saisi ligne ' + dbl.n + ' à ' + hm(dbl.annonce) + '.');
    }
    return { erreurs: erreurs, avertissements: avert };
  }

  // ------------------------------------------------------------ diffusion
  function voieAffichee(c, d) {
    var v = (d.reel || d.annonce) ? d.voie : c.voiePrevue;
    return v ? String(v).toUpperCase() : '';
  }
  function ligneDiffusee(c, d, fam) {
    return {
      id: c.id, code: c.code, sens: c.sens,
      numero: fam === 'navette' ? (c.numero || c.sillon) : (c.sillon || c.numero),
      theo: c.theo || null, hlr: c.hlr || '',
      annonce: !!d.annonce, reel: d.reel || null,
      wagons: d.wagons != null ? d.wagons : (c.wagonsDemandes != null ? c.wagonsDemandes : null),
      voie: voieAffichee(c, d),
      // gardé après l'arrivée : le Suivi trains relit ce départ et ne doit pas le croire effacé
      partie: c.sens !== 'D' && c.etat !== 'supprime' ? (c.partie || null) : null,
      eta: c.sens !== 'D' && c.etat !== 'supprime' && c.partie ? (c.eta || null) : null,
      fa: c.sens !== 'D' && !d.reel && c.etat !== 'supprime' ? (c.fa || null) : null,
      etape: c.sens === 'D' && !d.reel && c.etat !== 'supprime' ? (c.etape || null) : null,
      // départ annoncé à la main dans la saisie (bouton ▲) : « Départ imminent » en grand sur les écrans
      annonceTV: c.sens === 'D' && !d.reel && c.etat !== 'supprime' ? (c.annonceTV || null) : null,
      cale: c.sens === 'D' && !d.reel && c.etat !== 'supprime' ? (c.cale || null) : null,
      etat: c.etat === 'supprime' || c.etat === 'deja' ? c.etat : null
    };
  }
  /**
   * Prochaines navettes d'un groupe : les `nb` prochains jours qui en ont (demain et après-demain ; le samedi, lundi et
   * mardi). Les jours préparés dans la saisie (demain, après-demain) sont repris avec leurs wagons et voies.
   * Sans `nb` : le premier jour seulement (ou null).
   */
  function prochainesNavettes(j, planning, gid, nb) {
    var vide = { annonce: null, reel: null, voie: null, wagons: null }, out = [];
    var base = ajouterJours(j.date, 1);
    for (var k = 0; k < 8 && out.length < (nb || 1); k++) {
      var date = ajouterJours(base, k);
      if (REGLAGES.sauterWeekend && jourSemaine(date) > 5) continue;
      var prep = [j.demain, j.surlendemain].filter(function (p) { return p && p.date === date; })[0];
      var circs = (prep ? (prep.circulations || []) : genererCirculations(planning, date))
        .filter(function (c) { return c.groupe === gid && c.etat !== 'nonprevu'; });
      if (!circs.length) continue;
      out.push({
        date: date, demain: k === 0,
        libelle: (k === 0 ? 'Demain · ' + JOURS[jourSemaine(date) - 1] : libellePrep(date, j.date)),
        lignes: circs.sort(trierParHeure).map(function (c) { return ligneDiffusee(c, vide, 'navette'); })
      });
    }
    return nb ? out : (out[0] || null);
  }
  function trierParHeure(a, b) { return (a.theo || '9') < (b.theo || '9') ? -1 : ((a.theo || '9') > (b.theo || '9') ? 1 : 0); }
  /** Regroupe arrivées et départs d'un même code en rotations, comme la feuille « tri trains 2 ». */
  function rotations(circs) {
    var parCode = {}, ordre = [];
    circs.forEach(function (c) {
      var k = c.groupe + '|' + c.code;
      if (!parCode[k]) { parCode[k] = { A: [], D: [] }; ordre.push(k); }
      parCode[k][c.sens === 'D' ? 'D' : 'A'].push(c);
    });
    var out = [];
    ordre.forEach(function (k) {
      var r = parCode[k]; r.A.sort(trierParHeure); r.D.sort(trierParHeure);
      for (var i = 0; i < Math.max(r.A.length, r.D.length); i++) out.push({ groupe: k.split('|')[0], code: k.split('|')[1], arrivee: r.A[i] || null, depart: r.D[i] || null });
    });
    out.sort(function (x, y) {
      var a = (x.arrivee && x.arrivee.theo) || (x.depart && x.depart.theo) || '9';
      var b = (y.arrivee && y.arrivee.theo) || (y.depart && y.depart.theo) || '9';
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    return out;
  }
  /**
   * Contenu du fichier diffusé aux écrans. Liste blanche : seuls ces champs quittent le poste de saisie.
   * Ni mouvements, ni EF, ni situation des voies, ni commentaires, ni mails, ni annuaire.
   */
  function projeterDiffusion(j, planning, params, maintenantIso) {
    var maint = maintenantIso || iso(new Date());
    var groupes = (planning && planning.groupes) || [];
    var vis = (params && params.visuel) || {};
    var navettes = [], trains = [];
    var demainVisible = vis.afficherDemain !== false && j.demain && hm(maint) >= (normHeure(vis.demainAPartirDe) || '00:00');
    groupes.forEach(function (g) {
      // « Non prévue » : retirée des écrans
      var circs = (j.circulations || []).filter(function (c) { return c.groupe === g.id && c.etat !== 'nonprevu'; });
      if (g.famille === 'navette') {
        var lignes = circs.slice().sort(trierParHeure).map(function (c) { return ligneDiffusee(c, etatCirculation(c, j), 'navette'); });
        var blocs = demainVisible ? prochainesNavettes(j, planning, g.id, 2) : [];
        navettes.push({
          id: g.id, libelle: g.libelle, couleur: couleurGroupe(g, vis), parcours: parcoursDe(g.id, g, params), lignes: lignes,
          demain: blocs[0] ? blocs[0].lignes : [], demainLibelle: blocs[0] ? blocs[0].libelle : '',
          ensuite: blocs[1] ? { libelle: blocs[1].libelle, lignes: blocs[1].lignes } : null,
          demainNote: demainVisible ? String((j.notesProchaines || {})[g.id] || '').trim() : ''
        });
      } else {
        rotations(circs).forEach(function (r) {
          trains.push({
            groupe: g.libelle, code: r.code, nom: nomTrain(r.code, params), parcours: parcoursDe(r.code, g, params),
            arrivee: r.arrivee ? ligneDiffusee(r.arrivee, etatCirculation(r.arrivee, j), 'ligne') : null,
            depart: r.depart ? ligneDiffusee(r.depart, etatCirculation(r.depart, j), 'ligne') : null
          });
        });
      }
    });
    trains.sort(function (x, y) {
      var a = (x.arrivee && x.arrivee.theo) || (x.depart && x.depart.theo) || '9';
      var b = (y.arrivee && y.arrivee.theo) || (y.depart && y.depart.theo) || '9';
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    var f = j.flash || {};
    // créneau : à partir de « de », jusqu'à « jusqua » (heures du jour)
    var flashActif = f.actif && norm(f.texte) && (!f.jusqua || hm(maint) < f.jusqua || maint.slice(0, 10) < j.date) &&
      (!f.de || hm(maint) >= f.de || maint.slice(0, 10) > j.date);
    return {
      schema: SCHEMA_DIFFUSION,
      date: j.date, jour: libelleJour(j.date),
      demain: j.demain ? JOURS[jourSemaine(j.demain.date) - 1] : '',
      titre: vis.titre || 'Circulations du jour',
      seuilRetardMinutes: (params && params.exploitation && params.exploitation.seuilRetardMinutes) || 15,
      vitesseFlash: vis.vitesseFlash || 90,
      alerteSansNouvellesSecondes: vis.alerteSansNouvellesSecondes || 45,
      version: j.version, publieA: maint,
      navettes: navettes, trains: trains,
      flash: flashActif ? { texte: String(f.texte).trim(), jusqua: f.jusqua || '' } : null
    };
  }
  /** Nom de ville affiché pour un train de ligne : Paramètres › visuel.nomsTrains, sinon ces valeurs, sinon le code. */
  var NOMS_TRAINS = { VNX: 'Vénissieux', BDX: 'Bordeaux', SPCO: 'Saint-Pierre-des-Corps', VIERZN: 'Vierzon', CLERMT: 'Clermont-Ferrand' };
  function nomTrain(code, params) {
    var n = (params && params.visuel && params.visuel.nomsTrains) || {};
    return n[code] || NOMS_TRAINS[code] || code;
  }
  var COULEURS_NAVETTES = {
    TDF: '#F28C28', TN: '#2D8CFF', ATL: '#F2C230',
    NAVILAND: '#8E5CF7', FEROVERGNE: '#22B573', DELTA: '#0EA5E9', FORWARDIS: '#EC4899', ARMEE: '#8D9EAF'
  };
  var COULEURS_SECOURS = ['#2EB872', '#B07CFF', '#FF6FA8'];
  /** Couleur d'un groupe de navettes : Paramètres › visuel.couleurs, sinon TDF orange, TN bleu, ATL jaune. */
  function couleurGroupe(g, vis) {
    var c = (vis && vis.couleurs && vis.couleurs[g.id]) || g.couleur || COULEURS_NAVETTES[g.id];
    if (c) return c;
    var h = 0; String(g.id).split('').forEach(function (ch) { h = (h + ch.charCodeAt(0)) % COULEURS_SECOURS.length; });
    return COULEURS_SECOURS[h];
  }
  // ------------------------------------------------------ parcours des navettes
  /** Trajet (minutes depuis le départ de l'origine) et points de passage, repris du « Suivi trains ». */
  var PASSAGES_FS = [{ lib: 'Départ FS', min: 2 }, { lib: 'CV 1474', min: 5 }, { lib: 'Entrée GB', min: 15 }, { lib: 'Sortie GB', min: 23 }];
  var PARCOURS_DEFAUT = {
    TDF: { trajet: 35, passages: PASSAGES_FS },
    TN: { trajet: 35, passages: PASSAGES_FS },
    ATL: { trajet: 35, passages: [{ lib: 'Départ Maritime', min: 2 }, { lib: 'Départ 4R', min: 5 }, { lib: 'Pont rouge', min: 15 }, { lib: 'Point X', min: 20 }, { lib: 'passage FA', min: 25 }] }
  };
  var TRAJET_LIGNE = 180;
  /** Parcours d'un groupe de navettes (ou d'un train de ligne par son code) : Paramètres › parcours, sinon les valeurs du Suivi trains. */
  function parcoursDe(cle, g, params) {
    var p = (params && params.parcours) || {};
    var r = p[cle] || (g && p[g.id]) || PARCOURS_DEFAUT[cle] || (g && PARCOURS_DEFAUT[g.id]);
    if (!r && g && g.famille === 'ligne') r = { trajet: TRAJET_LIGNE, passages: [] };
    return r ? { trajet: +r.trajet || 0, passages: (r.passages || []).slice().sort(function (a, b) { return a.min - b.min; }) } : null;
  }
  /** « TDF 35 : Départ FS 2, CV 1474 5 » : une ligne par groupe (ou code de train), minutes depuis le départ. */
  function parcoursEnTexte(parcours) {
    return Object.keys(parcours || {}).map(function (k) {
      var p = parcours[k];
      return k + ' ' + p.trajet + ((p.passages || []).length ? ' : ' + p.passages.map(function (x) { return x.lib + ' ' + x.min; }).join(', ') : '');
    }).join('\n');
  }
  function texteEnParcours(t) {
    var out = {};
    String(t || '').split(/\r?\n/).forEach(function (ligne, i) {
      ligne = ligne.trim(); if (!ligne) return;
      var m = /^(\S+)\s+(\d{1,3})\s*(?::\s*(.*))?$/.exec(ligne);
      if (!m) throw new Error('Ligne ' + (i + 1) + ' : écrire « TDF 35 : Départ FS 2, CV 1474 5 ».');
      var passages = (m[3] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean).map(function (x) {
        var pm = /^(.+?)\s+(\d{1,3})$/.exec(x);
        if (!pm) throw new Error('Ligne ' + (i + 1) + ' : « ' + x + ' » doit finir par ses minutes depuis le départ.');
        return { lib: pm[1], min: +pm[2] };
      });
      out[m[1].toUpperCase()] = { trajet: +m[2], passages: passages };
    });
    return out;
  }

  /**
   * État affiché sur les écrans, avec le compte à rebours. cle : supprime, fait, deja, imminent, route, bientot, prepa,
   * attendu, retard, prevu. « Annoncé » devient « Arrivée imminente » ou « Départ imminent » ; dans les 30 minutes :
   * « Prévu dans 12 min » (d'après l'heure prévue). Une arrivée partie de son origine suit son parcours : sous = point de passage, eta = arrivée estimée.
   * urgent : plus que 5 minutes (clignote en rouge sur les écrans).
   */
  function etatAffichage(l, maintenantIso, seuilMin, parcours) {
    var seuil = seuilMin == null ? 15 : seuilMin, arr = l.sens !== 'D';
    if (l.etat === 'supprime') return { cle: 'supprime', libelle: 'Supprimé' };
    if (l.reel) return { cle: 'fait', libelle: (arr ? 'Arrivée ' : 'Parti ') + hm(l.reel) };
    // train déclaré calé dans le Suivi trains : prioritaire, dernière étape en dessous
    if (!arr && l.cale) return { cle: 'cale', libelle: 'Calé à ' + hm(l.cale), sous: l.etape && l.etape.lib ? l.etape.lib + ' ' + (l.etape.h || '') : '' };
    if (l.etat === 'deja') return { cle: 'deja', libelle: 'Déjà là' };
    if (l.annonce || (!arr && l.annonceTV)) return { cle: 'imminent', libelle: arr ? 'Arrivée imminente' : 'Départ imminent' };
    if (arr && l.partie) {
      // heure d'arrivée estimée : celle du Suivi trains si elle est connue, sinon départ + durée du parcours
      var eta = l.eta || iso(new Date(lireDate(l.partie).getTime() + ((parcours && parcours.trajet) || 35) * 60000));
      var trajet = Math.max(1, minutesEntre(eta, l.partie)), ecoule = minutesEntre(maintenantIso, l.partie), reste = minutesEntre(eta, maintenantIso);
      var passages = (parcours && parcours.passages) || [];
      var passe = passages.filter(function (p) { return p.min <= ecoule; }).pop();
      var base = { eta: eta, ecartEta: l.theo ? minutesEntre(eta, l.theo) : null, sous: passe ? passe.lib : 'Départ ' + hm(l.partie) };
      if (reste > 5) return Object.assign(base, { cle: 'route', libelle: (passages.length ? 'Arrive dans ' : 'En approche · ') + reste + ' min', progression: Math.max(0, Math.min(1, ecoule / trajet)) });
      // urgent : 5 minutes ou moins avant l'heure, clignote en rouge sur les écrans
      if (reste > 0) return Object.assign(base, { cle: 'imminent', libelle: 'Arrivée imminente', urgent: true });
      if (-reste <= seuil) return Object.assign(base, { cle: 'attendu', libelle: 'Arrivée attendue', sous: 'prévue à ' + hm(eta) });
      return Object.assign(base, { cle: 'retard', libelle: 'Retard ' + fmtEcart(-reste), sous: 'prévue à ' + hm(eta) });
    }
    // arrivé au faisceau FA, pas encore chez nous
    if (arr && l.fa) return { cle: 'fa', libelle: 'À FA depuis ' + hm(l.fa) };
    if (!arr && l.etape && l.etape.lib) return { cle: 'prepa', libelle: l.etape.lib, sous: l.etape.h ? 'à ' + l.etape.h : '' };
    if (!l.theo) return { cle: 'prevu', libelle: 'Prévu' };
    var m = minutesEntre(l.theo, maintenantIso);
    if (m > 30) return { cle: 'prevu', libelle: 'Prévu' };
    // d'après l'heure prévue seulement : « Prévu dans », pour ne pas le confondre avec une navette réellement en route
    if (m > 0) return { cle: 'bientot', libelle: 'Prévu dans ' + m + ' min', minutes: m, urgent: m <= 5 };
    if (-m <= seuil) return { cle: 'attendu', libelle: arr ? 'Attendu' : 'Départ attendu' };
    return { cle: 'retard', libelle: 'Retard ' + fmtEcart(-m) };
  }
  /** Statut d'une ligne diffusée, recalculé par l'écran avec sa propre horloge. */
  function statutDiffuse(l, maintenantIso, seuilMin) {
    if (!l) return '';
    if (l.etat === 'supprime') return 'supprime';
    if (l.reel) return 'fait';
    if (l.etat === 'deja') return 'deja';
    if (l.annonce) return 'annonce';
    if (l.theo && minutesEntre(maintenantIso, l.theo) > (seuilMin == null ? 15 : seuilMin)) return 'retard';
    return 'prevu';
  }

  // ---------------------------------------------------------------- mails
  var TYPES_MAIL = ['navetteDepart', 'ligneArrivee', 'ligneDepart'];
  function typeMail(c, planning) {
    var fam = familleDe(planning, c);
    if (fam === 'navette') return c.sens === 'D' ? 'navetteDepart' : null;
    return c.sens === 'D' ? 'ligneDepart' : 'ligneArrivee';
  }
  function modeMail(type, params) {
    var m = (params && params.mails) || {};
    return (m.modes && m.modes[type]) || m.mode || 'simulation';
  }
  function remplir(modele, v, html) {
    return String(modele || '').replace(/\{(\w+)\}/g, function (_, k) { return v[k] == null ? '' : (html ? esc(v[k]) : String(v[k])); });
  }
  var DEROULE = [
    ['conducteur', 'Arrivée du conducteur sur le terminal à'],
    ['miseEnTete', 'Mise en tête à'],
    ['bonDepart', 'Annonce « Bon au départ » à'],
    ['retourRegulateur', 'Retour du régulateur à'],
    ['ouvertureSignal', 'Ouverture du signal à']
  ];
  /** Construit le mail d'une circulation réalisée, ou null si aucun destinataire ou envoi désactivé. */
  function construireMail(j, c, planning, params, suffixe) {
    var type = typeMail(c, planning);
    if (!type) return null;
    var mode = modeMail(type, params);
    if (mode === 'desactive') return null;
    var g = groupeDe(planning, c.groupe) || {};
    var m = (params && params.mails) || {};
    var listes = m.listes || {};
    // liste du groupe (Planning), sinon celle qui porte son identifiant (Paramètres › Mails, une ligne par EF ou groupe)
    var to = listes[g.listeMail || g.id] || [];
    if (!to.length) return null;
    var d = etatCirculation(c, j);
    if (!d.reel) return null;
    var v = {
      code: c.code, sillon: c.sillon || c.numero, numero: c.numero || c.sillon, destinataire: g.destinataire || g.libelle || '',
      heure: hhmm(d.reel), date: libelleDateCourte(j.date), jj: j.date.slice(8, 10), site: (params && params.site) || ''
    };
    var mod = (m.modeles && m.modeles[type]) || {};
    var deroule = '';
    if (type === 'ligneDepart') {
      var renseigne = DEROULE.filter(function (e) { return c.deroule && c.deroule[e[0]]; });
      if (renseigne.length || mode === 'brouillon') {
        deroule = '<p><u>Déroulé des évènements :</u></p><ul>' + DEROULE.map(function (e) {
          return '<li>' + esc(e[1]) + ' ' + esc((c.deroule && c.deroule[e[0]]) ? c.deroule[e[0]].replace(':', 'h') : '') + '</li>';
        }).join('') + '</ul>';
      }
    }
    var html = '<html><body style="font-family:Calibri,Arial,sans-serif;font-size:12pt;">' +
      '<p>' + remplir(mod.intro, v, true) + '</p>' +
      '<p style="font-size:15pt;margin:10px 0;"><strong><span style="color:#483D8B;">' + remplir(mod.ligne, v, true) + '</span></strong></p>' +
      deroule + '<br><!--signature--></body></html>';
    return {
      id: (j.date + '_' + c.id + '_' + type + (suffixe ? '_' + suffixe : '')).replace(/[^A-Za-z0-9_.-]/g, '-'),
      type: type, mode: mode,
      to: to, cc: type === 'navetteDepart' ? (m.copieNavettes || []) : [],
      bcc: type !== 'navetteDepart' && m.listeCopieCacheeLignes ? (listes[m.listeCopieCacheeLignes] || []) : [],
      sujet: remplir(mod.sujet, v, false), html: html
    };
  }
  var STATUTS_MAIL_OK = ['envoye', 'brouillon', 'simule', 'deja'];
  /** Circulations réalisées dont le mail n'est pas encore parti. */
  function mailsEnAttente(j, planning, params) {
    return (j.circulations || []).filter(function (c) {
      var type = typeMail(c, planning);
      if (!type || c.etat === 'supprime') return false;
      if (!etatCirculation(c, j).reel) return false;
      var st = c.mails && c.mails[type];
      if (st && STATUTS_MAIL_OK.indexOf(st.statut) >= 0) return false;
      if (st && st.statut === 'erreur' && (st.essais || 0) >= 5) return false;
      return !!construireMail(j, c, planning, params);
    });
  }

  // ------------------------------------------------- statistiques et archives
  function statistiques(j, planning, params) {
    var coupure = minutesDuJour((params && params.exploitation && params.exploitation.coupurePoste) || '13:30');
    var mv = mouvementsActifs(j);
    var s = {
      date: j.date, mouvements: mv.length, trainsNumerotes: 0, manoeuvresNrs: 0, hlp: 0,
      locom: { matin: { hlp: 0, charge: 0 }, apresMidi: { hlp: 0, charge: 0 } },
      locosup: { matin: { hlp: 0, charge: 0 }, apresMidi: { hlp: 0, charge: 0 } },
      nrs: { matin: { hlp: 0, charge: 0 }, apresMidi: { hlp: 0, charge: 0 } },
      circulationsPrevues: 0, realisees: 0, supprimees: 0, dejaLa: 0, retardMoyenNavettes: null, retardMaxNavettes: null
    };
    mv.forEach(function (m) {
      var n = norm(m.num), hlp = norm(m.compo) === 'hlp';
      if (hlp) s.hlp++;
      if (estNumeroTrain(n)) s.trainsNumerotes++;
      if (/^nrs/.test(n)) s.manoeuvresNrs++;
      // LHTE (locom, loco), locosup et manœuvres NRS (nrs1…) : HLP ou en charge, matin ou après-midi
      var mobile = n === 'locom' || n === 'loco' ? 'locom' : (n === 'locosup' || n === 'locosupp' ? 'locosup' : (/^nrs/.test(n) ? 'nrs' : null));
      if (mobile) {
        var poste = minutesDuJour(hm(m.annonce)) < coupure ? 'matin' : 'apresMidi';
        s[mobile][poste][hlp ? 'hlp' : 'charge']++;
      }
    });
    var retards = [];
    (j.circulations || []).forEach(function (c) {
      if (c.etat === 'nonprevu') return;
      s.circulationsPrevues++;
      var d = etatCirculation(c, j);
      if (c.etat === 'supprime') s.supprimees++;
      else if (d.reel) {
        s.realisees++;
        if (familleDe(planning, c) === 'navette' && c.theo) retards.push(minutesEntre(d.reel, c.theo));
      } else if (c.etat === 'deja') s.dejaLa++;
    });
    if (retards.length) {
      s.retardMoyenNavettes = Math.round(retards.reduce(function (a, b) { return a + b; }, 0) / retards.length);
      s.retardMaxNavettes = Math.max.apply(null, retards);
    }
    return s;
  }
  function csvCellule(v) {
    var t = v == null ? '' : String(v);
    return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function csv(lignes) { return lignes.map(function (l) { return l.map(csvCellule).join(';'); }).join('\r\n') + '\r\n'; }
  function exporterMouvements(j, planning, params) {
    var rows = [['n', 'date', 'annonce', 'numero', 'ef', 'traction', 'zone', 'voie', 'wagons', 'charges_vides', 'situation_voie', 'vers', 'reel', 'commentaire', 'circulation', 'supprime']];
    (j.mouvements || []).forEach(function (m) {
      var c = m.lien ? (j.circulations || []).filter(function (x) { return x.id === m.lien; })[0] : null;
      rows.push([m.n, j.date, hm(m.annonce), m.num, m.ef, deduireTraction(m.ef, params), deduireZone(m.num), m.voie, m.compo, m.cv, m.sit, m.vers, hm(m.reel), m.comm,
        c ? c.code + ' (' + (groupeDe(planning, c.groupe) || {}).libelle + ')' : '', m.supprime ? 'oui' : '']);
    });
    return csv(rows);
  }
  function exporterCirculations(j, planning) {
    var rows = [['date', 'groupe', 'code', 'sens', 'numero', 'sillon', 'hlr', 'theorique', 'annonce', 'reel', 'ecart_min', 'voie', 'wagons', 'wagons_demandes', 'etat', 'mail']];
    (j.circulations || []).forEach(function (c) {
      var d = etatCirculation(c, j), st = statutCirculation(c, d, null, 15);
      var type = typeMail(c, planning), mail = type && c.mails && c.mails[type] ? c.mails[type].statut : '';
      rows.push([j.date, (groupeDe(planning, c.groupe) || {}).libelle || c.groupe, c.code, c.sens === 'D' ? 'départ' : 'arrivée', c.numero, c.sillon, c.hlr,
        hm(c.theo), hm(d.annonce), hm(d.reel), d.reel && c.theo ? minutesEntre(d.reel, c.theo) : '', d.voie || '', d.wagons == null ? '' : d.wagons,
        c.wagonsDemandes == null ? '' : c.wagonsDemandes, st === 'retard' || st === 'prevu' ? 'non réalisé' : libelleStatut(st, c.sens).toLowerCase(), mail]);
    });
    return csv(rows);
  }
  var ENTETE_STATS = ['date', 'mouvements', 'trains_numerotes', 'manoeuvres_nrs', 'hlp',
    'locom_hlp_matin', 'locom_charge_matin', 'locom_hlp_apres_midi', 'locom_charge_apres_midi',
    'locosup_hlp_matin', 'locosup_charge_matin', 'locosup_hlp_apres_midi', 'locosup_charge_apres_midi',
    'circulations_prevues', 'realisees', 'supprimees', 'deja_la', 'retard_moyen_navettes_min', 'retard_max_navettes_min',
    // ajoutées en fin de ligne : les colonnes déjà présentes dans statistiques.csv et le registre ne bougent pas
    'nrs_hlp_matin', 'nrs_charge_matin', 'nrs_hlp_apres_midi', 'nrs_charge_apres_midi'];
  function ligneStatistiques(s) {
    var nrs = s.nrs || { matin: { hlp: 0, charge: 0 }, apresMidi: { hlp: 0, charge: 0 } };
    return [s.date, s.mouvements, s.trainsNumerotes, s.manoeuvresNrs, s.hlp,
      s.locom.matin.hlp, s.locom.matin.charge, s.locom.apresMidi.hlp, s.locom.apresMidi.charge,
      s.locosup.matin.hlp, s.locosup.matin.charge, s.locosup.apresMidi.hlp, s.locosup.apresMidi.charge,
      s.circulationsPrevues, s.realisees, s.supprimees, s.dejaLa,
      s.retardMoyenNavettes == null ? '' : s.retardMoyenNavettes, s.retardMaxNavettes == null ? '' : s.retardMaxNavettes,
      nrs.matin.hlp, nrs.matin.charge, nrs.apresMidi.hlp, nrs.apresMidi.charge].map(csvCellule).join(';');
  }

  // ------------------------------------------------------ planning : variantes
  /** Texte lisible des variantes : "lun,mar: hlr=07:00; sam: heure=08:06". */
  function variantesEnTexte(vs) {
    return (vs || []).map(function (v) {
      var champs = Object.keys(v).filter(function (k) { return k !== 'jours'; }).map(function (k) { return k + '=' + (v[k] == null ? '' : v[k]); });
      return (v.jours || []).map(function (n) { return JOURS_COURTS[n - 1]; }).join(',') + ': ' + champs.join(', ');
    }).join('; ');
  }
  function texteEnVariantes(t) {
    var out = [];
    String(t || '').split(';').forEach(function (bloc) {
      bloc = bloc.trim(); if (!bloc) return;
      var i = bloc.indexOf(':'); if (i < 0) throw new Error('Variante sans « : » : ' + bloc);
      var jours = bloc.slice(0, i).split(',').map(function (x) {
        var k = JOURS_COURTS.indexOf(norm(x).slice(0, 3)); if (k < 0) throw new Error('Jour inconnu : ' + x); return k + 1;
      });
      var v = { jours: jours };
      bloc.slice(i + 1).split(',').forEach(function (kv) {
        kv = kv.trim(); if (!kv) return;
        var e = kv.indexOf('='); if (e < 0) throw new Error('Attendu champ=valeur : ' + kv);
        var k = kv.slice(0, e).trim(), val = kv.slice(e + 1).trim();
        if (['hlr', 'heure', 'numero', 'sillon', 'voiePrevue', 'wagonsDemandes'].indexOf(k) < 0) throw new Error('Champ inconnu : ' + k);
        if (k === 'hlr' || k === 'heure') { var h = normHeure(val); if (!h) throw new Error('Heure invalide : ' + val); val = h; }
        if (k === 'wagonsDemandes') { if (val === '' || val === 'null') val = null; else if (/^\d+$/.test(val)) val = +val; else throw new Error('Wagons invalides : ' + val); }
        v[k] = val;
      });
      out.push(v);
    });
    return out;
  }

  /**
   * Mémorise les wagons demandés et voies prévues d'une journée comme habitude de son jour de semaine
   * (variante du planning). Renvoie le nouveau planning et le nombre de circulations modifiées.
   */
  function memoriserHabitudes(planning, circs, cle) {
    var jour = jourSemaine(cle), p = copie(planning), n = 0;
    (circs || []).forEach(function (c) {
      var pc = (p.circulations || []).filter(function (x) { return x.id === c.planId; })[0];
      if (!pc) return;
      var base = appliquerVariantes(pc, jour);
      var w = c.wagonsDemandes == null || c.wagonsDemandes === '' ? null : +c.wagonsDemandes, voie = c.voiePrevue || '';
      var bw = base.wagonsDemandes == null || base.wagonsDemandes === '' ? null : +base.wagonsDemandes;
      if (bw === w && (base.voiePrevue || '') === voie) return;
      pc.variantes = pc.variantes || [];
      var va = pc.variantes.filter(function (x) { return (x.jours || []).length === 1 && x.jours[0] === jour; })[0];
      if (!va) { va = { jours: [jour] }; pc.variantes.push(va); }
      va.wagonsDemandes = w; va.voiePrevue = voie; n++;
    });
    return { planning: p, modifiees: n };
  }

  // -------------------------------------------------------- Suivi trains
  /** Arrivées fret du Suivi trains (identifiant de vignette) → code du train de ligne. Paramètres › suiviTrains.correspondances. */
  var CORRESPONDANCES_SUIVI = { venissieux: 'VNX', spco: 'SPCO', bordeaux: 'BDX', vierzon: 'VIERZN', clermont: 'CLERMT' };
  /** Étapes du Suivi trains → champ de la circulation de départ (reel = départ pour la ligne). */
  var ETAPES_SUIVI = [
    [/depart pour la ligne/, 'reel'], [/\bcale\b/, 'cale'], [/conducteur/, 'conducteur'], [/mise en tete/, 'miseEnTete'],
    [/bon au depart/, 'bonDepart'], [/regulateur/, 'retourRegulateur'], [/ouverture/, 'ouvertureSignal']
  ];
  function sansAccents(s) { return norm(s).normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function heureSuivi(v) { var m = /(\d{1,2})[:h](\d{2})/.exec(String(v == null ? '' : v)); return m ? normHeure(m[1] + ':' + m[2]) : null; }
  /**
   * Une ligne par clé : le classeur peut contenir la même étape plusieurs fois (lignes ajoutées au lieu d'être
   * mises à jour) ; la dernière ligne est la plus récente, y compris une heure vidée.
   */
  function dedoublonner(lignes, cle) {
    var vus = {}, ordre = [];
    (lignes || []).forEach(function (r) {
      var k = cle(r);
      if (!Object.prototype.hasOwnProperty.call(vus, k)) ordre.push(k);
      vus[k] = r;
    });
    return ordre.map(function (k) { return vus[k]; });
  }
  /**
   * Reporte dans la journée ce que le Suivi trains a enregistré (onglets « Navettes » et « Journal » de son classeur) :
   * - navette FL1 : départ de l'origine (partie), FL1-arr : arrivée réelle ; tableau des départs LF1 : départ réel ;
   * - arrivées fret (venissieux…) : départ de l'origine et arrivée ; trains (n° de départ) : déroulé et départ pour la ligne.
   * Une valeur n'est reportée que si elle est nouvelle ou a changé dans le Suivi trains : une correction faite ici reste.
   * Renvoie la liste des changements (texte), vide si rien n'a bougé.
   */
  function appliquerSuiviTrains(j, donnees, params) {
    var cfg = (params && params.suiviTrains) || {}, corr = cfg.correspondances || CORRESPONDANCES_SUIVI;
    var st = j.suiviTrains = j.suiviTrains || { vu: {} }, vu = st.vu = st.vu || {}, changes = [];
    var circ = function (code, sens) {
      var k = norm(code);
      return (j.circulations || []).filter(function (c) { return norm(c.code) === k && c.sens === sens && c.etat !== 'supprime'; })[0] || null;
    };
    var reporter = function (cle, valeur, c, champ, texte) {
      if (!c || vu[cle] === (valeur || '')) return;
      var avant = vu[cle], h = valeur ? combiner(j.date, valeur) : null;
      vu[cle] = valeur || '';
      var cible = champ.indexOf('deroule.') === 0 ? (c.deroule = c.deroule || {}) : c, k = champ.replace('deroule.', '');
      var actuel = champ.indexOf('deroule.') === 0 ? cible[k] : (cible[k] ? hm(cible[k]) : '');
      if (!h) { if (avant && actuel === avant) { cible[k] = null; changes.push(texte + ' retiré'); } return; }
      var nouveau = champ.indexOf('deroule.') === 0 ? valeur : h;
      if (cible[k] === nouveau) return;
      cible[k] = nouveau; changes.push(texte + ' ' + valeur);
    };
    // heure d'arrivée estimée envoyée par le Suivi trains avec le départ (colonne Heure théorique)
    var majEta = function (c, h, theo, nom) {
      if (!c || !c.partie || !h || hm(c.partie) !== h) return;
      var e = heureSuivi(theo), nv = e ? combiner(j.date, e) : null;
      if (nv && nv < c.partie) nv = combiner(ajouterJours(j.date, 1), e);
      if ((c.eta || null) === nv) return;
      c.eta = nv;
      if (nv) changes.push(nom + ' arrivée estimée ' + e);
    };
    // voie et wagons saisis dans le Suivi trains → tableau de droite (voie, wagons affichés) ; reportés seulement quand
    // ils changent là-bas (une correction faite dans la saisie reste tant que le Suivi trains n'envoie rien de nouveau)
    var reporterInfo = function (cle, r, c, nom) {
      if (!c) return;
      var voie = String(r.voie || '').trim().toUpperCase(), w = String(r.wagons == null ? '' : r.wagons).trim();
      var wn = w === '' || isNaN(+w) ? null : +w;
      if (vu[cle + '|voie'] !== voie) { vu[cle + '|voie'] = voie; if ((c.voiePrevue || '') !== voie) { c.voiePrevue = voie; changes.push(nom + ' voie ' + (voie || '—')); } }
      if (vu[cle + '|wg'] !== w) { vu[cle + '|wg'] = w; if ((c.wagonsDemandes == null ? null : c.wagonsDemandes) !== wn) { c.wagonsDemandes = wn; changes.push(nom + ' ' + (wn == null ? 'wagons —' : wn + ' wagons')); } }
    };
    var departTrain = function (num) {
      var k = norm(num);
      return k ? (j.circulations || []).filter(function (x) { return x.sens === 'D' && x.etat !== 'supprime' && numerosDe(x).indexOf(k) >= 0; })[0] || null : null;
    };
    dedoublonner(donnees.navettes, function (r) { return sansAccents(r.type) + '|' + norm(r.code); }).forEach(function (r) {
      var type = sansAccents(r.type), code = String(r.code || '').trim(), h = heureSuivi(r.reel);
      if (type === 'infonavette') { reporterInfo('I|N|' + code, r, circ(code, 'A'), code); return; }
      if (type === 'infoquickboard') { reporterInfo('I|Q|' + code, r, circ(code, 'D'), code); return; }
      if (type === 'infoarrivee') { var ci = corr[code.toLowerCase()] || corr[code]; if (ci) reporterInfo('I|A|' + code, r, circ(ci, 'A'), ci); return; }
      if (type === 'infotrain') { var ct = departTrain(code) || departTrain(r.libelle); if (ct) reporterInfo('I|T|' + code, r, ct, ct.code); return; }
      // départ d'une navette annoncé dans le Suivi trains (▲ du tableau des départs) : « Départ imminent » sur les écrans
      if (type === 'annonce') { var ca2 = circ(code, 'D'); if (ca2 && !ca2.reel) reporter('AN|' + code, h, ca2, 'annonceTV', code + ' départ annoncé'); return; }
      var arrivee = /-arr$/i.test(code), fa = /-fa$/i.test(code), base = code.replace(/-(arr|fa)$/i, '');
      if (type === 'navette') {
        var n = circ(base, 'A');
        reporter('N|' + code, h, n, arrivee ? 'reel' : 'partie', base + (arrivee ? ' arrivée' : ' partie'));
        if (!arrivee) majEta(n, h, r.theo, base);
      } else if (type === 'quickboard') {
        reporter('Q|' + code, h, circ(base, 'D'), 'reel', base + ' partie');
      } else if (type === 'arrivee') {
        var cible = corr[base.toLowerCase()] || corr[base], ca = cible ? circ(cible, 'A') : null;
        if (!cible) return;
        reporter('A|' + code, h, ca, arrivee ? 'reel' : (fa ? 'fa' : 'partie'), cible + (arrivee ? ' arrivée' : (fa ? ' à FA' : ' en approche')));
        if (!arrivee && !fa) majEta(ca, h, r.theo, cible);
      }
    });
    var etapes = {};
    dedoublonner(donnees.journal, function (r) { return norm(r.train) + '|' + sansAccents(r.etape); }).forEach(function (r) {
      var num = norm(r.train), lib = sansAccents(r.etape), h = heureSuivi(r.reel);
      var c = (j.circulations || []).filter(function (x) { return x.sens === 'D' && x.etat !== 'supprime' && numerosDe(x).indexOf(num) >= 0; })[0];
      if (!c) return;
      var regle = ETAPES_SUIVI.filter(function (e) { return e[0].test(lib); })[0];
      var champ = !regle ? null : (regle[1] === 'reel' || regle[1] === 'cale' ? regle[1] : 'deroule.' + regle[1]);
      if (champ) reporter('J|' + num + '|' + lib, h, c, champ, c.code + ' ' + String(r.etape).trim());
      // dernière étape franchie, affichée sur les écrans tant que le train n'est pas parti
      if (h && !(champ === 'reel' || champ === 'cale') && (!etapes[c.id] || etapes[c.id].h <= h)) etapes[c.id] = { lib: String(r.etape).trim(), h: h };
    });
    // étape en cours : reportée seulement quand elle change dans le Suivi trains (une étape effacée dans la saisie reste effacée)
    (j.circulations || []).forEach(function (c) {
      if (c.sens !== 'D') return;
      var e = etapes[c.id] || null, cle = 'E|' + c.id, val = e ? e.lib + ' ' + e.h : '';
      if (vu[cle] === val) return;
      vu[cle] = val;
      if (JSON.stringify(c.etape || null) !== JSON.stringify(e)) { c.etape = e; if (e && !c.reel) changes.push(c.code + ' : ' + e.lib + ' ' + e.h); }
    });
    if (changes.length) st.maj = iso(new Date());
    return changes;
  }

  return {
    JOURS: JOURS, JOURS_COURTS: JOURS_COURTS, TYPES_MAIL: TYPES_MAIL, DEROULE: DEROULE, ENTETE_STATS: ENTETE_STATS,
    PARCOURS_DEFAUT: PARCOURS_DEFAUT, CORRESPONDANCES_SUIVI: CORRESPONDANCES_SUIVI, NOMS_TRAINS: NOMS_TRAINS, nomTrain: nomTrain,
    parcoursDe: parcoursDe, parcoursEnTexte: parcoursEnTexte, texteEnParcours: texteEnParcours, prochainesNavettes: prochainesNavettes,
    assurerSurlendemain: assurerSurlendemain, recalerPreps: recalerPreps, jourPrep: jourPrep, libellePrep: libellePrep, regler: regler, REGLAGES: REGLAGES, journaliserCirculation: journaliserCirculation,
    appliquerSuiviTrains: appliquerSuiviTrains, heureSuivi: heureSuivi,
    p2: p2, lireDate: lireDate, iso: iso, cleDate: cleDate, ajouterJours: ajouterJours, jourSemaine: jourSemaine,
    libelleJour: libelleJour, libelleDateCourte: libelleDateCourte, hm: hm, hhmm: hhmm, normHeure: normHeure, combiner: combiner,
    heureProche: heureProche, minutesEntre: minutesEntre, fmtEcart: fmtEcart, minutesDuJour: minutesDuJour,
    copie: copie, esc: esc, norm: norm, estNumeroTrain: estNumeroTrain, groupeDe: groupeDe, familleDe: familleDe,
    normaliserVoie: normaliserVoie, voieConnue: voieConnue, efDeLaBase: efDeLaBase, deduireEF: deduireEF, deduireZone: deduireZone, deduireTraction: deduireTraction,
    estMouvementInterne: estMouvementInterne, versObligatoire: versObligatoire, verifierChamp: verifierChamp,
    appliquerVariantes: appliquerVariantes, numerosDe: numerosDe, instancier: instancier, genererCirculations: genererCirculations, nouvelleJournee: nouvelleJournee,
    mouvementsActifs: mouvementsActifs, trouverCirculation: trouverCirculation, etatCirculation: etatCirculation, statutCirculation: statutCirculation,
    libelleStatut: libelleStatut, derniereVoie: derniereVoie, prochainNumeroLigne: prochainNumeroLigne, verifierMouvement: verifierMouvement,
    rotations: rotations, projeterDiffusion: projeterDiffusion, statutDiffuse: statutDiffuse, etatAffichage: etatAffichage, couleurGroupe: couleurGroupe,
    typeMail: typeMail, modeMail: modeMail, construireMail: construireMail, mailsEnAttente: mailsEnAttente, STATUTS_MAIL_OK: STATUTS_MAIL_OK,
    statistiques: statistiques, csv: csv, exporterMouvements: exporterMouvements, exporterCirculations: exporterCirculations, ligneStatistiques: ligneStatistiques,
    variantesEnTexte: variantesEnTexte, texteEnVariantes: texteEnVariantes, memoriserHabitudes: memoriserHabitudes
  };
});
