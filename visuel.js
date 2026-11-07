/*
 * Suivi des circulations - mode VISUEL.
 * Données : ?source=<adresse du serveur Google> (version GitHub), sinon diffusion.js à côté de la page.
 * Lecture seule : cette page n'écrit rien. Paramètre d'adresse ?vue=navettes | trains | tout.
 */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var esc = SC.esc, hm = SC.hm;
  var vue = (/[?&]vue=(\w+)/.exec(location.search) || [])[1] || 'tout';
  // adresse du serveur : dans l'adresse de la page, sinon la dernière connue (application installée, ouverte sans paramètre)
  var source = (function () {
    var m = /[?&]source=([^&]+)/.exec(location.search), s = m ? decodeURIComponent(m[1]) : '';
    try {
      if (s) localStorage.setItem('suivi:source', s);
      else if (/^https:/.test(location.protocol)) s = localStorage.getItem('suivi:source') || '';
    } catch (e) { /* stockage indisponible */ }
    return s;
  })();
  var etat = { d: null, cle: '', battement: null, battementVuA: 0, echecs: 0, flash: '', version: null };

  // ------------------------------------------------------------ réception
  window.__diffusion = function (d, meta, travaux) {
    if (!d || d.schema !== 1) return;
    if (travaux) majTravaux(travaux);
    etat.echecs = 0;
    var b = meta && meta.battement;
    if (b !== etat.battement) { etat.battement = b; etat.battementVuA = Date.now(); }
    var cle = JSON.stringify(d);
    if (cle !== etat.cle) { etat.cle = cle; etat.d = d; rendre(); }
    majLiaison();
  };
  function charger() {
    if (DEMO) {
      var cyc = Math.floor(Date.now() / 420000) * 420000, avis = [
        { code: 'PF2', couleur: 'rouge', texte: 'Le portique fluvial 2 est hors service pour le moment.', message: '', creneau: 'toute la journée', depuis: '2000-01-01T00:00:00' },
        { code: 'RMG4', couleur: 'orange', texte: 'Le portique RMG4 est actuellement en cours de maintenance.', message: 'retour prévu 14:00', creneau: '8h-12h', depuis: '2000-01-01T00:00:00' }];
      // un nouvel avis 40 s après le début de chaque boucle : alerte en grand puis bandeau
      if (Date.now() - cyc > 40000) avis.unshift({ code: 'RMG3', couleur: 'rouge', texte: 'Le portique RMG3 est hors service pour le moment.', message: 'panne spreader', creneau: 'demi-journée', depuis: SC.iso(new Date(cyc + 40000)), a: SC.iso(new Date(cyc + 40000)) });
      window.__diffusion(diffusionDemo(), { battement: Math.floor(Date.now() / 1000) }, avis);
      return;
    }
    if (source) {
      if (etat.lecture && Date.now() - etat.lecture < 15000) return;
      etat.lecture = Date.now();
      fetch(source + (source.indexOf('?') < 0 ? '?' : '&') + 'action=diffusion&t=' + Date.now(), { cache: 'no-store', redirect: 'follow' })
        .then(function (r) { return r.json(); })
        .then(function (o) { etat.lecture = 0; if (o && o.diffusion) window.__diffusion(o.diffusion, o.meta, o.travaux); else { etat.echecs++; majLiaison(); } })
        .catch(function () { etat.lecture = 0; etat.echecs++; majLiaison(); });
      return;
    }
    var s = document.createElement('script');
    s.src = 'diffusion.js?t=' + Date.now();
    s.onload = function () { s.remove(); };
    s.onerror = function () { s.remove(); etat.echecs++; majLiaison(); };
    document.head.appendChild(s);
  }

  // ------------------------------------------------------------- cellules
  function maintenant() { return SC.iso(new Date()); }
  function classeEcart(min) { return min < 0 ? 'tot' : (min > 15 ? 'tres-tard' : (min > 0 ? 'tard' : '')); }
  function celluleEcart(l, e) {
    if (l.reel && l.theo) { var m = SC.minutesEntre(l.reel, l.theo); return '<span class="ec ' + classeEcart(m) + '">' + SC.fmtEcart(m) + '</span>'; }
    // en route : retard estimé à l'arrivée, d'après l'heure de départ de l'origine
    if (e.ecartEta != null) return e.ecartEta ? '<span class="ec ' + classeEcart(e.ecartEta) + '">' + SC.fmtEcart(e.ecartEta) + '</span>' : '<span class="ec">à l\'heure</span>';
    if ((e.cle === 'retard' || e.cle === 'attendu' || e.cle === 'imminent') && l.theo) {
      var r = SC.minutesEntre(maintenant(), l.theo);
      if (r > 0) return '<span class="ec ' + classeEcart(r) + '">' + SC.fmtEcart(r) + '</span>';
    }
    if (l.hlr && l.sens === 'D' && e.cle !== 'supprime') return '<span class="ec hlr"><small>HLR</small>' + esc(l.hlr) + '</span>';
    return '<span></span>';
  }
  function celluleHeure(l, barre) {
    var h = l.reel ? hm(l.reel) : hm(l.theo);
    if (!h) return '<span class="h">—</span>';
    return '<span class="h' + (barre ? ' barre' : '') + '">' + h + '<small>' + (l.reel ? 'réel' : 'prévu') + '</small></span>';
  }
  function celluleEtat(e) {
    // barre de progression seulement pour un vrai départ (en route), pas pour un simple horaire prévu
    var avance = e.cle === 'route' ? e.progression : null;
    var barre = avance != null ? '<span class="avance" style="width:' + Math.round(avance * 100) + '%"></span>' : '';
    var sous = e.sous ? '<small class="sous">' + dfl(esc(e.sous) + (e.eta && e.cle !== 'attendu' && e.cle !== 'retard' ? ' · arr. ' + hm(e.eta) : '')) + '</small>' : '';
    // urgent : 5 minutes ou moins, clignote en rouge
    return '<span class="etat"><span class="st ' + e.cle + (e.urgent ? ' urgent' : '') + '">' + esc(e.libelle) + barre + '</span>' + sous + '</span>';
  }
  /**
   * Voie : plus petite au-delà de 4 caractères (VF2,4) ; voies multiples (VR5+VF3) sur deux lignes, coupées au séparateur
   * le plus proche du milieu. Ce qui ne tient toujours pas est resserré ou défile (voir defiler).
   */
  function celluleVoie(l, masquer) {
    var v = masquer ? '' : String(l.voie || '').trim(), coupe = -1;
    if (v.length > 5) {
      v.replace(/[+,\/ ]/g, function (s, i) {
        if (i > 0 && i < v.length - 1 && (coupe < 0 || Math.abs(i - v.length / 2) < Math.abs(coupe - v.length / 2))) coupe = i;
        return s;
      });
    }
    if (coupe > 0) return '<span class="vo duo"><span>' + dfl(esc(v.slice(0, coupe + 1).trim())) + '</span><span>' + dfl(esc(v.slice(coupe + 1).trim())) + '</span></span>';
    return '<span class="vo' + (v.length > 4 ? ' long' : '') + '">' + dfl(esc(v)) + '</span>';
  }
  /** Trains de ligne : toujours l'heure prévue ; l'heure réelle est dans l'état (« Parti 10:02 », « Arrivée 10:42 »). */
  function celluleHeureTrain(l, barre) {
    var h = hm(l.theo);
    return '<span class="h' + (barre ? ' barre' : '') + '">' + (h || '—') + '</span>';
  }

  // ------------------------------------------- départs des trains : volets
  /** Libellé des volets, court comme sur un tableau d'aéroport (arrivée : le compte à rebours en route aussi). */
  function texteVolets(e, arrivee) {
    var court = arrivee ? { prevu: 'Prévu', supprime: 'Supprimé', deja: 'Déjà là', attendu: 'Attendue', imminent: 'Imminente' }[e.cle]
      : { prevu: 'Prévu', supprime: 'Supprimé', deja: 'Déjà là', attendu: 'Départ attendu' }[e.cle];
    if (court) return court;
    if (e.cle === 'bientot') return 'Dans ' + e.minutes + ' min';
    var n = /(\d+) min/.exec(e.libelle);
    if (e.cle === 'route' && n) return 'Dans ' + n[1] + ' min';
    if (e.cle === 'fa') return e.libelle.replace(' depuis', '');
    return e.libelle;
  }
  /** Ligne sous les volets d'une arrivée : en approche, heure d'arrivée estimée ou prévue. */
  function sousVoletsArrivee(e) {
    if (e.cle === 'route') return 'En approche' + (e.eta ? ' · arr. ' + hm(e.eta) : '');
    if (e.cle === 'imminent' && e.eta) return 'arr. ' + hm(e.eta);
    return e.sous || '';
  }
  /**
   * Dernier texte affiché par départ ou arrivée : seules les lettres qui changent tournent, une fois.
   * Arrivées : rotation plus lente (classe « lent »).
   */
  var volets = {};
  function celluleVolets(cle, e, arrivee) {
    var texte = texteVolets(e, arrivee).toUpperCase(), sig = e.cle + (e.urgent ? ' urgent' : '') + '|' + texte, v = volets[cle];
    if (!v || v.sig !== sig) {
      var avant = v ? v.texte : '';
      var lettres = texte.split('').map(function (ch, i) {
        return '<b' + (ch !== avant.charAt(i) ? ' class="f" style="--i:' + i + '"' : '') + '>' + (ch === ' ' ? '' : esc(ch)) + '</b>';
      }).join('');
      // volets aussi grands que la case le permet (13,9 rem utiles, volet de 0,8 em + 0,1 rem d'écart)
      var taille = Math.min(1.45, (13.9 / Math.max(1, texte.length) - 0.1) / 0.8).toFixed(2);
      v = volets[cle] = { sig: sig, texte: texte, html: '<span class="sf ' + e.cle + (e.urgent ? ' urgent' : '') + (arrivee ? ' lent' : '') + '" style="font-size:' + taille + 'rem" title="' + esc(e.libelle) + '">' + lettres + '</span>' };
    }
    var sous = arrivee ? sousVoletsArrivee(e) : e.sous;
    return '<span class="etat volets">' + v.html + (sous ? '<small class="sous">' + dfl(esc(sous)) + '</small>' : '') + '</span>';
  }
  /** Texte qui peut dépasser de sa case : défile doucement (voir defiler). */
  function dfl(html) { return html ? '<span class="dfl">' + html + '</span>' : ''; }

  // ------------------------------------------------------------- navettes
  function rvb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return null;
    var n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function melange(a, b, part) { return a.map(function (v, i) { return Math.round(v * part + b[i] * (1 - part)); }); }
  function enHex(c) { return '#' + c.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  /** Encre la plus lisible sur un fond (contraste WCAG), blanc à contraste presque égal. */
  function encreSur(fond) {
    if (!fond) return '#ffffff';
    var l = fond.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    var lum = 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
    return (lum + 0.05) / 0.0555 > 1.05 / (lum + 0.05) + 0.3 ? '#14100a' : '#ffffff';
  }
  /** Fond des lignes de départ (couleur pleine) et d'arrivée (un ton plus sombre), encre commune au groupe. */
  function couleursGroupe(el, hex) {
    var c = rvb(hex) || [242, 140, 40], dep = melange(c, [0, 0, 0], 0.86), arr = melange(c, [13, 26, 38], 0.68);
    el.style.setProperty('--c', enHex(c));
    el.style.setProperty('--ce', encreSur(c));
    el.style.setProperty('--fd', enHex(dep));
    el.style.setProperty('--fa', enHex(arr));
    el.style.setProperty('--el', encreSur(dep));
  }
  function ligneNavette(l, parcours) {
    var e = SC.etatAffichage(l, maintenant(), etat.d.seuilRetardMinutes, parcours);
    // colonnes resserrées (sens sous le code, « wagons » sous le nombre) : la largeur gagnée grossit tout le texte
    return '<div class="r ' + (l.sens === 'D' ? 'dep' : 'arr') + (e.cle === 'supprime' ? ' supprimee' : '') + '" data-k="' + esc(l.id) + '">' +
      '<span class="code"><b' + (e.cle === 'supprime' ? ' class="barre"' : '') + '>' + esc(l.code) + '</b><small>' + (l.sens === 'D' ? 'dép.' : 'arr.') + '</small></span>' +
      celluleHeure(l, e.cle === 'supprime') + celluleEcart(l, e) +
      '<span class="wg">' + (l.wagons != null ? esc(l.wagons) + '<small>wagons</small>' : '') + '</span>' +
      celluleVoie(l) + celluleEtat(e) + '</div>';
  }
  function carteProchaine(l) {
    var detail = [l.wagons != null ? l.wagons + ' wagons' : '', l.voie || ''].filter(Boolean).join(' · ');
    return '<div class="rot' + (l.etat === 'supprime' ? ' supprimee' : '') + '"><div class="rl"><b>' + esc(l.code) + '</b><span>' + esc(hm(l.theo) || '—') + '</span></div>' +
      (detail ? '<i>' + dfl(esc(detail)) + '</i>' : '') + '</div>';
  }
  /** Prochaines navettes : les départs seulement (LF1, LF2…), quatre par rangée, puis le texte libre de la saisie. */
  function blocProchaines(g) {
    var liste = g.demain || [], departs = liste.filter(function (l) { return l.sens === 'D'; });
    var cartes = (departs.length ? departs : liste).map(carteProchaine);
    // demainLibelle absent : diffusion publiée par une saisie pas encore rechargée
    var libelle = g.demainLibelle || (liste.length ? 'Demain · ' + (etat.d.demain || '') : '');
    // jour suivant (après-demain) : mêmes cartes (heure, wagons, voie), en plus petit
    var ensuite = '';
    if (g.ensuite && g.ensuite.lignes && g.ensuite.lignes.length) {
      var dep2 = g.ensuite.lignes.filter(function (l) { return l.sens === 'D'; }), liste2 = dep2.length ? dep2 : g.ensuite.lignes;
      ensuite = '<div class="demain-tete petit">' + esc(g.ensuite.libelle) + '</div><div class="rots petit" style="--r:' + Math.min(4, liste2.length) + '">' + liste2.map(carteProchaine).join('') + '</div>';
    }
    return '<div class="demain"><div class="demain-tete">Prochaines navettes' + (libelle ? ' · ' + esc(libelle) : '') + '</div>' +
      (cartes.length ? '<div class="rots" style="--r:' + Math.min(4, cartes.length) + '">' + cartes.join('') + '</div>' : '') + ensuite +
      (g.demainNote ? '<div class="demain-note">' + esc(g.demainNote) + '</div>' : '') + '</div>';
  }
  function blocNavettes(g) {
    var fait = g.lignes.filter(function (l) { return l.reel; }).length;
    var html = '<div class="nav-tete"><h2>' + esc(g.libelle) + '</h2><span>' + (g.lignes.length ? fait + ' / ' + g.lignes.length + ' réalisées' : 'aucune aujourd\'hui') + '</span></div>';
    if (g.lignes.length) {
      html += '<div class="cols"><span>Code</span><span>Heure</span><span>Écart</span><span>Wagons</span><span>Voie</span><span>État</span></div>' +
        '<div class="lignes">' + g.lignes.map(function (l) { return ligneNavette(l, g.parcours); }).join('') + '</div>';
    }
    if ((g.demain && g.demain.length) || g.demainNote) html += blocProchaines(g);
    else if (!g.lignes.length) html += '<div class="vide">Aucune navette prévue.</div>';
    return html;
  }

  // ------------------------------------------------------- trains de ligne
  /** Couleur du nom de l'EF au centre : Naviland violet clair, Ferovergne vert, les autres bleu clair. */
  function couleurEF(ef) {
    var e = String(ef || '').toUpperCase();
    return /NAVILAND/.test(e) ? '#B79CFF' : /FER+OVERGNE/.test(e) ? '#22B573' : '#8FD0FA';
  }
  function ligneTrain(t) {
    var a = t.arrivee, d = t.depart, s = etat.d.seuilRetardMinutes, n = maintenant();
    var ea = a ? SC.etatAffichage(a, n, s, t.parcours) : null, ed = d ? SC.etatAffichage(d, n, s) : null;
    var nom = t.nom || t.code, c = couleurEF(t.groupe);
    var arr = a ? '<span class="num' + (ea.cle === 'supprime' ? ' barre' : '') + '">' + esc(a.numero || '') + '</span>' + celluleVolets((a.id || t.code) + '|arrivée', ea, true) +
      celluleHeureTrain(a, ea.cle === 'supprime') + celluleVoie(a, ea.cle === 'supprime')
      : '<span></span><span></span><span></span><span></span>';
    // au centre : provenance à gauche, entreprise au milieu, destination à droite
    var centre = '<span class="tcentre"><span class="tville">' + (a ? '<small>En provenance de</small>' + esc(nom) : '') + '</span>' +
      '<span class="tef">' + esc(t.groupe) + '</span>' +
      '<span class="tville dest">' + (d ? '<small>À destination de</small>' + esc(nom) : '') + '</span></span>';
    var dep = d ? '<span class="num' + (ed.cle === 'supprime' ? ' barre' : '') + '">' + esc(d.numero || '') + '</span>' + celluleHeureTrain(d, ed.cle === 'supprime') +
      '<span class="ec hlr">' + (d.hlr && !d.reel && ed.cle !== 'supprime' ? esc(d.hlr) : '') + '</span>' +
      celluleVoie(d, ed.cle === 'supprime') + celluleVolets(d.id || t.code, ed)
      : '<span></span><span></span><span></span><span></span><span></span>';
    return '<div class="t" style="--c:' + c + '" data-k="' +
      esc(t.groupe + '|' + t.code + '|' + ((a && a.id) || '') + '|' + ((d && d.id) || '')) + '">' + arr + centre + dep + '</div>';
  }
  function blocTrains(trains) {
    return '<div class="p-tete"><h2>Trains de ligne</h2><span>Arrivée · train · départ</span></div>' +
      (trains.length ? '<div class="tcols"><span>N°</span><span>Arrivée</span><span>Heure</span><span>Voie</span><span class="c">Provenance · entreprise · destination</span>' +
        '<span>N°</span><span>Heure</span><span>HLR</span><span>Voie</span><span>Départ</span></div>' +
        '<div class="lignes">' + trains.map(ligneTrain).join('') + '</div>'
        : '<div class="vide">Aucun train de ligne prévu aujourd\'hui.</div>');
  }


  // ======================================================= VEDETTES (écran dynamique)
  /*
   * Une navette ou un train qui part / arrive dans les prochaines minutes (ou qui vient de le faire) passe « en vedette » :
   * - navettes : son carré, à la couleur du groupe, prend toute la partie haute de l'écran ; plusieurs en même temps se
   *   partagent la largeur ; une fois terminé (1 min après), retour aux fenêtres TDF / TN / ATL ;
   * - trains de ligne : une bande animée (train qui entre ou qui sort) recouvre la partie basse ; plusieurs = empilées.
   * Réglages par l'adresse de la page : ?avant=5 (minutes avant), ?apres=1 (minutes après), ?vedette=0 pour désactiver,
   * ?horizon=180 (fenêtre d'un groupe agrandie s'il a une navette dans les 180 min), ?groupes=tous (toujours tout afficher),
   * ?demo=1 (démonstration autonome, sans serveur).
   */
  function paramNum(nom, defaut) { var m = new RegExp('[?&]' + nom + '=([\\d.]+)').exec(location.search); return m ? +m[1] : defaut; }
  var DEMO = /[?&]demo=1\b/.test(location.search);
  var VED = {
    actif: !/[?&]vedette=0\b/.test(location.search),
    avant: paramNum('avant', DEMO ? 1.5 : 5),
    apres: paramNum('apres', DEMO ? 0.5 : 1),
    apresDepart: paramNum('apresDepart', 10),
    // « ✓ Partie / Arrivée » gardé en grand au moins `garde` secondes à partir du moment où l'écran voit la validation
    // (l'heure réelle venant du Suivi trains est à la minute près et arrive avec quelques secondes de décalage)
    garde: paramNum('garde', 5),
    horizon: paramNum('horizon', DEMO ? 2.5 : 180),
    fini: paramNum('fini', DEMO ? 20 : 60),
    tousGroupes: /[?&]groupes=tous\b/.test(location.search)
  };
  function dateIso(s) { var p = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec(s || ''); return p ? new Date(+p[1], +p[2] - 1, +p[3], +p[4], +p[5], +(p[6] || 0)) : null; }
  function secAvant(cible) { var d = dateIso(cible); return d ? (d.getTime() - Date.now()) / 1000 : null; }
  /**
   * Phase « vedette » d'une ligne (navette ou train), ou null. Seulement sur des événements réels, jamais sur l'heure
   * théorique :
   * - arrivée : en route (partie de son terminal / de FA, 1 min) puis en approche (5 dernières minutes avant l'arrivée
   *   estimée), jusqu'à l'arrivée ;
   * - départ d'un train : dès « Annoncé Bon au départ » reçu du Suivi trains (ou étapes suivantes) ;
   * - départ d'une navette : dès le ▲ « annoncer le départ » de la saisie ;
   * - une fois parti, « ✓ Parti » quelques secondes (apresDepart, 10 s) puis retour à l'écran principal.
   */
  var BON_DEPART = /bon au d[eé]part|r[eé]gulateur|ouverture du signal/i;
  var reelPrecedent = {}, faitVuA = {};
  function phaseVedette(l, parcours) {
    if (!l || l.etat === 'supprime' || l.etat === 'deja') return null;
    var arr = l.sens !== 'D', avant = VED.avant * 60, cleL = l.id || (l.code + '|' + l.sens);
    // passage « pas encore fait » → « fait » vu par cet écran : on retient l'instant (pas au démarrage de l'écran)
    var avantReel = reelPrecedent[cleL];
    reelPrecedent[cleL] = l.reel || '';
    if (l.reel && avantReel === '' && !faitVuA[cleL + '|' + l.reel]) faitVuA[cleL + '|' + l.reel] = Date.now();
    if (l.reel) {
      var depuis = -secAvant(l.reel), duree = arr ? VED.apres * 60 : VED.apresDepart;
      var vu = faitVuA[cleL + '|' + l.reel], vuDepuis = vu ? (Date.now() - vu) / 1000 : Infinity;
      return (depuis >= 0 && depuis <= duree) || vuDepuis <= VED.garde ? { cle: 'fait', heure: l.reel, sec: depuis } : null;
    }
    if (arr) {
      if (!l.partie) return null;
      var trajet = ((parcours && parcours.trajet) || 35) * 60;
      var eta = l.eta || SC.iso(new Date(dateIso(l.partie).getTime() + trajet * 1000));
      var reste = secAvant(eta), depuisPartie = -secAvant(l.partie);
      if (reste <= avant && reste >= -15 * 60) return { cle: 'approche', heure: eta, sec: reste };
      if (depuisPartie >= 0 && depuisPartie <= VED.apres * 60) return { cle: 'partie', heure: l.partie, sec: reste, eta: eta };
      return null;
    }
    if (l.cale) return null;
    if (l.annonceTV) return { cle: 'bientot', heure: l.annonceTV, sec: null, motif: 'Départ annoncé à ' + hm(l.annonceTV) };
    if (l.etape && BON_DEPART.test(String(l.etape.lib || ''))) return { cle: 'bientot', heure: null, sec: null, motif: l.etape.lib + (l.etape.h ? ' à ' + l.etape.h : '') };
    return null;
  }
  function compte(sec) {
    if (sec == null) return '';
    var a = Math.max(0, Math.round(Math.abs(sec)));
    if (a < 60) return a + ' s';
    var m = Math.floor(a / 60), r = a % 60;
    return m + ' min' + (m < 3 && r ? ' ' + (r < 10 ? '0' : '') + r + ' s' : '');
  }
  /** Phrase principale et sous-titre d'une vedette. */
  function textesVedette(ph, arr) {
    if (ph.cle === 'fait') return { gros: arr ? 'Arrivée' : (ph.train ? 'Parti' : 'Partie'), sous: hm(ph.heure), fait: true };
    if (ph.cle === 'partie') return { gros: 'En route', sous: 'arrivée prévue ' + hm(ph.eta) + ' · dans ' + compte(ph.sec) };
    if (arr) return ph.sec != null && ph.sec > 0 ? { gros: 'Arrive dans', sous: compte(ph.sec) } : { gros: 'Arrivée imminente', sous: ph.heure ? 'estimée ' + hm(ph.heure) : '' };
    return { gros: 'Départ imminent', sous: ph.motif || '' };
  }
  var SVG_TRAIN = '<svg class="ved-loco" viewBox="0 0 160 46" aria-hidden="true"><rect x="2" y="8" width="96" height="28" rx="5"/><rect x="100" y="12" width="56" height="24" rx="4"/>' +
    '<path d="M98 36h4M2 36h156" stroke="currentColor" stroke-width="2"/><rect x="10" y="14" width="18" height="10" rx="2" class="vit"/><rect x="34" y="14" width="18" height="10" rx="2" class="vit"/>' +
    '<rect x="58" y="14" width="18" height="10" rx="2" class="vit"/><circle cx="20" cy="40" r="5"/><circle cx="80" cy="40" r="5"/><circle cx="115" cy="40" r="5"/><circle cx="142" cy="40" r="5"/></svg>';
  /** Carré géant d'une navette en vedette. */
  function tuileNavette(v) {
    var l = v.l, arr = l.sens !== 'D', t = textesVedette(v.ph, arr);
    var detail = [l.wagons != null ? l.wagons + ' wagons' : '', l.numero ? 'n° ' + l.numero : ''].filter(Boolean).join(' · ');
    var urgent = !t.fait && (v.ph.sec == null ? !arr : v.ph.sec <= 60);
    return '<div class="ved-tuile ' + (arr ? 'arr' : 'dep') + ' ' + v.ph.cle + (urgent ? ' urgent' : '') + '" style="--c:' + v.g.couleur + ';--ce:' + encreSur(rvb(v.g.couleur)) + '">' +
      '<div class="ved-groupe">' + esc(v.g.libelle) + '</div>' +
      '<div class="ved-code">' + esc(l.code) + '</div>' +
      '<div class="ved-sens">' + (arr ? '▼ Arrivée' : '▲ Départ') + (l.theo ? ' · prévu ' + hm(l.theo) : '') + '</div>' +
      '<div class="ved-gros">' + (t.fait ? '✓ ' : '') + esc(t.gros) + '</div>' +
      '<div class="ved-sous">' + esc(t.sous) + '</div>' +
      (l.voie ? '<div class="ved-voie"><small>Voie</small>' + esc(l.voie) + '</div>' : '') +
      (detail ? '<div class="ved-detail">' + esc(detail) + '</div>' : '') +
      '<div class="ved-rail ' + (arr ? 'entre' : 'sort') + (t.fait ? ' fini' : '') + '">' + SVG_TRAIN + '</div></div>';
  }
  /** Bande animée d'un train de ligne en vedette. */
  function bandeTrain(v) {
    var l = v.l, arr = l.sens !== 'D', t = textesVedette(v.ph, arr), c = couleurEF(v.t.groupe);
    var urgent = !t.fait && (v.ph.sec == null ? !arr : v.ph.sec <= 60);
    return '<div class="ved-bande ' + (arr ? 'arr' : 'dep') + ' ' + v.ph.cle + (urgent ? ' urgent' : '') + '" style="--c:' + c + '">' +
      '<div class="ved-b-sens">' + (arr ? '▼<b>Arrivée</b>' : '▲<b>Départ</b>') + '</div>' +
      '<div class="ved-b-id"><span class="ved-b-num">' + esc(l.numero || v.t.code) + '</span><span class="ved-b-ef">' + esc(v.t.groupe) + '</span></div>' +
      '<div class="ved-b-ville"><small>' + (arr ? 'En provenance de' : 'À destination de') + '</small>' + esc(v.t.nom || v.t.code) + '</div>' +
      '<div class="ved-b-etat"><b>' + (t.fait ? '✓ ' : '') + esc(t.gros) + '</b><span>' + esc(t.sous) + '</span></div>' +
      '<div class="ved-b-voie">' + (l.voie ? '<small>Voie</small>' + esc(l.voie) : '') + '</div>' +
      '<div class="ved-rail ' + (arr ? 'entre' : 'sort') + (t.fait ? ' fini' : '') + '">' + SVG_TRAIN + '</div></div>';
  }
  function vedettesNavettes(d) {
    var out = [];
    (d.navettes || []).forEach(function (g) {
      g.lignes.forEach(function (l) { var ph = phaseVedette(l, g.parcours); if (ph) out.push({ g: g, l: l, ph: ph }); });
    });
    return out.sort(function (a, b) { return (a.ph.sec == null ? 0 : a.ph.sec) - (b.ph.sec == null ? 0 : b.ph.sec); });
  }
  function vedettesTrains(d) {
    var out = [];
    (d.trains || []).forEach(function (t) {
      [t.arrivee, t.depart].forEach(function (l) {
        var ph = phaseVedette(l, l && l.sens !== 'D' ? t.parcours : null);
        if (ph) { ph.train = true; out.push({ t: t, l: l, ph: ph }); }
      });
    });
    return out.sort(function (a, b) { return (a.ph.sec == null ? 0 : a.ph.sec) - (b.ph.sec == null ? 0 : b.ph.sec); });
  }
  var dernierVed = { nav: '', trains: '' };
  function majVedettes() {
    var d = etat.d, cNav = $('#v-ved-nav'), cTr = $('#v-ved-trains'), grille = $('#v-grille');
    if (!cNav || !cTr) return;
    if (!d || !VED.actif) { cNav.hidden = cTr.hidden = true; grille.classList.remove('ved-nav-on', 'ved-trains-on'); return; }
    var vn = vue === 'trains' ? [] : vedettesNavettes(d), vt = vue === 'navettes' ? [] : vedettesTrains(d);
    // navettes : 4 carrés au plus côte à côte (les plus proches) ; le reste est compté
    var htmlNav = vn.length ? '<div class="ved-tuiles" style="--n:' + Math.min(4, vn.length) + '">' + vn.slice(0, 4).map(tuileNavette).join('') + '</div>' +
      (vn.length > 4 ? '<div class="ved-plus">+ ' + (vn.length - 4) + ' autre(s)</div>' : '') : '';
    var htmlTr = vt.length ? '<div class="ved-bandes" style="--n:' + Math.min(3, vt.length) + '">' + vt.slice(0, 3).map(bandeTrain).join('') + '</div>' : '';
    // positions mesurées à l'écran (les navettes peuvent être agrandies par zoom), relatives à la grille
    var rg = grille.getBoundingClientRect(), rn = $('#v-navettes').getBoundingClientRect(), rt = $('#v-trains').getBoundingClientRect();
    var avecTrains = vue !== 'navettes' && rt.height > 0;
    var poser = function (calque, haut, bas, gauche, largeur) {
      calque.style.top = Math.max(0, haut) + 'px'; calque.style.height = Math.max(0, bas - haut) + 'px';
      calque.style.left = gauche + 'px'; calque.style.width = largeur + 'px';
    };
    var limiteNav = Infinity;
    if (htmlTr) {
      if (htmlTr !== dernierVed.trains) { cTr.innerHTML = htmlTr; dernierVed.trains = htmlTr; }
      // au moins 40 % de la hauteur : la bande doit se voir de loin, même si le panneau des trains est petit
      var basTr = rt.bottom - rg.top, hautTr = Math.min(rt.top - rg.top, basTr - rg.height * 0.4);
      poser(cTr, hautTr, basTr, rt.left - rg.left, rt.width);
      limiteNav = Math.min(limiteNav, hautTr - 10);
      cTr.hidden = false;
    } else { cTr.hidden = true; dernierVed.trains = ''; }
    if (htmlNav) {
      if (htmlNav !== dernierVed.nav) { cNav.innerHTML = htmlNav; dernierVed.nav = htmlNav; }
      // toute la partie haute : du haut des navettes jusqu'aux trains de ligne (ou jusqu'en bas sans trains)
      var basNav = Math.min(avecTrains ? rt.top - rg.top - 10 : rg.height - 10, limiteNav);
      poser(cNav, rn.top - rg.top, htmlTr ? basNav : Math.max(rn.bottom - rg.top, basNav), rn.left - rg.left, rn.width || rg.width);
      cNav.hidden = false;
    } else { cNav.hidden = true; dernierVed.nav = ''; }
    grille.classList.toggle('ved-nav-on', !!htmlNav);
    grille.classList.toggle('ved-trains-on', !!htmlTr);
  }

  // =========================================== fenêtres navettes : 2 ou 3 selon l'heure
  /**
   * Un groupe a une grande fenêtre s'il a une navette à faire dans les `horizon` minutes (ou en route, ou terminée il y a
   * moins de 20 min). Sinon il passe en colonne étroite « au repos » : prochaine navette du jour et coupons de demain /
   * après-demain (Prochaines navettes) ; sans rien à montrer, il disparaît. Le matin (TDF + TN seulement), 2 fenêtres ;
   * l'après-midi, ATL revient dès que sa navette approche.
   */
  /** Toutes les navettes du jour réalisées (ou supprimées / déjà là) : heure de la dernière, sinon null. */
  function finDuJour(g) {
    var faites = g.lignes.filter(function (l) { return l.etat !== 'supprime' && l.etat !== 'nonprevu'; });
    if (!faites.length || faites.some(function (l) { return !l.reel && l.etat !== 'deja'; })) return null;
    return faites.reduce(function (m, l) { var r = dateIso(l.reel); return r && (!m || r > m) ? r : m; }, null) || new Date(0);
  }
  function etatGroupe(g) {
    // terminé pour la journée : petite colonne dès la fin de la dernière vedette (?fini=60 secondes après la dernière)
    var fin = finDuJour(g);
    if (fin && Date.now() - fin.getTime() >= VED.fini * 1000) return 'fini';
    if (VED.tousGroupes) return 'actif';
    var maintenantMs = Date.now(), hor = VED.horizon * 60000, prochaine = null, actif = false;
    g.lignes.forEach(function (l) {
      if (l.etat === 'supprime') return;
      if (l.reel) { var r = dateIso(l.reel); if (r && maintenantMs - r.getTime() < 20 * 60000) actif = true; return; }
      if (l.partie) { actif = true; return; }
      var t = dateIso(l.theo);
      if (!t) return;
      if (t.getTime() - maintenantMs <= hor) actif = true;
      if (!prochaine || t < prochaine) prochaine = t;
    });
    if (actif) return 'actif';
    var aDemain = (g.demain && g.demain.length) || (g.ensuite && g.ensuite.lignes && g.ensuite.lignes.length) || g.demainNote;
    if (prochaine || aDemain) return 'repos';
    return g.lignes.length ? 'repos' : 'cache';
  }
  /** Groupe terminé : « ✓ Terminé pour la journée », les navettes réalisées, puis les prochaines (demain…). */
  function blocFini(g) {
    var vues = {}, codes = g.lignes.slice().sort(function (a, b) { return (a.theo || '') < (b.theo || '') ? -1 : 1; }).filter(function (l) {
      if (l.etat === 'nonprevu' || vues[l.code]) return false; vues[l.code] = true; return true;
    });
    var html = '<div class="nav-tete"><h2>' + esc(g.libelle) + '</h2><span class="fini-badge">✓ terminé</span></div>' +
      '<div class="fini"><div class="fini-tete"><span class="fini-ok">✓</span><span>Terminé pour la journée</span></div>' +
      '<div class="fini-codes">' + codes.map(function (l) {
        var sup = l.etat === 'supprime';
        return '<span class="fc' + (sup ? ' sup' : '') + '"><i>' + (sup ? '✕' : '✓') + '</i>' + esc(l.code) + '</span>';
      }).join('') + '</div></div>';
    if ((g.demain && g.demain.length) || g.demainNote || (g.ensuite && g.ensuite.lignes && g.ensuite.lignes.length)) html += blocProchaines(g);
    return html;
  }
  function blocRepos(g) {
    var restantes = g.lignes.filter(function (l) { return !l.reel && l.etat !== 'supprime'; });
    var p = restantes[0];
    var html = '<div class="nav-tete"><h2>' + esc(g.libelle) + '</h2><span>' + (p ? 'plus tard' : 'terminé') + '</span></div>' +
      '<div class="repos-info">' + (p ? 'Prochaine : <b>' + esc(p.code) + '</b> à <b>' + esc(hm(p.theo) || '—') + '</b>' + (restantes.length > 1 ? ' <small>(+' + (restantes.length - 1) + ')</small>' : '')
        : (g.lignes.length ? 'Navettes du jour terminées' : 'Pas de navette aujourd\'hui')) + '</div>';
    if ((g.demain && g.demain.length) || g.demainNote || (g.ensuite && g.ensuite.lignes && g.ensuite.lignes.length)) html += blocProchaines(g);
    return html;
  }

  // ================================================================ DÉMO
  /** Journée simulée qui tourne en boucle (5 min) : départs et arrivées simultanés, ATL qui arrive en cours de cycle. */
  function diffusionDemo() {
    var C = 420, t0 = Math.floor(Date.now() / 1000 / C) * C * 1000;
    var at = function (s) { return SC.iso(new Date(t0 + s * 1000)); };
    var passe = function (s) { return Date.now() >= t0 + s * 1000; };
    var reel = function (s) { return passe(s) ? at(s) : null; };
    var bon = function (s) { return passe(s) ? { lib: 'Annoncé Bon au départ', h: SC.hm(at(s)) } : null; };
    var demain = SC.iso(new Date(Date.now() + 864e5)).slice(0, 10), apres = SC.iso(new Date(Date.now() + 2 * 864e5)).slice(0, 10);
    var carte = function (code, h, w, v, jour) { return { id: code + jour, code: code, sens: 'D', theo: jour + 'T' + h + ':00', wagons: w, voie: v }; };
    var ln = function (id, code, sens, theoS, o) { o = o || {}; return Object.assign({ id: id, code: code, sens: sens, theo: at(theoS), hlr: '', annonce: false, annonceTV: null, reel: null, wagons: 18, voie: 'VF3', partie: null, eta: null, fa: null, etape: null, cale: null, etat: null }, o); };
    var pass = [{ lib: 'Départ FS', min: 0.3 }, { lib: 'Entrée GB', min: 1 }, { lib: 'Sortie GB', min: 1.6 }];
    var nav = [
      { id: 'TDF', libelle: 'TDF', couleur: '#F28C28', parcours: { trajet: 2, passages: pass }, lignes: [
        ln('fl1', 'FL1', 'A', -200, { reel: at(-190), wagons: 20, voie: 'VR2' }),
        ln('lf1', 'LF1', 'D', 160, { annonceTV: passe(165) ? null : reel(110), reel: reel(165), wagons: 22, voie: 'VF3' }),
        ln('fl2', 'FL2', 'A', 290, { partie: reel(150), eta: at(280), reel: reel(285), wagons: 16, voie: 'VR4' }),
        ln('lf2', 'LF2', 'D', 990, { wagons: 18, voie: 'VF1' })],
        demain: [carte('LF1', '06:10', 22, 'VF3', demain), carte('LF2', '09:40', 18, 'VF1', demain), carte('LF3', '13:20', 20, 'VF2', demain)],
        demainLibelle: 'Demain', ensuite: { libelle: 'Après-demain', lignes: [carte('LF1', '06:10', 21, 'VF3', apres), carte('LF2', '09:40', 19, 'VF1', apres)] } },
      { id: 'TN', libelle: 'TN', couleur: '#2D8CFF', parcours: { trajet: 2, passages: pass }, lignes: [
        ln('nl0', 'NL0', 'A', -320, { reel: at(-300), wagons: 21, voie: 'VR1' }),
        ln('ln1', 'LN1', 'D', 160, { annonceTV: passe(170) ? null : reel(115), reel: reel(170), wagons: 24, voie: 'VF5' }),
        ln('nl1', 'NL1', 'A', 230, { partie: reel(110), eta: at(230), reel: reel(235), wagons: 19, voie: 'VR1' }),
        ln('ln2', 'LN2', 'D', 1200, { wagons: 20, voie: 'VF5' })],
        demain: [carte('LN1', '07:00', 24, 'VF5', demain), carte('LN2', '14:30', 20, 'VF5', demain)], demainLibelle: 'Demain',
        ensuite: { libelle: 'Après-demain', lignes: [carte('LN1', '07:00', 23, 'VF5', apres)] } },
      { id: 'ATL', libelle: 'ATL', couleur: '#F2C230', parcours: { trajet: 2, passages: pass }, lignes: [
        ln('la2', 'LA2', 'D', 340, { annonceTV: passe(345) ? null : reel(300), reel: reel(345), wagons: 14, voie: 'VF7' })],
        demain: [carte('LA1', '08:15', 15, 'VF7', demain)], demainLibelle: 'Demain', ensuite: null }
    ];
    var tr = [
      { groupe: 'NAVILAND', code: 'VNX', nom: 'Vénissieux', parcours: { trajet: 2.5, passages: [] },
        arrivee: ln('vnx-a', 'VNX', 'A', 250, { numero: '50237', partie: reel(100), eta: at(250), reel: reel(255), voie: 'VR5' }),
        depart: ln('vnx-d', 'VNX', 'D', 370, { numero: '50238', etape: passe(375) ? null : bon(330), reel: reel(375), voie: 'VR5', hlr: '' }) },
      { groupe: 'FEROVERGNE', code: 'CLERMT', nom: 'Clermont-Ferrand', parcours: { trajet: 3, passages: [] },
        arrivee: null, depart: ln('cf-d', 'CLERMT', 'D', 250, { numero: '52232', etape: passe(260) ? null : bon(200), reel: reel(260), voie: 'VF2' }) },
      { groupe: 'NAVILAND', code: 'BDX', nom: 'Bordeaux', parcours: { trajet: 3, passages: [] },
        arrivee: ln('bdx-a', 'BDX', 'A', 3000, { numero: '50275', voie: 'VR3' }), depart: ln('bdx-d', 'BDX', 'D', 5000, { numero: '50276', voie: 'VR3' }) }
    ];
    var jour = SC.cleDate(new Date());
    return { schema: 1, date: jour, jour: SC.libelleJour(jour), demain: 'Demain', titre: 'Circulations du jour · DÉMO', seuilRetardMinutes: 15,
      vitesseFlash: 90, alerteSansNouvellesSecondes: 45, version: 1, publieA: SC.iso(new Date()), navettes: nav, trains: tr,
      flash: { texte: 'DÉMONSTRATION : départs et arrivées simulés en boucle toutes les 7 minutes (navettes en haut, trains en bas).' } };
  }

  // ------------------------------------------------ mises à jour sans clignotement
  /** Remplace seulement ce qui a changé ; une ligne identique garde son animation en cours. */
  function majBloc(el, html) {
    if (el.__html === html) return false;
    var tmp = document.createElement('div'); tmp.innerHTML = html;
    var anc = el.querySelector('.lignes'), neu = tmp.querySelector('.lignes');
    var memeStructure = anc && neu && el.children.length === tmp.children.length &&
      Array.prototype.every.call(tmp.children, function (c, i) { return c.className === el.children[i].className; });
    if (memeStructure && anc.children.length === neu.children.length &&
      Array.prototype.every.call(neu.children, function (c, i) { return c.getAttribute('data-k') === anc.children[i].getAttribute('data-k'); })) {
      Array.prototype.forEach.call(tmp.children, function (c, i) { if (c.className !== 'lignes') majElement(el.children[i], c); });
      Array.prototype.forEach.call(neu.children, function (c, i) { majElement(anc.children[i], c); });
    } else {
      el.innerHTML = html;
    }
    el.__html = html;
    return true;
  }
  /**
   * Ligne changée : seules ses cases changées sont remplacées. Le reste continue son animation
   * (défilement d'une voie, clignotement, volets) au lieu de repartir de zéro à chaque minute.
   */
  function majElement(anc, neu) {
    if (anc.outerHTML === neu.outerHTML) return;
    var cases = anc.tagName === neu.tagName && anc.children.length && anc.children.length === neu.children.length &&
      anc.childNodes.length === anc.children.length && neu.childNodes.length === neu.children.length &&
      Array.prototype.every.call(neu.children, function (c, i) { return c.tagName === anc.children[i].tagName; });
    if (!cases) { anc.parentNode.replaceChild(neu.cloneNode(true), anc); return; }
    Array.prototype.slice.call(neu.attributes).forEach(function (a) { if (anc.getAttribute(a.name) !== a.value) anc.setAttribute(a.name, a.value); });
    Array.prototype.slice.call(anc.attributes).forEach(function (a) { if (!neu.hasAttribute(a.name)) anc.removeAttribute(a.name); });
    Array.prototype.forEach.call(neu.children, function (c, i) { if (c.outerHTML !== anc.children[i].outerHTML) anc.replaceChild(c.cloneNode(true), anc.children[i]); });
  }
  function rendre() {
    var d = etat.d; if (!d) return;
    $('#ecran').classList.remove('sans-donnees');
    $('#v-titre').textContent = d.titre || 'Circulations du jour';
    $('#v-date').textContent = d.jour ? d.jour.charAt(0).toUpperCase() + d.jour.slice(1) : '';
    var grille = $('#v-grille');
    grille.classList.toggle('navettes-seules', vue === 'navettes');
    grille.classList.toggle('trains-seuls', vue === 'trains');
    var change = false, zone = $('#v-navettes');
    // 2 ou 3 grandes fenêtres selon l'heure : un groupe sans navette proche passe en colonne étroite « au repos »
    var tous = (d.navettes || []).map(function (g) { return { g: g, e: etatGroupe(g) }; }).filter(function (x) { return x.e !== 'cache'; });
    if (!tous.some(function (x) { return x.e === 'actif'; })) tous.forEach(function (x) { if (x.g.lignes.length && x.e !== 'fini') x.e = 'actif'; });
    var nav = tous.map(function (x) { return x.g; });
    zone.style.setProperty('--n', Math.max(1, nav.length));
    // tout terminé partout : les colonnes « terminé » se partagent la largeur
    var tousFinis = tous.every(function (x) { return x.e === 'fini'; });
    zone.style.gridTemplateColumns = tous.map(function (x) { return x.e === 'actif' || tousFinis ? 'minmax(0, 1fr)' : (x.e === 'fini' ? 'minmax(0, .45fr)' : 'minmax(0, .55fr)'); }).join(' ') || '';
    while (zone.children.length > nav.length) zone.removeChild(zone.lastChild);
    tous.forEach(function (x, i) {
      var g = x.g, el = zone.children[i];
      if (!el) { el = document.createElement('div'); zone.appendChild(el); }
      var cls = 'nav' + (x.e === 'repos' ? ' repos' : (x.e === 'fini' ? ' repos fini-jour' : ''));
      if (el.className !== cls) { el.className = cls; el.__html = null; }
      couleursGroupe(el, g.couleur);
      change = majBloc(el, x.e === 'fini' ? blocFini(g) : (x.e === 'repos' ? blocRepos(g) : blocNavettes(g))) || change;
    });
    var trains = $('#v-trains');
    trains.className = 'trains panneau';
    change = majBloc(trains, blocTrains(d.trains || [])) || change;
    majFlash(d.flash);
    if (change) ajuster();
    majVedettes();
  }

  // ------------------------------------------------------------- travaux
  /** Avis de travaux (envoyés par un autre service, voir Code.gs) : bandeau sous les tableaux, rouge puis orange. */
  var travauxCle = '';
  function majTravaux(liste) {
    liste = Array.isArray(liste) ? liste : [];
    var cle = JSON.stringify(liste);
    if (cle === travauxCle) return;
    travauxCle = cle;
    var bloc = $('#v-travaux'), t = $('#v-travaux-txt');
    bloc.hidden = !liste.length;
    bloc.className = 'travaux' + (liste.some(function (x) { return x.couleur === 'rouge'; }) ? ' rouge' : '');
    t.innerHTML = liste.map(function (x) {
      return '<span class="tx ' + esc(x.couleur) + '"><i></i>' + esc(x.texte) + (x.creneau ? ' <b class="tx-cr">' + esc(x.creneau) + '</b>' : '') + (x.message ? ' <em>(' + esc(x.message) + ')</em>' : '') + '</span>';
    }).join('');
    alerterTravaux(liste);
    t.style.animation = 'none';
    requestAnimationFrame(function () {
      var fen = $('#v-travaux-fen').clientWidth, large = t.scrollWidth;
      if (large > fen) {
        // trop long pour tenir : défile comme le flash info
        t.style.setProperty('--depart', fen + 'px'); t.style.setProperty('--fin', (-large) + 'px');
        t.style.setProperty('--duree', ((fen + large) / 80).toFixed(1) + 's');
        t.style.animation = '';
        t.classList.add('defile');
      } else t.classList.remove('defile');
      ajuster();
    });
  }

  /**
   * Nouvel avis (ou passage orange → rouge) : affiché en grand sur tout l'écran 5 secondes (?alerteTravaux=5), un après
   * l'autre, puis il reste dans le bandeau. Au démarrage de l'écran, seuls les avis reçus depuis moins de 2 minutes
   * s'affichent en grand.
   */
  var txVus = null, txFile = [], txEnCours = false, TX_DUREE = paramNum('alerteTravaux', 5);
  function alerterTravaux(liste) {
    var cle = function (x) { return x.code + '|' + x.couleur + '|' + (x.depuis || ''); };
    var premier = txVus === null;
    if (premier) txVus = {};
    liste.forEach(function (x) {
      var k = cle(x); if (txVus[k]) return;
      txVus[k] = true;
      var recu = dateIso(x.a || x.depuis), recent = recu && Date.now() - recu.getTime() < 120000;
      if (TX_DUREE > 0 && (!premier || recent)) txFile.push(x);
    });
    suivanteAlerteTravaux();
  }
  function suivanteAlerteTravaux() {
    if (txEnCours || !txFile.length) return;
    var x = txFile.shift(), el = $('#v-tx-alerte'), rouge = x.couleur === 'rouge';
    txEnCours = true;
    el.className = 'tx-alerte ' + (rouge ? 'rouge' : 'orange');
    el.innerHTML = '<div class="txa-cadre"><div class="txa-tete"><span>⚠</span> Alerte travaux <span>⚠</span></div>' +
      '<div class="txa-app">' + esc(x.libelle || x.code) + '</div>' +
      '<div class="txa-etat">' + (rouge ? 'Hors service' : 'En maintenance') + '</div>' +
      '<div class="txa-texte">' + esc(x.texte) + '</div>' +
      (x.creneau || x.message ? '<div class="txa-plus">' + [x.creneau ? '<b>' + esc(x.creneau) + '</b>' : '', x.message ? esc(x.message) : ''].filter(Boolean).join(' · ') + '</div>' : '') +
      '</div>';
    el.hidden = false;
    setTimeout(function () {
      el.classList.add('sortie');
      setTimeout(function () { el.hidden = true; el.classList.remove('sortie'); txEnCours = false; suivanteAlerteTravaux(); }, 600);
    }, TX_DUREE * 1000);
  }

  // ----------------------------------------------------------- flash info
  function majFlash(f) {
    var texte = f && f.texte ? f.texte : '';
    if (texte === etat.flash) return;
    etat.flash = texte;
    var bloc = $('#v-flash'), t = $('#v-flash-txt');
    bloc.hidden = !texte;
    t.textContent = texte;
    if (!texte) { ajuster(); return; }
    t.style.animation = 'none';
    requestAnimationFrame(function () {
      var largeurFen = $('#v-flash-fen').clientWidth, largeurTxt = t.scrollWidth;
      var vitesse = Math.max(20, (etat.d && etat.d.vitesseFlash) || 90);
      t.style.setProperty('--depart', largeurFen + 'px');
      t.style.setProperty('--fin', (-largeurTxt) + 'px');
      t.style.setProperty('--duree', ((largeurFen + largeurTxt) / vitesse).toFixed(1) + 's');
      t.style.animation = '';
      ajuster();
    });
  }

  // ---------------------------------------- taille : tout doit tenir à l'écran
  function deborde() {
    var g = $('#v-grille');
    if (g.scrollHeight > g.clientHeight + 1) return true;
    var blocs = document.querySelectorAll('.nav, .panneau');
    for (var b = 0; b < blocs.length; b++) if (blocs[b].scrollHeight > blocs[b].clientHeight + 1) return true;
    var lignes = document.querySelectorAll('.cols, .r, .tcols, .t, .rl');
    for (var i = 0; i < lignes.length; i++) if (lignes[i].scrollWidth > lignes[i].clientWidth + 1) return true;
    return false;
  }
  function ajuster() {
    var racine = document.documentElement;
    $('#v-navettes').style.zoom = '';
    var base = Math.min(window.innerHeight / 50, window.innerWidth / 90);
    var taille = base * 1.12, garde = 0;
    racine.style.fontSize = taille + 'px';
    while (garde++ < 50 && taille > base * 0.45 && deborde()) { taille *= 0.96; racine.style.fontSize = taille + 'px'; }
    agrandirNavettes();
    defiler();
  }
  /** Les trains de ligne restent en bas : la place libre au-dessus sert à agrandir les navettes (zoom jusqu'à 1,8). */
  function agrandirNavettes() {
    var nav = $('#v-navettes');
    if (vue === 'trains' || !nav.children.length || deborde()) return;
    var z = 1;
    while (z < 1.8) {
      nav.style.zoom = (z + 0.04).toFixed(2);
      if (deborde()) break;
      z += 0.04;
    }
    nav.style.zoom = z.toFixed(2);
  }
  /**
   * Texte plus large que sa case (voies multiples, étapes du Suivi trains, détail des prochaines navettes) : un léger
   * dépassement est resserré, sinon le texte va et vient à vitesse lisible (pause à chaque bout). Les animations sont
   * calées sur l'horloge de la page : une case recréée reprend au même endroit. Sans attribut ajouté : majBloc compare le HTML.
   */
  function defiler() {
    var textes = document.querySelectorAll('.dfl');
    for (var i = 0; i < textes.length; i++) {
      var t = textes[i], boite = t.parentNode, cs = getComputedStyle(boite);
      var place = boite.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), large = t.offsetWidth;
      var depasse = Math.ceil(large - place);
      if (depasse < 3) depasse = 0;
      if (t.__depasse === depasse) continue;
      t.__depasse = depasse;
      if (t.getAnimations) t.getAnimations().forEach(function (a) { a.cancel(); });
      if (!depasse || !t.animate || place <= 0) continue;
      if (place / large >= 0.86) {
        // dépassement léger : texte resserré en largeur, sans mouvement
        t.animate([{ transform: 'scaleX(' + (place / large).toFixed(3) + ')' }, { transform: 'scaleX(' + (place / large).toFixed(3) + ')' }], { duration: 1000, fill: 'forwards' });
        continue;
      }
      var pause = 1400, trajet = Math.max(900, depasse / 0.03), duree = trajet + 2 * pause;
      var a = t.animate([
        { transform: 'translateX(0)' }, { transform: 'translateX(0)', offset: pause / duree },
        { transform: 'translateX(' + (-depasse) + 'px)', offset: (pause + trajet) / duree }, { transform: 'translateX(' + (-depasse) + 'px)' }
      ], { duration: duree, iterations: Infinity, direction: 'alternate' });
      try { a.startTime = 0; } catch (e) { /* horloge de la page indisponible : départ immédiat */ }
    }
  }
  window.addEventListener('resize', function () { etat.flash = '__'; ajuster(); if (etat.d) majFlash(etat.d.flash); dernierVed.nav = dernierVed.trains = ''; majVedettes(); });

  // ------------------------------------------------------- état de liaison
  function majLiaison() {
    var el = $('#v-direct'), al = $('#v-alerte'), ecran = $('#ecran');
    var maxSilence = Math.max((etat.d && etat.d.alerteSansNouvellesSecondes) || 45, source ? 120 : 0) * 1000;
    var message = '';
    if (!etat.d) {
      el.className = 'direct attente'; el.querySelector('span').textContent = etat.echecs ? 'Données introuvables' : 'Connexion…';
      ecran.classList.add('sans-donnees');
      $('#v-attente').textContent = etat.echecs ? (source ? 'Serveur injoignable ou sans données : vérifiez Internet et que le poste de saisie a été ouvert.' : 'Fichier de diffusion introuvable. Vérifiez l\'accès au partage réseau et que le poste de saisie est démarré.') : 'En attente des données du poste de saisie…';
      al.hidden = true; return;
    }
    var coupure = true, donneesDe = etat.d.publieA ? etat.d.publieA.slice(11, 16) : '—';
    if (etat.echecs >= 3) message = (source ? 'Serveur injoignable (Internet ?)' : 'Partage réseau injoignable') + ' · affichage figé sur les données de ' + donneesDe;
    else if (Date.now() - etat.battementVuA > maxSilence) message = 'Poste de saisie à l\'arrêt ou injoignable · données de ' + donneesDe;
    else {
      coupure = false;
      if (etat.d.date !== SC.cleDate(new Date())) message = 'Données de la journée du ' + SC.libelleJour(etat.d.date) + ' : la nouvelle journée n\'est pas encore ouverte';
    }
    el.className = 'direct' + (coupure ? ' coupe' : '');
    el.querySelector('span').textContent = coupure ? 'Liaison interrompue' : 'Direct';
    ecran.classList.toggle('fige', coupure);
    if (al.hidden !== !message || al.textContent !== message) { al.hidden = !message; al.textContent = message; ajuster(); }
  }

  // ------------------------------------- mise à jour automatique de la page
  /** Après une publication sur GitHub, l'écran se recharge seul (aucun clavier nécessaire sur le PC des TV). */
  function verifierVersion() {
    if (!/^https?:/.test(location.protocol)) return;
    fetch('version.txt?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (v) {
      if (v == null) return;
      v = v.trim();
      if (etat.version === null) etat.version = v;
      else if (v !== etat.version) {
        // fichiers relus du réseau d'abord : sinon le navigateur peut recharger l'ancienne version gardée en cache
        Promise.all(['visuel.js', 'visuel.css', 'commun.js'].map(function (u) { return fetch(u, { cache: 'reload' }).catch(function () { /* sans effet */ }); }))
          .then(function () { if (window.SuiviAppli) SuiviAppli.sansIntroAuProchainChargement(); location.reload(); });
      }
    }).catch(function () { /* sans effet */ });
  }

  // ------------------------------------------------------------- horloge
  function tic() { $('#v-heure').textContent = hm(maintenant()); }
  function reveil() {
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(function () { /* refusé : sans effet */ }); } catch (e) { /* non disponible */ }
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) reveil(); });

  tic(); setInterval(tic, 1000);
  // toutes les 2 s (une lecture à la fois) : un changement de la saisie arrive en 1 à 3 s sur les écrans
  charger(); setInterval(charger, DEMO ? 2000 : 2000);
  setInterval(majVedettes, 1000);
  setInterval(majLiaison, 2000);
  setInterval(function () { if (etat.d) rendre(); }, 10000);
  verifierVersion(); setInterval(verifierVersion, 300000);

  // ?installer=1 (bouton « Raccourcis » de la saisie) : propose d'installer l'application « Écrans » sur ce PC
  if (/[?&]installer=1\b/.test(location.search) && window.SuiviAppli && !SuiviAppli.installee()) {
    var panneau = $('#v-installer');
    panneau.hidden = false;
    document.body.style.cursor = 'auto';
    SuiviAppli.suivre(function (possible) {
      $('#v-installer-bouton').hidden = !possible;
      $('#v-installer-texte').textContent = possible ? 'Installez-la : elle s\'ouvrira depuis une icône du bureau, sur cet écran.'
        : 'Si le bouton n\'apparaît pas : menu ⋯ d\'Edge › Applications › Installer ce site en tant qu\'application.';
    });
    $('#v-installer-bouton').addEventListener('click', function () {
      SuiviAppli.installer().then(function (ok) { if (ok) panneau.hidden = true; });
    });
  }
  reveil(); ajuster(); majLiaison();
})();
