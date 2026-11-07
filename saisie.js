/* Suivi des circulations - mode SAISIE (poste opérateur). Dépend de commun.js (SC). */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = SC.esc, hm = SC.hm;

  var app = {
    params: null, planning: null, journee: null, version: 0, lectureSeule: false,
    onglet: 'navette', vue: lsLire('suivi:vue') || {}, selection: null, edition: null, ouverte: null, nouvelle: null,
    pile: [], dernierChangement: Date.now(), auto: {}, touche: {},
    sauvegarde: { enCours: false, relancer: false, evenements: [], erreur: null, a: null },
    serviceOk: null, diffusion: [], mailsEnCours: {}, reessai: null, prete: false
  };
  var F = {
    num: $('#f-num'), voie: $('#f-voie'), compo: $('#f-compo'), cv: $('#f-cv'), sit: $('#f-sit'),
    vers: $('#f-vers'), comm: $('#f-comm'), reel: $('#f-reel'), annonce: $('#f-annonce'), ef: $('#f-ef')
  };

  // ------------------------------------------------------------------ outils
  function maintenant() { return SC.iso(new Date()); }
  function uid(p) { return (p || 'm') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function circDe(j, id) { return (j.circulations || []).filter(function (c) { return c.id === id; })[0] || null; }
  function mouvDe(j, id) { return (j.mouvements || []).filter(function (m) { return m.id === id; })[0] || null; }
  function seuil() { return (app.params.exploitation && app.params.exploitation.seuilRetardMinutes) || 15; }
  function estJourActif() { return !app.lectureSeule && app.journee; }
  function groupe(id) { return SC.groupeDe(app.planning, id) || { libelle: id, famille: 'ligne' }; }
  function famille(c) { return groupe(c.groupe).famille; }
  function lsLire(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsEcrire(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }

  /**
   * Deux façons de joindre le serveur, avec les mêmes routes :
   * - « local » : page servie par le service du poste de saisie (http://localhost) ;
   * - « google » : page publiée sur GitHub Pages, données dans le script Google Apps Script de l'utilisateur.
   */
  var CONNEXION = (function () {
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !/[?&]google=1/.test(location.search)) return { mode: 'local' };
    var c = lsLire('suivi:connexion') || {};
    var h = /(?:^|[#&])url=([^&]+)/.exec(location.hash), k = /(?:^|[#&])cle=([^&]+)/.exec(location.hash);
    if (h) {
      c = { url: decodeURIComponent(h[1]), cle: k ? decodeURIComponent(k[1]) : (c.cle || '') };
      lsEcrire('suivi:connexion', c);
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sans effet */ }
    }
    return { mode: 'google', url: c.url || '', cle: c.cle || '' };
  })();
  function api(methode, url, corps) {
    if (CONNEXION.mode === 'google') {
      if (!CONNEXION.url) return Promise.reject(new Error('serveur Google non configuré'));
      return fetch(CONNEXION.url, { method: 'POST', cache: 'no-store', redirect: 'follow', body: JSON.stringify({ cle: CONNEXION.cle, methode: methode, chemin: url, corps: corps == null ? null : corps }) })
        .then(function (r) { return r.text(); })
        .then(function (t) { var o = JSON.parse(t); return { status: o.status, data: o.data }; });
    }
    var o = { method: methode, cache: 'no-store', headers: { 'X-Suivi': '1' } };
    if (corps != null) { o.body = corps; o.headers['Content-Type'] = 'text/plain; charset=utf-8'; }
    return fetch(url, o).then(function (r) {
      return r.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = { erreur: t }; }
        return { status: r.status, data: d };
      });
    });
  }

  function toast(texte, type, action) {
    var t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.innerHTML = '<span>' + esc(texte) + '</span>';
    if (action) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = action.libelle;
      b.addEventListener('click', function () { action.fn(); t.remove(); });
      t.appendChild(b);
    }
    $('#toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, action ? 8000 : 4500);
  }

  // --------------------------------------------------------- modifications
  function modifier(resume, type, fn, opt) {
    opt = opt || {};
    if (app.lectureSeule) { toast('Cette journée est en lecture seule.'); return false; }
    if (!opt.sansAnnulation) { app.pile.push({ etat: SC.copie(app.journee), resume: resume }); if (app.pile.length > 40) app.pile.shift(); }
    fn(app.journee);
    app.dernierChangement = Date.now();
    sauvegarderBientot({ type: type, resume: resume, a: maintenant() });
    rendre();
    if (!opt.sansMails) traiterMails();
    return true;
  }
  function annuler() {
    var e = app.pile.pop();
    if (!e) { toast('Rien à annuler.'); return; }
    var mailsActuels = {};
    app.journee.circulations.forEach(function (c) { mailsActuels[c.id] = c.mails; });
    var j = e.etat;
    j.circulations.forEach(function (c) { if (mailsActuels[c.id]) c.mails = mailsActuels[c.id]; });
    j.version = app.journee.version;
    app.journee = j;
    sauvegarderBientot({ type: 'annulation', resume: 'Annulation : ' + e.resume, a: maintenant() });
    rendre();
    toast('Annulé : ' + e.resume);
  }

  // ----------------------------------------------------------- sauvegarde
  function secoursLocal(enAttente) {
    if (!app.journee || app.lectureSeule) return;
    lsEcrire('suivi:' + app.journee.date, { journee: app.journee, version: app.version, enAttente: enAttente, a: maintenant() });
  }
  function sauvegarderBientot(evt) {
    app.sauvegarde.evenements.push(evt);
    secoursLocal(true);
    envoyer();
  }
  function envoyer() {
    var s = app.sauvegarde;
    // une publication seule en cours : attendue, pour que le serveur ne la reçoive pas après cet enregistrement
    if (s.enCours || app.publication) { s.relancer = true; return; }
    if (!s.evenements.length || app.lectureSeule) return;
    s.enCours = true;
    var evts = s.evenements.splice(0, s.evenements.length);
    var etat = SC.copie(app.journee);
    etat.version = app.version + 1;
    var diff = estJourActif() ? JSON.stringify(SC.projeterDiffusion(etat, app.planning, app.params, maintenant())) : '';
    var meta = { baseVersion: app.version, evenement: evts.length === 1 ? evts[0] : { type: 'lot', liste: evts } };
    var date = etat.date;
    api('PUT', '/api/journee/' + date, JSON.stringify(meta) + '\n' + JSON.stringify(etat) + '\n' + diff).then(function (r) {
      if (app.journee.date !== date) return;
      if (r.status === 200) {
        app.version = r.data.version; app.journee.version = r.data.version;
        app.diffusion = r.data.diffusion || []; s.erreur = null; s.a = new Date(); app.serviceOk = true;
        secoursLocal(s.evenements.length > 0);
      } else if (r.status === 409) {
        conflit();
      } else {
        s.evenements = evts.concat(s.evenements); s.erreur = (r.data && r.data.erreur) || ('erreur ' + r.status); reessayer();
      }
    }, function () {
      s.evenements = evts.concat(s.evenements); s.erreur = 'service injoignable'; app.serviceOk = false; reessayer();
    }).then(function () {
      s.enCours = false; rendreEtats(); rendreBandeau();
      if (s.relancer && !app.reessai) { s.relancer = false; envoyer(); }
    });
  }
  function reessayer() {
    if (app.reessai) return;
    app.reessai = setTimeout(function () { app.reessai = null; envoyer(); }, 5000);
  }
  function conflit() {
    api('GET', '/api/journee/' + app.journee.date).then(function (r) {
      if (r.status !== 200) return;
      app.journee = r.data.journee; app.version = r.data.version; app.pile = [];
      app.sauvegarde.evenements = [];
      rendre();
      toast('La journée a été modifiée depuis une autre fenêtre : elle a été rechargée. Vérifiez votre dernière saisie.', 'crit');
    });
  }
  function publier() {
    // un enregistrement en cours publie déjà l'affichage avec la journée
    if (!estJourActif() || !app.prete || app.publication || sauvegardeEnCours()) return;
    var d = SC.projeterDiffusion(app.journee, app.planning, app.params, maintenant());
    app.publication = true;
    api('POST', '/api/diffusion', JSON.stringify(d)).then(function (r) {
      if (r.status === 200) { app.diffusion = r.data.diffusion || []; app.serviceOk = true; }
      // refusée par le serveur : cette fenêtre a une version dépassée de la journée (une saisie faite entre-temps
      // part d'abord : le serveur la refusera aussi et la journée sera relue)
      if (r.status === 409 && !sauvegardeEnCours()) conflit();
      rendreEtats();
    }, function () { app.serviceOk = false; rendreEtats(); rendreBandeau(); }).then(function () {
      app.publication = false;
      var s = app.sauvegarde;
      if (s.relancer && !s.enCours && !app.reessai) { s.relancer = false; envoyer(); }
    });
  }
  /**
   * Toutes les minutes : republie l'affichage (heures qui passent). Une autre fenêtre de saisie a pu modifier la journée
   * entre-temps : elle est relue d'abord, pour ne jamais remettre aux écrans et au Suivi trains un état dépassé
   * (navette de nouveau « pas partie »).
   */
  function publierPeriodique() {
    if (!estJourActif() || !app.prete || app.publication || sauvegardeEnCours()) return;
    var date = app.journee.date, version = app.version;
    api('GET', '/api/journee/' + date).then(function (r) {
      if (r.status !== 200 || !estJourActif() || app.journee.date !== date || app.version !== version || sauvegardeEnCours()) return;
      if (r.data.version !== version) {
        // modification en cours dans le tableau : relu à la minute suivante, sans publier d'ici là
        var actif = document.activeElement;
        if (actif && actif.closest && actif.closest('#p-liste, #j-corps, dialog[open]') && /^(INPUT|SELECT|TEXTAREA)$/.test(actif.tagName)) return;
        app.journee = r.data.journee; app.version = r.data.version; app.pile = [];
        rendre();
        toast('Journée modifiée depuis une autre fenêtre de saisie : affichage mis à jour.');
      }
      publier();
    }, function () { /* signalé par verifierService */ });
  }
  function verifierService() {
    api('GET', '/api/sante').then(function (r) {
      app.serviceOk = r.status === 200;
      if (r.status === 200 && r.data.diffusion) app.diffusion = r.data.diffusion;
      rendreEtats(); rendreBandeau();
      if (app.serviceOk && app.sauvegarde.evenements.length) envoyer();
    }, function () { app.serviceOk = false; rendreEtats(); rendreBandeau(); });
  }

  // ---------------------------------------------------------------- mails
  function traiterMails() {
    if (!estJourActif()) return;
    SC.mailsEnAttente(app.journee, app.planning, app.params).forEach(function (c) { envoyerMail(c, null); });
  }
  function envoyerMail(c, suffixe) {
    if (app.mailsEnCours[c.id]) return;
    var mail = SC.construireMail(app.journee, c, app.planning, app.params, suffixe);
    if (!mail) return;
    app.mailsEnCours[c.id] = true;
    api('POST', '/api/mail', JSON.stringify(mail)).then(function (r) {
      var res = r.status === 200 ? { statut: r.data.statut, a: r.data.a } : { statut: 'erreur', message: (r.data && r.data.erreur) || ('erreur ' + r.status) };
      enregistrerMail(c.id, mail, res);
    }, function () {
      enregistrerMail(c.id, mail, { statut: 'erreur', message: 'service injoignable' });
    }).then(function () { delete app.mailsEnCours[c.id]; });
  }
  function enregistrerMail(id, mail, res) {
    var c = circDe(app.journee, id);
    if (!c) return;
    var prec = (c.mails && c.mails[mail.type]) || {};
    modifier('Mail « ' + mail.sujet + ' » : ' + res.statut, 'mail', function (j) {
      var cc = circDe(j, id); cc.mails = cc.mails || {};
      cc.mails[mail.type] = {
        statut: res.statut, a: res.a || maintenant(), id: mail.id, mode: mail.mode, sujet: mail.sujet,
        message: res.message || '', essais: (prec.essais || 0) + (res.statut === 'erreur' ? 1 : 0)
      };
    }, { sansAnnulation: true, sansMails: true });
    if (res.statut === 'erreur') toast('Mail non parti : ' + mail.sujet + ' (' + res.message + '). Nouvel essai dans une minute.', 'crit');
  }

  // ------------------------------------------------------------- journées
  function charger(j, version, lecture) {
    app.journee = j; app.version = version; app.lectureSeule = !!lecture;
    app.pile = []; app.selection = null; app.edition = null; app.ouverte = null;
    // « Demain » / « Après-demain » sur les prochains jours ouvrés (réglage Paramètres › Exploitation)
    app.recale = SC.recalerPreps(j, app.planning);
    if (!j.flash) j.flash = { actif: false, texte: '', jusqua: '' };
    viderFormulaire();
    rendre();
  }
  function restaurerSecours() {
    var s = lsLire('suivi:' + app.journee.date);
    if (s && s.enAttente && s.version === app.version && s.journee && s.journee.date === app.journee.date) {
      app.journee = s.journee; app.journee.version = app.version;
      sauvegarderBientot({ type: 'restauration', resume: 'Saisies non transmises récupérées dans le navigateur', a: maintenant() });
      rendre();
      toast('Des saisies non transmises ont été récupérées et enregistrées.');
    }
  }
  function ouvrirJourActif() {
    var cle = SC.cleDate(new Date());
    return api('GET', '/api/journee/' + cle).then(function (r) {
      if (r.status === 200) {
        charger(r.data.journee, r.data.version, false); restaurerSecours();
        if (app.recale) sauvegarderBientot({ type: 'demain.recalage', resume: 'Jours préparés : ' + app.journee.demain.date + ' et ' + app.journee.surlendemain.date, a: maintenant() });
        return;
      }
      if (r.status !== 404) throw new Error('lecture de la journée impossible');
      return creerJournee(cle);
    });
  }
  function creerJournee(cle) {
    return api('GET', '/api/journees').then(function (r) {
      var dates = (r.data && r.data.dates) || [];
      var veille = dates.filter(function (d) { return d < cle; }).pop();
      if (!veille) return null;
      return api('GET', '/api/journee/' + veille).then(function (rv) {
        if (rv.status !== 200) return null;
        var jv = rv.data.journee;
        if (jv.cloture) return jv;
        return cloturer(jv, rv.data.version, true).then(function () { return jv; }, function () { return jv; });
      });
    }).then(function (jv) {
      var j = SC.nouvelleJournee(app.planning, cle, jv && jv.demain, new Date(), jv && jv.surlendemain);
      charger(j, 0, false);
      var prep = jv && jv.demain && jv.demain.date === cle;
      sauvegarderBientot({ type: 'journee.creation', resume: 'Création de la journée' + (prep ? ' avec la préparation de la veille' : ' depuis le planning'), a: maintenant() });
    });
  }
  function sauvegardeEnCours() { return app.sauvegarde.enCours || app.sauvegarde.evenements.length > 0; }
  /** Attend la fin des enregistrements en cours (10 s au plus) avant de changer de journée. */
  function attendreSauvegarde() {
    return new Promise(function (ok, ko) {
      var debut = Date.now();
      (function boucle() {
        if (!sauvegardeEnCours()) return ok();
        if (Date.now() - debut > 10000) return ko(new Error('enregistrement en attente'));
        setTimeout(boucle, 200);
      })();
    });
  }
  function ouvrirJourneePassee(date) {
    if (sauvegardeEnCours()) { toast('Enregistrement en cours : réessayez dans un instant.'); return; }
    api('GET', '/api/journee/' + date).then(function (r) {
      if (r.status !== 200) { toast('Journée introuvable.', 'crit'); return; }
      charger(r.data.journee, r.data.version, true);
      toast('Journée du ' + SC.libelleDateCourte(date) + ' ouverte en lecture seule.');
    });
  }
  function revenirAujourdhui() { ouvrirJourActif().then(publier, function (e) { toast('Ouverture impossible : ' + e.message, 'crit'); }); }
  function verifierChangementJour() {
    if (app.lectureSeule || !app.journee) return;
    var cle = SC.cleDate(new Date());
    if (cle <= app.journee.date) return;
    if (Date.now() - app.dernierChangement > 30 * 60000 && !app.sauvegarde.evenements.length) basculerNouvelleJournee();
    else rendreBandeau();
  }
  function basculerNouvelleJournee() {
    if (app.bascule) return;
    app.bascule = true;
    var j = app.journee;
    var suite = j.cloture ? Promise.resolve() : cloturer(j, app.version, true);
    suite.then(null, function () { /* la clôture sera refaite à l'ouverture suivante */ })
      .then(attendreSauvegarde)
      .then(function () { app.prete = false; return ouvrirJourActif(); })
      .then(function () { app.prete = true; publier(); toast('Nouvelle journée ouverte.'); },
        function (e) { app.prete = true; toast('Changement de journée impossible : ' + e.message, 'crit'); })
      .then(function () { app.bascule = false; });
  }

  // --------------------------------------------------------------- clôture
  function fichiersArchive(j) {
    var s = SC.statistiques(j, app.planning, app.params);
    return {
      date: j.date,
      fichiers: [
        { nom: j.date + '_mouvements.csv', contenu: SC.exporterMouvements(j, app.planning, app.params) },
        { nom: j.date + '_circulations.csv', contenu: SC.exporterCirculations(j, app.planning) }
      ],
      statistiques: { entete: SC.ENTETE_STATS.join(';'), ligne: SC.ligneStatistiques(s) }
    };
  }
  /** Archive une journée. Pour la journée ouverte, la marque clôturée ; pour une autre, l'enregistre directement. */
  function cloturer(j, version, auto) {
    return api('POST', '/api/archives', JSON.stringify(fichiersArchive(j))).then(function (r) {
      if (r.status !== 200) throw new Error((r.data && r.data.erreur) || 'archives non écrites');
      var info = { a: maintenant(), auto: !!auto, dossier: r.data.dossier };
      if (app.journee && j === app.journee && !app.lectureSeule) {
        modifier('Journée clôturée', 'journee.cloture', function (jj) { jj.cloture = info; }, { sansAnnulation: true });
        return r.data;
      }
      j.cloture = info;
      var etat = SC.copie(j); etat.version = version + 1;
      var meta = { baseVersion: version, evenement: { type: 'journee.cloture', resume: 'Clôture automatique', a: maintenant() } };
      return api('PUT', '/api/journee/' + j.date, JSON.stringify(meta) + '\n' + JSON.stringify(etat) + '\n').then(function () { return r.data; });
    });
  }

  // ----------------------------------------------------- formulaire saisie
  function remplirListes() {
    $('#l-voies').innerHTML = (app.params.voies || []).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
    $('#l-ef').innerHTML = (app.params.efConnues || []).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
  }
  /** Propositions du champ N° : numéros du jour (avec leur circulation), mouvements internes puis base N° → EF. */
  function remplirNumeros() {
    var vus = {}, liste = [];
    var ajouter = function (n, c) {
      n = SC.norm(n); if (!n || vus[n]) return; vus[n] = true;
      var ef = SC.deduireEF(n, app.journee, app.planning, app.params) || '';
      liste.push({ n: n, info: [ef, c ? c.code + ' ' + (c.sens === 'D' ? 'dép.' : 'arr.') + ' ' + hm(c.theo) : ''].filter(Boolean).join(' · ') });
    };
    if (app.journee) {
      app.journee.circulations.forEach(function (c) {
        if (c.etat === 'supprime' || c.etat === 'nonprevu' || SC.etatCirculation(c, app.journee).reel) return;
        SC.numerosDe(c).forEach(function (n) { ajouter(n, c); });
      });
    }
    var internes = app.params.mouvementsInternes || {};
    Object.keys(internes).forEach(function (ef) { internes[ef].forEach(function (n) { ajouter(n); }); });
    Object.keys(app.params.correspondancesEF || {}).forEach(function (n) { ajouter(n); });
    app.numeros = liste;
  }
  /**
   * Suggestions sous le champ N° dès les premières lettres : « loc » → locom, loco, locosup…
   * Ceux qui commencent par le texte tapé d'abord, puis ceux qui le contiennent. ↓ ↑ pour choisir, Entrée ou Tab pour prendre.
   * Avec des lettres, la première est présélectionnée (Entrée la prend) ; avec des chiffres, il faut ↓ (un numéro neuf reste tel quel).
   */
  var sugg = { liste: [], choisi: -1 };
  function proposerNumeros() {
    var q = SC.norm(F.num.value), boite = $('#s-sugg');
    if (!q || app.edition) { fermerSuggestions(); return; }
    var debut = [], dedans = [], exact = false;
    (app.numeros || []).forEach(function (o) {
      var p = o.n.indexOf(q);
      if (o.n === q) exact = true; else if (p === 0) debut.push(o); else if (p > 0) dedans.push(o);
    });
    sugg.liste = debut.concat(dedans).slice(0, 8);
    sugg.choisi = sugg.liste.length && debut.length && !exact && /[a-z]/.test(q) ? 0 : -1;
    if (!sugg.liste.length) { fermerSuggestions(); return; }
    boite.innerHTML = sugg.liste.map(function (o, i) {
      var p = o.n.indexOf(q);
      return '<div class="sugg' + (i === sugg.choisi ? ' choisi' : '') + '" role="option" data-i="' + i + '"><span class="mono">' +
        esc(o.n.slice(0, p)) + '<b>' + esc(o.n.slice(p, p + q.length)) + '</b>' + esc(o.n.slice(p + q.length)) + '</span><span class="info">' + esc(o.info) + '</span></div>';
    }).join('') + '<div class="sugg-aide"><span class="touche">↓</span> <span class="touche">↑</span> choisir · <span class="touche">Entrée</span> prendre · <span class="touche">Échap</span> fermer</div>';
    boite.hidden = false;
  }
  function fermerSuggestions() { sugg.liste = []; sugg.choisi = -1; $('#s-sugg').hidden = true; }
  function prendreSuggestion(i) {
    var o = sugg.liste[i]; if (!o) return;
    F.num.value = o.n;
    fermerSuggestions();
    surNumero();
  }
  function placerAuto(champ, valeur) {
    F[champ].value = valeur || '';
    app.auto[champ] = !!valeur;
    F[champ].classList.toggle('auto', !!valeur);
  }
  function surNumero() {
    var num = F.num.value.trim();
    var c = app.edition ? null : SC.trouverCirculation(app.journee, num);
    if (!app.touche.ef) placerAuto('ef', SC.deduireEF(num, app.journee, app.planning, app.params));
    if (!app.edition) {
      if (!F.voie.value || app.auto.voie) {
        var v = SC.derniereVoie(app.journee, num) || (c && c.voiePrevue ? c.voiePrevue.toLowerCase() : '');
        placerAuto('voie', v ? SC.normaliserVoie(v, app.params) : '');
      }
      if (!F.compo.value || app.auto.compo) placerAuto('compo', c && c.sens === 'D' && c.wagonsDemandes ? String(c.wagonsDemandes) : '');
    }
    surCompo();
    majARemplir();
  }
  function surCompo() {
    var hlp = F.compo.value.trim().toLowerCase() === 'hlp';
    if (hlp) { F.cv.value = '/'; F.cv.disabled = true; }
    else { F.cv.disabled = false; if (F.cv.value === '/') F.cv.value = 'chargés'; }
    if (!app.touche.sit) F.sit.value = hlp ? 'occupée' : 'libre';
    aide();
  }
  function lireFormulaire() {
    var j = app.journee, avant = app.edition ? mouvDe(j, app.edition) : null;
    var compo = F.compo.value.trim().toLowerCase();
    var annonce = F.annonce.value.trim() ? SC.heureProche(j.date, F.annonce.value, maintenant()) : (avant ? avant.annonce : maintenant());
    return {
      num: F.num.value.trim().toLowerCase(),
      ef: F.ef.value.trim() || SC.deduireEF(F.num.value, j, app.planning, app.params),
      voie: SC.normaliserVoie(F.voie.value, app.params),
      compo: compo,
      cv: compo === 'hlp' ? '/' : (compo ? F.cv.value : ''),
      sit: F.sit.value,
      vers: SC.normaliserVoie(F.vers.value, app.params),
      comm: F.comm.value.trim(),
      reel: F.reel.value.trim() ? SC.heureProche(j.date, F.reel.value, annonce) : null,
      annonce: annonce,
      _annonceInvalide: !!(F.annonce.value.trim() && !SC.normHeure(F.annonce.value)),
      _reelInvalide: !!(F.reel.value.trim() && !SC.normHeure(F.reel.value))
    };
  }
  /** Champs obligatoires encore vides : encadrés, et listés à côté du titre « Nouveau mouvement ». */
  function majARemplir() {
    var num = F.num.value.trim(), libelles = { num: 'N° train', voie: 'Voie', compo: 'Wagons', vers: 'Vers' }, manque = [];
    var requis = ['num', 'voie', 'compo'].concat(num && SC.versObligatoire(num, app.params) ? ['vers'] : []);
    Object.keys(libelles).forEach(function (k) {
      var r = requis.indexOf(k) >= 0, vide = !F[k].value.trim();
      F[k].classList.toggle('a-remplir', r && vide);
      F[k].closest('.champ').classList.toggle('requis', r);
      if (r && vide) manque.push(libelles[k]);
    });
    var reste = $('#s-reste');
    reste.textContent = manque.length ? 'À remplir : ' + manque.join(' · ') : 'Tout est rempli : Entrée pour valider';
    reste.classList.toggle('pret', !manque.length);
  }
  function aide(erreurs) {
    var j = app.journee; if (!j) return;
    majARemplir();
    var num = F.num.value.trim().toLowerCase(), morceaux = [];
    [F.voie, F.vers, F.compo, F.num, F.reel, F.annonce].forEach(function (x) { x.classList.remove('erreur', 'avert'); });
    if (erreurs && erreurs.length) morceaux.push('<span class="puce supprime">À corriger</span><span>' + esc(erreurs.join(' ')) + '</span>');
    var c = app.edition ? null : SC.trouverCirculation(j, num);
    if (c) {
      var d = SC.etatCirculation(c, j), st = SC.statutCirculation(c, d, maintenant(), seuil());
      morceaux.push('<span class="puce ' + st + '">' + esc(SC.libelleStatut(st, c.sens)) + '</span><span><b class="mono">' + esc(num) + '</b> = <b>' + esc(c.code) + '</b> · ' +
        esc(groupe(c.groupe).libelle) + ' · ' + (c.sens === 'D' ? 'départ' : 'arrivée') + (c.theo ? ' prévu ' + hm(c.theo) : '') +
        (c.voiePrevue ? ' · voie prévue ' + esc(c.voiePrevue) : '') + (c.wagonsDemandes ? ' · ' + c.wagonsDemandes + ' wgs demandés' : '') + '</span>');
      if (!d.reel) morceaux.push('<span><span class="touche">F2</span> ' + (c.sens === 'D' ? 'parti' : 'arrivée') + ' maintenant</span>');
    } else if (SC.estNumeroTrain(num)) {
      var z = SC.deduireZone(num);
      morceaux.push('<span>Pas de circulation prévue avec ce numéro' + (z ? ' · zone <b>' + esc(z) + '</b>' : '') + '</span>');
    }
    if (SC.estNumeroTrain(num)) {
      var dbl = SC.mouvementsActifs(j).filter(function (m) { return m.id !== app.edition && m.num === num; })[0];
      if (dbl) morceaux.push('<span class="puce retard">Déjà saisi</span><span>ligne ' + dbl.n + ' à ' + hm(dbl.annonce) + '</span>');
    }
    [['voie', F.voie], ['vers', F.vers]].forEach(function (p) {
      var v = p[1].value.trim().toLowerCase(); if (!v) return;
      var alias = (app.params.aliasVoies || {})[v];
      if (alias) { p[1].classList.add('avert'); morceaux.push('<span class="puce retard">Voie</span><span>« ' + esc(v) + ' » sera enregistrée « ' + esc(alias) + ' »</span>'); }
      else if (!SC.voieConnue(v, app.params)) { p[1].classList.add('erreur'); morceaux.push('<span class="puce supprime">Voie inconnue</span><span>« ' + esc(v) + ' »</span>'); }
    });
    var compo = F.compo.value.trim().toLowerCase();
    if (compo && compo !== 'hlp' && !/^\d{1,3}$/.test(compo)) F.compo.classList.add('erreur');
    if (F.reel.value.trim() && !SC.normHeure(F.reel.value)) F.reel.classList.add('erreur');
    if (F.annonce.value.trim() && !SC.normHeure(F.annonce.value)) F.annonce.classList.add('erreur');
    $('#s-aide').innerHTML = morceaux.length ? morceaux.join('') : '<span>Tapez un numéro : EF, zone et voie se remplissent. <span class="touche">Entrée</span> passe au champ suivant jusqu\'à Valider ;<span class="touche">Ctrl+Entrée</span> enregistre directement.</span>';
  }
  function viderFormulaire() {
    Object.keys(F).forEach(function (k) { if (F[k].tagName === 'INPUT') { F[k].value = ''; F[k].classList.remove('auto', 'erreur', 'avert'); } });
    F.cv.value = 'chargés'; F.cv.disabled = false; F.sit.value = 'libre';
    app.auto = {}; app.touche = {}; app.edition = null;
    $('#saisie').classList.remove('edition');
    $('#s-titre').textContent = 'Nouveau mouvement';
    $('#s-annuler').hidden = true;
    aide();
  }
  function editerMouvement(id) {
    var m = mouvDe(app.journee, id); if (!m || app.lectureSeule) return;
    viderFormulaire();
    app.edition = id; app.touche = { ef: true, sit: true, cv: true };
    F.num.value = m.num; F.voie.value = m.voie || ''; F.compo.value = m.compo || ''; F.cv.value = m.cv && m.cv !== '/' ? m.cv : 'chargés';
    F.sit.value = m.sit || 'libre'; F.vers.value = m.vers || ''; F.comm.value = m.comm || ''; F.reel.value = hm(m.reel); F.annonce.value = hm(m.annonce); F.ef.value = m.ef || '';
    $('#saisie').classList.add('edition');
    $('#s-titre').textContent = 'Modification de la ligne ' + m.n;
    $('#s-annuler').hidden = false;
    surCompo();
    F.num.focus(); F.num.select();
  }
  function lier(j, m) {
    if (m.lien) {
      var ancien = circDe(j, m.lien);
      if (ancien && SC.numerosDe(ancien).indexOf(m.num) >= 0 && ancien.etat !== 'supprime') return m.lien;
    }
    var c = SC.trouverCirculation(j, m.num);
    return c ? c.id : null;
  }
  function premierChampEnErreur(m) {
    var k = MARCHE.filter(function (c) { return SC.verifierChamp(c, m, app.params); })[0];
    if (k) return F[k];
    if (m._reelInvalide) return F.reel;
    if (m._annonceInvalide) return F.annonce;
    return null;
  }
  /** Ordre de passage avec Entrée, comme dans le classeur : N°, voie, wagons, chargés/vides, situation, vers, commentaire, puis Valider. */
  var MARCHE = ['num', 'voie', 'compo', 'cv', 'sit', 'vers', 'comm'];
  function champSuivant(k) {
    for (var j = MARCHE.indexOf(k) + 1; j < MARCHE.length; j++) { if (!F[MARCHE[j]].disabled) return F[MARCHE[j]]; }
    return $('#s-valider');
  }
  /** Entrée dans un champ : contrôle ce champ puis passe au suivant ; Valider n'enregistre que si tout est rempli. */
  function avancer(cible) {
    var k = Object.keys(F).filter(function (x) { return F[x] === cible; })[0];
    if (MARCHE.indexOf(k) < 0) { $('#s-valider').focus(); return; }
    var m = { num: F.num.value, voie: SC.normaliserVoie(F.voie.value, app.params), compo: F.compo.value, vers: SC.normaliserVoie(F.vers.value, app.params) };
    var err = SC.verifierChamp(k, m, app.params);
    if (err) { aide([err]); cible.classList.add('erreur'); cible.focus(); return; }
    if (k === 'voie' && F.voie.value) F.voie.value = m.voie;
    if (k === 'vers' && F.vers.value) F.vers.value = m.vers;
    var s = champSuivant(k);
    s.focus();
    if (s.select && s.tagName === 'INPUT') s.select();
  }
  function valider() {
    if (app.lectureSeule) { toast('Cette journée est en lecture seule.'); return; }
    var m = lireFormulaire();
    var v = SC.verifierMouvement(m, app.journee, app.params, app.edition);
    if (m._reelInvalide) v.erreurs.push('Heure réelle invalide.');
    if (m._annonceInvalide) v.erreurs.push('Heure d\'annonce invalide.');
    if (v.erreurs.length) { aide(v.erreurs); var f = premierChampEnErreur(m); if (f) f.focus(); return; }
    delete m._reelInvalide; delete m._annonceInvalide;
    if (app.edition) {
      var id = app.edition, n = mouvDe(app.journee, id).n;
      modifier('Ligne ' + n + ' modifiée', 'mouvement.modification', function (j) {
        var x = mouvDe(j, id);
        Object.keys(m).forEach(function (k) { x[k] = m[k]; });
        x.lien = lier(j, x); x.modifieA = maintenant();
      });
      app.selection = id;
    } else {
      modifier('Mouvement ' + m.num + ' ajouté', 'mouvement.ajout', function (j) {
        m.id = uid('m'); m.n = SC.prochainNumeroLigne(j); m.lien = lier(j, m); m.supprime = false;
        j.mouvements.push(m); app.nouvelle = m.id;
      });
    }
    if (v.avertissements.length) toast(v.avertissements.join(' '));
    if (app.touche.ef && m.ef && SC.efDeLaBase(m.num, app.params) !== m.ef) {
      var numM = m.num, efM = m.ef;
      toast('EF « ' + efM + ' » saisie pour ' + numM + '.', null, { libelle: 'Mémoriser dans la base', fn: function () { memoriserEF(numM, efM); } });
    }
    viderFormulaire();
    F.num.focus();
  }
  function enregistrerParametres(p, message) {
    return api('PUT', '/api/parametres', JSON.stringify(p, null, 2)).then(function (r) {
      if (r.status !== 200) throw new Error((r.data && r.data.erreur) || 'enregistrement refusé');
      app.params = p; reglerJours(); remplirListes();
      if (app.journee && !app.lectureSeule && SC.recalerPreps(SC.copie(app.journee), app.planning)) {
        modifier('Jours préparés recalés (samedi / dimanche)', 'demain.recalage', function (j) { SC.recalerPreps(j, app.planning); });
      }
      rendre(); publier();
      if (message) toast(message);
    });
  }
  function reglerJours() { SC.regler({ sauterWeekend: ((app.params || {}).exploitation || {}).sauterWeekend !== false }); }
  function memoriserEF(num, ef) {
    var p = SC.copie(app.params); p.correspondancesEF = p.correspondancesEF || {}; p.correspondancesEF[SC.norm(num)] = ef;
    enregistrerParametres(p, num + ' = ' + ef + ' ajouté à la base.').catch(function (e) { toast('Base non modifiée : ' + e.message, 'crit'); });
  }

  // -------------------------------------------------- actions circulations
  function marquerReel(id) {
    var c = circDe(app.journee, id); if (!c) return;
    var t = maintenant();
    modifier(c.code + (c.sens === 'D' ? ' parti' : ' arrivée') + ' à ' + hm(t), 'circulation.reel', function (j) {
      var cc = circDe(j, id); cc.reel = t; if (cc.etat === 'deja') cc.etat = null;
      // ligne ajoutée au journal des mouvements si aucune ne lui est encore rattachée
      var m = SC.journaliserCirculation(j, cc, t, app.planning, app.params, uid('m'));
      if (m) app.nouvelle = m.id;
    });
  }
  function annulerReel(id) {
    var c = circDe(app.journee, id); if (!c) return;
    modifier('Heure réelle de ' + c.code + ' retirée', 'circulation.reel.annulation', function (j) {
      var cc = circDe(j, id); cc.reel = null;
      SC.mouvementsActifs(j).forEach(function (m) {
        if (m.lien !== id) return;
        if (m.auto) { m.supprime = true; m.supprimeA = maintenant(); } else m.reel = null;
      });
    });
  }
  function basculer(id, champ, valeur, libelle) {
    modifier(libelle, 'circulation.' + champ, function (j) { var cc = circDe(j, id); cc[champ] = cc[champ] === valeur ? null : valeur; });
  }
  /** Départ de l'origine (navette « Partie », train « En approche » depuis FA) ; l'heure d'arrivée du Suivi trains ne s'applique plus. */
  function marquerPartie(id, retirer) {
    var c = circDe(app.journee, id); if (!c) return;
    var t = maintenant(), nom = famille(c) === 'navette' ? ' partie' : ' en approche';
    modifier(retirer ? c.code + nom + ' : retiré' : c.code + nom + ' à ' + hm(t), 'circulation.partie', function (j) { var cc = circDe(j, id); cc.partie = retirer ? null : t; cc.eta = null; });
  }
  /** Navette au départ annoncée sur les écrans TV (bouton ▲) ; un second clic retire l'annonce. */
  function annoncerDepart(id) {
    var c = circDe(app.journee, id); if (!c) return;
    var t = maintenant();
    modifier(c.annonceTV ? c.code + ' : annonce de départ retirée' : c.code + ' : départ annoncé à ' + hm(t), 'circulation.annonce', function (j) { var cc = circDe(j, id); cc.annonceTV = cc.annonceTV ? null : t; });
  }
  /** Train arrivé au faisceau FA, pas encore chez nous (un second clic retire l'heure). */
  function marquerFA(id) {
    var c = circDe(app.journee, id); if (!c) return;
    var t = maintenant();
    modifier(c.fa ? c.code + ' : FA retiré' : c.code + ' à FA ' + hm(t), 'circulation.fa', function (j) { var cc = circDe(j, id); cc.fa = cc.fa ? null : t; });
  }
  /** Lit le classeur du Suivi trains (toutes les 10 s) et reporte départs, arrivées et déroulés dans la journée. */
  function suivreTrains() {
    var cfg = app.params && app.params.suiviTrains;
    if (!GOOGLE || !cfg || !cfg.classeur || !app.prete || app.lectureSeule || !estJourActif()) return;
    var date = app.journee.date;
    // une lecture à la fois (toutes les 4 s) : pas d'empilement si le serveur répond lentement
    if (app.suiviEnCours && Date.now() - app.suiviEnCours < 20000) return;
    app.suiviEnCours = Date.now();
    api('POST', '/api/suivi-trains', JSON.stringify({ date: date, demain: app.journee.demain && app.journee.demain.date })).then(function (r) {
      if (r.status !== 200) { app.suiviTrains = { erreur: (r.data && r.data.erreur) || ('erreur ' + r.status), a: new Date() }; return; }
      app.suiviTrains = { a: new Date(), lignes: (r.data.navettes || []).length + (r.data.journal || []).length };
      majCoupons(r.data, date);
      if (!app.journee || app.journee.date !== date || app.lectureSeule) return;
      var changes = SC.appliquerSuiviTrains(SC.copie(app.journee), r.data, app.params);
      if (!changes.length) return;
      modifier('Suivi trains : ' + changes.join(', '), 'suivi-trains', function (j) {
        var avant = {};
        j.circulations.forEach(function (c) { avant[c.id] = c.reel; });
        SC.appliquerSuiviTrains(j, r.data, app.params);
        // une arrivée ou un départ validé dans le Suivi trains va aussi au journal des mouvements
        j.circulations.forEach(function (c) { if (c.reel && !avant[c.id]) SC.journaliserCirculation(j, c, c.reel, app.planning, app.params, uid('m')); });
      }, { sansAnnulation: true });
      toast('Suivi trains : ' + changes.join(' · '));
    }, function () { app.suiviTrains = { erreur: 'serveur injoignable', a: new Date() }; })
      .then(function () { app.suiviEnCours = 0; }, function () { app.suiviEnCours = 0; });
  }
  // ------------------------------------------------ coupons navettes (Suivi trains)
  /**
   * Coupons saisis dans le Suivi trains (bouton 🎫 Coupons, onglet « Coupons » de son classeur), relus avec le reste
   * toutes les 10 s : fenêtre 🎫 Coupons (par navette, total de wagons par site) et pastille sur chaque départ de navette
   * (LF1 « 🎫 3 · 54 wg »). Lecture seule ici : la saisie des coupons se fait dans le Suivi trains.
   */
  app.coupons = { jour: [], demain: [], date: null, a: null };
  app.ongletCoupons = 'jour';
  function majCoupons(data, date) {
    var avant = JSON.stringify([app.coupons.jour, app.coupons.demain]);
    app.coupons = { jour: data.coupons || [], demain: data.couponsDemain || [], date: date, a: new Date() };
    var c = $('#c-coupons');
    if (c) { c.textContent = app.coupons.jour.length; c.hidden = !app.coupons.jour.length; }
    if (avant !== JSON.stringify([app.coupons.jour, app.coupons.demain])) {
      if ($('#d-coupons').open) rendreCoupons();
      rendreCirculations();
    }
  }
  function couponsParNavette(liste) {
    var par = {};
    (liste || []).forEach(function (c) { var k = String(c.navette || '').toUpperCase(); (par[k] = par[k] || []).push(c); });
    return par;
  }
  function totalWagons(liste) { return (liste || []).reduce(function (s, c) { var w = parseFloat(c.wagons); return s + (isNaN(w) ? 0 : w); }, 0); }
  /** Pastille « 🎫 3 · 54 wg » d'une navette (départ) qui a des coupons, ou ''. */
  function pastilleCoupons(c, prep) {
    if (c.sens !== 'D' || (prep && prep !== 'demain')) return '';
    var liste = couponsParNavette(prep ? app.coupons.demain : app.coupons.jour)[String(c.code || '').toUpperCase()];
    if (!liste || !liste.length) return '';
    return '<span class="pastille-coupons" title="' + esc(liste.length + ' coupon(s) : ' + liste.map(function (x) { return x.numero + ' ' + x.site + ' ' + x.dateCoupon + ' · ' + x.wagons + ' wg'; }).join(' | ')) + '">🎫 ' +
      liste.length + ' · ' + totalWagons(liste) + ' wg</span>';
  }
  var SITES_COUPONS = [{ p: 'LF', site: 'LHTTDF', lib: 'TDF', coul: '#F28C28' }, { p: 'LN', site: 'LHTTMS', lib: 'TN', coul: '#2D8CFF' }, { p: 'LA', site: 'LHTATL', lib: 'ATL', coul: '#F2C230' }];
  function rendreCoupons() {
    var demain = app.ongletCoupons === 'demain', liste = demain ? app.coupons.demain : app.coupons.jour, par = couponsParNavette(liste);
    $$('#d-coupons [data-cp]').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-cp') === app.ongletCoupons)); });
    var cfg = app.params && app.params.suiviTrains;
    if (!cfg || !cfg.classeur) { $('#cp-corps').innerHTML = '<p class="note">Renseignez l\'adresse du classeur Suivi trains dans Paramètres pour reprendre ses coupons.</p>'; return; }
    if (!app.coupons.a) { $('#cp-corps').innerHTML = '<p class="note">Lecture du Suivi trains en cours…</p>'; return; }
    var blocs = SITES_COUPONS.map(function (s) {
      var navs = Object.keys(par).filter(function (k) { return k.indexOf(s.p) === 0; }).sort(function (a, b) { return parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10); });
      var tous = []; navs.forEach(function (k) { tous = tous.concat(par[k]); });
      var cartes = navs.map(function (k) {
        var l = par[k].slice().sort(function (a, b) { return (+a.ligne || 0) - (+b.ligne || 0); });
        return '<div class="cp-carte"><div class="cp-tete"><b>' + esc(k) + '</b><span>' + l.length + ' coupon' + (l.length > 1 ? 's' : '') + ' · <b>' + totalWagons(l) + '</b> wg</span></div>' +
          '<table class="cp-table"><thead><tr><th>C</th><th>N°</th><th>Site</th><th>Date</th><th>Wgs</th></tr></thead><tbody>' +
          l.map(function (x) { return '<tr><td>' + esc(x.ligne) + '</td><td class="mono"><b>' + esc(x.numero) + '</b></td><td>' + esc(x.site) + '</td><td class="mono">' + esc(x.dateCoupon) + '</td><td class="mono"><b>' + esc(x.wagons) + '</b>' + (x.note ? ' <small>' + esc(x.note) + '</small>' : '') + '</td></tr>'; }).join('') +
          '</tbody></table></div>';
      }).join('');
      return '<section class="cp-site" style="--g:' + s.coul + '"><h4>' + s.lib + ' <small>' + s.site + '</small><span>' + (tous.length ? tous.length + ' coupon' + (tous.length > 1 ? 's' : '') + ' · ' + totalWagons(tous) + ' wagons' : 'aucun coupon') + '</span></h4>' +
        (cartes ? '<div class="cp-cartes">' + cartes + '</div>' : '') + '</section>';
    }).join('');
    $('#cp-corps').innerHTML = (liste.length ? '<p class="cp-total">Total ' + (demain ? 'de demain' : 'du jour') + ' : <b>' + liste.length + '</b> coupons · <b>' + totalWagons(liste) + '</b> wagons</p>' : '<p class="note">Aucun coupon saisi pour ' + (demain ? 'demain' : 'aujourd\'hui') + ' dans le Suivi trains.</p>') + blocs;
    $('#cp-pied').textContent = 'Repris du Suivi trains (bouton 🎫 Coupons), relu toutes les 10 secondes · dernière lecture ' + hm(SC.iso(app.coupons.a)) + '.';
  }
  $('#b-coupons').addEventListener('click', function () { rendreCoupons(); ouvrir('#d-coupons'); });
  $$('#d-coupons [data-cp]').forEach(function (b) { b.addEventListener('click', function () { app.ongletCoupons = b.getAttribute('data-cp'); rendreCoupons(); }); });

  // ------------------------------------------------ travaux (avis envoyés par un autre service)
  var APPAREILS_TRAVAUX = [
    { code: 'RMG3', libelle: 'Le portique RMG3' }, { code: 'RMG4', libelle: 'Le portique RMG4' },
    { code: 'PF1', libelle: 'Le portique fluvial 1', alias: 'portique fluvial 1' }, { code: 'PF2', libelle: 'Le portique fluvial 2', alias: 'portique fluvial 2' },
    { code: 'PPMA', libelle: 'La PPM A', alias: 'PPM A' }, { code: 'PPMB', libelle: 'La PPM B', alias: 'PPM B' }, { code: 'PPMC', libelle: 'La PPM C', alias: 'PPM C' }
  ];
  var PHRASES_TRAVAUX = { orange: '{appareil} est actuellement en cours de maintenance.', rouge: '{appareil} est hors service pour le moment.' };
  function adresseTravaux(jeton) { return jeton && CONNEXION.url ? CONNEXION.url + (CONNEXION.url.indexOf('?') < 0 ? '?' : '&') + 'travaux=' + jeton : ''; }
  function remplirTravauxParametres(p) {
    var t = p.travaux || {}, apps = t.appareils && t.appareils.length ? t.appareils : APPAREILS_TRAVAUX, ph = Object.assign({}, PHRASES_TRAVAUX, t.phrases || {});
    $('#pa-tx-jeton').value = t.jeton || '';
    $('#pa-tx-url').value = adresseTravaux(t.jeton);
    $('#pa-tx-appareils').value = apps.map(function (a) { return [a.code, a.libelle, a.alias || ''].join(' | ').replace(/ \| $/, ''); }).join('\n');
    $('#pa-tx-orange').value = ph.orange; $('#pa-tx-rouge').value = ph.rouge;
    $('#pa-tx-essai-app').innerHTML = apps.map(function (a) { return '<option value="' + esc(a.code) + '">' + esc(a.code + ' · ' + a.libelle) + '</option>'; }).join('');
  }
  function lireTravauxParametres(p, err) {
    var apps = [];
    $('#pa-tx-appareils').value.split(/\r?\n/).forEach(function (l) {
      if (!l.trim()) return;
      var k = l.split('|').map(function (x) { return x.trim(); });
      if (!k[0]) { err.push('Travaux : ligne « ' + l + ' » sans code.'); return; }
      apps.push({ code: k[0].toUpperCase(), libelle: k[1] || k[0], alias: k[2] || '' });
    });
    p.travaux = { jeton: $('#pa-tx-jeton').value.trim(), appareils: apps, phrases: { orange: $('#pa-tx-orange').value.trim() || PHRASES_TRAVAUX.orange, rouge: $('#pa-tx-rouge').value.trim() || PHRASES_TRAVAUX.rouge } };
  }
  $('#pa-tx-generer').addEventListener('click', function () {
    if ($('#pa-tx-jeton').value && !confirm('Une nouvelle clé remplace l\'ancienne : l\'adresse déjà donnée au service ne marchera plus. Continuer ?')) return;
    var o = new Uint8Array(18); (window.crypto || window.msCrypto).getRandomValues(o);
    var j = Array.prototype.map.call(o, function (b) { return 'abcdefghijkmnpqrstuvwxyz23456789'.charAt(b % 32); }).join('');
    $('#pa-tx-jeton').value = j; $('#pa-tx-url').value = adresseTravaux(j);
    toast('Nouvelle clé d\'envoi : cliquez sur Enregistrer pour l\'activer.');
  });
  $('#pa-tx-url').addEventListener('focus', function () { this.select(); });
  $$('[data-tx-essai]').forEach(function (b) {
    b.addEventListener('click', function () {
      api('POST', '/api/travaux', JSON.stringify({ appareil: $('#pa-tx-essai-app').value, couleur: b.getAttribute('data-tx-essai'), message: 'essai depuis la saisie', creneau: $('#pa-tx-essai-cr').value.trim() })).then(function (r) {
        if (r.status !== 200) { toast('Essai refusé : ' + ((r.data && r.data.erreur) || r.status) + ' (serveur 2.6.0 ?)', 'crit'); return; }
        majTravauxSaisie(r.data.liste || []);
        toast('Essai envoyé : ' + r.data.appareil + ' ' + r.data.etat + '.');
      }, function () { toast('Serveur injoignable.', 'crit'); });
    });
  });
  /** Bandeau des avis en cours, sous l'en-tête de la saisie (relu toutes les 15 s). */
  function majTravauxSaisie(liste) {
    var el = $('#travaux-saisie');
    el.hidden = !liste.length;
    el.innerHTML = liste.length ? '<b>⚠ Travaux</b>' + liste.map(function (x) {
      return '<span class="tx-s ' + esc(x.couleur) + '"><i></i>' + esc(x.texte) + (x.creneau ? ' <b class="tx-cr">' + esc(x.creneau) + '</b>' : '') + (x.message ? ' <em>(' + esc(x.message) + ')</em>' : '') +
        ' <small>depuis ' + esc(hm(x.depuis)) + '</small> <button type="button" class="bouton petit" data-tx-fin="' + esc(x.code) + '" title="Retirer cet avis des écrans">Retirer</button></span>';
    }).join('') : '';
  }
  $('#travaux-saisie').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tx-fin]'); if (!b) return;
    api('POST', '/api/travaux', JSON.stringify({ appareil: b.getAttribute('data-tx-fin'), couleur: 'fin' })).then(function (r) { if (r.status === 200) majTravauxSaisie(r.data.liste || []); });
  });
  function lireTravaux() {
    if (!GOOGLE || !app.prete) return;
    api('GET', '/api/travaux').then(function (r) { if (r.status === 200) majTravauxSaisie(r.data.liste || []); }, function () { /* sans effet */ });
  }

  function reelSurSaisie() {
    var c = SC.trouverCirculation(app.journee, F.num.value);
    if (c && !SC.etatCirculation(c, app.journee).reel) { marquerReel(c.id); viderFormulaire(); F.num.focus(); return true; }
    return false;
  }
  function reelMouvement(id) {
    var m = mouvDe(app.journee, id); if (!m || m.reel) return;
    var t = maintenant();
    modifier('Ligne ' + m.n + ' : réel ' + hm(t), 'mouvement.reel', function (j) { mouvDe(j, id).reel = t; });
  }
  function supprimerMouvement(id) {
    var m = mouvDe(app.journee, id); if (!m) return;
    var restaurer = m.supprime;
    modifier('Ligne ' + m.n + (restaurer ? ' rétablie' : ' supprimée'), restaurer ? 'mouvement.retablissement' : 'mouvement.suppression', function (j) {
      var x = mouvDe(j, id); x.supprime = !restaurer; x.supprimeA = restaurer ? null : maintenant();
      if (restaurer) x.lien = lier(j, x);
    });
    if (!restaurer) toast('Ligne ' + m.n + ' supprimée.', null, { libelle: 'Annuler', fn: annuler });
  }

  // -------------------------------------------------------------- rendu
  function rendre() {
    if (!app.journee) return;
    rendreEntete(); rendreJournal(); rendreCirculations(); rendreEtats(); rendreBandeau(); remplirNumeros();
  }
  function rendreEntete() {
    var j = app.journee;
    $('#h-jour').textContent = SC.libelleJour(j.date) + ' ' + j.date.slice(0, 4) + (j.cloture ? ' · clôturée à ' + hm(j.cloture.a) : '');
    $('#h-lecture').hidden = !app.lectureSeule;
    $('#o-demain').textContent = SC.libellePrep(j.demain ? j.demain.date : SC.jourPrep(j.date, 1), j.date);
    $('#o-surlendemain').textContent = SC.libellePrep(j.surlendemain ? j.surlendemain.date : SC.jourPrep(j.date, 2), j.date);
    document.title = 'Saisie · ' + SC.libelleJour(j.date);
  }
  function rendreJournal() {
    var j = app.journee, voirSuppr = $('#j-supprimees').checked;
    var lignes = (j.mouvements || []).filter(function (m) { return voirSuppr || !m.supprime; });
    var html = lignes.map(function (m) {
      var c = m.lien ? circDe(j, m.lien) : null;
      var cls = [m.id === app.selection ? 'choisie' : '', m.id === app.nouvelle ? 'nouvelle' : '', m.supprime ? 'supprimee' : '', c ? 'colore' : ''].join(' ').trim();
      var teinte = c ? ' style="--g:' + couleur(c.groupe) + '"' : '';
      var actions = app.lectureSeule ? '' : (m.supprime
        ? '<button type="button" class="bouton petit" data-act="supprimer">Rétablir</button>'
        : (m.reel ? '' : '<button type="button" class="bouton petit" data-act="reel" title="Heure réelle = maintenant">Réel</button>') +
          '<button type="button" class="bouton petit" data-act="editer">Modifier</button><button type="button" class="bouton petit danger" data-act="supprimer">Suppr.</button>');
      var compo = m.compo === 'hlp' ? 'hlp' : (m.compo ? m.compo + ' <span class="faible">' + esc(m.cv || '') + '</span>' : '<span class="faible">—</span>');
      return '<tr data-id="' + m.id + '"' + (cls ? ' class="' + cls + '"' : '') + teinte + '>' +
        '<td class="faible">' + m.n + '</td><td class="mono">' + hm(m.annonce) + '</td><td class="mono"><b>' + esc(m.num) + '</b></td>' +
        '<td>' + esc(m.ef || '') + '</td><td class="mono voie">' + esc(m.voie || '') + '</td><td class="faible">' + esc(SC.deduireZone(m.num)) + '</td>' +
        '<td class="mono">' + compo + '</td><td>' + (m.sit === 'libre' ? '<span class="puce fait">libre</span>' : (m.sit ? '<span class="puce neutre">occupée</span>' : '')) + '</td>' +
        '<td class="mono">' + esc(m.vers || '') + '</td><td class="mono">' + (m.reel ? hm(m.reel) : '<span class="faible">—</span>') + '</td>' +
        '<td class="com">' + esc(m.comm || '') + '</td><td>' + (c ? '<span class="puce lien">' + esc(c.code) + '</span>' : '') + '</td>' +
        '<td><div class="act">' + actions + '</div></td></tr>';
    }).join('');
    $('#j-corps').innerHTML = html;
    $('#j-vide').hidden = lignes.length > 0;
    var actifs = SC.mouvementsActifs(j).length;
    $('#j-compte').textContent = actifs + ' mouvement' + (actifs > 1 ? 's' : '');
    if (app.nouvelle) {
      var tr = $('#j-corps tr[data-id="' + app.nouvelle + '"]');
      if (tr) tr.scrollIntoView({ block: 'nearest' });
      app.nouvelle = null;
    }
  }
  function bouton(act, libelle, titre, cl) {
    return '<button type="button" class="bouton petit' + (cl ? ' ' + cl : '') + '" data-act="' + act + '"' + (titre ? ' title="' + esc(titre) + '"' : '') + '>' + esc(libelle) + '</button>';
  }
  function boutonsCirculation(c, d, st) {
    if (app.lectureSeule) return '';
    if (st === 'nonprevu') return bouton('nonprevu', 'Rétablir', 'Elle circule finalement : de retour sur les écrans');
    if (st === 'supprime') return bouton('suppr', 'Rétablir');
    if (d.reel) return bouton('annuler-reel', 'Annuler', 'Retirer l\'heure réelle');
    var b = [];
    if (c.sens === 'A' && famille(c) === 'navette') {
      // navette : partie de son terminal, puis arrivée (les écrans suivent son parcours entre les deux)
      if (!c.partie) b.push(bouton('partie', 'Partie', 'La navette a quitté son terminal'));
      else b.push(bouton('reel', 'Arrivée', 'La navette est arrivée') + bouton('annuler-partie', '↺', 'Retirer l\'heure de départ ' + hm(c.partie)));
    } else if (c.sens === 'A') {
      // train : FA (arrivé au faisceau, pas chez nous) → En approche (parti de FA vers chez nous) → Arrivée (chez nous)
      b.push(bouton('fa', c.fa ? 'FA ✓ ' + hm(c.fa) : 'FA', c.fa ? 'Retirer l\'heure FA' : 'Arrivé à FA, pas encore chez nous', c.fa ? 'actif' : ''));
      b.push(bouton('deja', c.etat === 'deja' ? 'Pas là' : 'Déjà là', 'Déjà chez nous'));
      b.push(c.partie ? bouton('annuler-partie', 'Approche ✓ ' + hm(c.partie), 'Retirer l\'heure de départ de FA', 'actif')
        : bouton('partie', 'En approche', 'Parti de FA vers chez nous (délai du Suivi trains)'));
      b.push(bouton('reel', 'Arrivée', 'Arrivé chez nous'));
    } else {
      // navette au départ : ▲ annonce le départ sur les écrans TV (« Départ imminent » en grand), un second clic le retire
      if (famille(c) === 'navette') b.push(bouton('annoncer', c.annonceTV ? '▲ ' + hm(c.annonceTV) : '▲', c.annonceTV ? 'Retirer l\'annonce de départ des écrans' : 'Annoncer le départ sur les écrans TV (Départ imminent)', 'triangle' + (c.annonceTV ? ' actif' : '')));
      b.push(bouton('reel', 'Parti'));
      // étape ou « calé » venus du Suivi trains : effaçables ici (ils restent effacés jusqu'à une nouvelle heure)
      if (c.etape || c.cale) b.push(bouton('effacer-etape', '↺', 'Effacer « ' + (c.cale ? 'Calé' : c.etape.lib) + ' » des écrans'));
    }
    b.push(bouton('nonprevu', 'Non prévue', 'Ne circule pas aujourd\'hui : retirée des écrans', 'discret'));
    return b.join('');
  }
  function detailCirculation(c, d) {
    var g = groupe(c.groupe), dis = app.lectureSeule ? ' disabled' : '';
    var champ = function (k, lib, val, cl) { return '<div class="champ"><label>' + lib + '</label><input data-champ="' + k + '" class="' + (cl || 'mono') + '" value="' + esc(val == null ? '' : val) + '"' + dis + '></div>'; };
    var html = '<div class="detail" data-id="' + c.id + '"><div class="grille">' +
      champ('numero', 'N° interne du jour', c.numero) + champ('sillon', 'Sillon', c.sillon) + champ('reelManuel', 'Heure réelle', hm(d.reel)) + '</div>';
    if (c.sens === 'D' && g.famille === 'ligne') {
      html += '<div class="section"><h4>Déroulé du départ (repris dans le mail)</h4><div class="deroule">' + SC.DEROULE.map(function (e) {
        return '<div class="champ"><label>' + esc(e[1].replace(' à', '')) + '</label><div><input class="mono" data-deroule="' + e[0] + '" value="' + esc((c.deroule && c.deroule[e[0]]) || '') + '" placeholder="hh:mm"' + dis + '>' +
          (dis ? '' : '<button type="button" class="bouton petit" data-maintenant="' + e[0] + '">Maint.</button>') + '</div></div>';
      }).join('') + '</div></div>';
    }
    var type = SC.typeMail(c, app.planning), mst = type && c.mails && c.mails[type];
    html += '<div class="pied-detail">' +
      (type ? 'Mail : ' + (mst ? '<span class="puce ' + (mst.statut === 'erreur' ? 'erreur' : 'fait') + '">' + esc(mst.statut) + '</span> ' + hm(mst.a) + (mst.message ? ' · ' + esc(mst.message) : '') : '<span class="puce neutre">pas encore</span>') : 'Pas de mail pour cette circulation') +
      (type && d.reel && !dis ? ' <button type="button" class="bouton petit" data-act="renvoyer">' + (mst ? 'Renvoyer le mail' : 'Envoyer le mail') + '</button>' : '') +
      ' · ' + d.liens + ' mouvement' + (d.liens > 1 ? 's' : '') + ' rattaché' + (d.liens > 1 ? 's' : '') + (d.annonce ? ' · annonce ' + hm(d.annonce) : '') +
      (dis || d.reel ? '' : ' <button type="button" class="bouton petit danger" data-act="suppr">Supprimer cette circulation</button>') + '</div></div>';
    return html;
  }
  function estPrep(onglet) { return onglet === 'demain' || onglet === 'surlendemain'; }
  /** Préparation de demain ou d'après-demain (créée depuis le planning si besoin). */
  function prepDe(j, cle) { return cle === 'surlendemain' ? SC.assurerSurlendemain(j, app.planning) : j.demain; }
  function circPrepDe(j, cle, id) { return ((prepDe(j, cle) || {}).circulations || []).filter(function (c) { return c.id === id; })[0] || null; }
  function couleur(gid) { return SC.couleurGroupe(groupe(gid), (app.params && app.params.visuel) || {}); }
  /** Ligne du tableau de référence : heure, HLR, wagons et voie se modifient sur place et alimentent les écrans. */
  function ligneCirculation(c, prep) {
    var j = app.journee;
    var d = prep ? { annonce: null, reel: null, voie: null, wagons: null, liens: 0 } : SC.etatCirculation(c, j);
    var st = prep ? (c.etat === 'nonprevu' || c.etat === 'supprime' ? c.etat : 'prevu') : SC.statutCirculation(c, d, maintenant(), seuil());
    var attr = prep ? 'data-demain' : 'data-champ', dis = app.lectureSeule ? ' disabled' : '';
    var saisie = function (k, val, indice, titre) {
      return '<input class="mono" ' + attr + '="' + k + '" value="' + esc(val == null ? '' : val) + '"' + (indice ? ' placeholder="' + esc(indice) + '"' : '') + ' title="' + esc(titre) + '"' + dis + '>';
    };
    var etat = SC.libelleStatut(st, c.sens) + (d.reel ? ' ' + hm(d.reel) : '');
    var actif = !prep && !d.reel && st !== 'supprime' && st !== 'nonprevu';
    if (actif && c.fa && !c.partie) { etat = 'À FA ' + hm(c.fa); st = 'annonce'; }
    if (actif && c.partie) { etat = (famille(c) === 'navette' ? 'En route' : 'En approche') + ' · dép. ' + hm(c.partie); st = 'annonce'; }
    if (actif && c.etape) etat = c.etape.lib + ' ' + c.etape.h;
    if (actif && c.cale) { etat = 'Calé à ' + hm(c.cale); st = 'retard'; }
    var boutons = prep ? (app.lectureSeule ? '' : bouton('nonprevu-prep', c.etat === 'nonprevu' ? 'Rétablir' : 'Non prévue', 'Retirée des écrans', 'discret') +
      (c.etat === 'nonprevu' ? '' : bouton('suppr-demain', c.etat === 'supprime' ? 'Rétablir' : 'Suppr.', '', 'danger')))
      : boutonsCirculation(c, d, st);
    var ouverte = !prep && app.ouverte === c.id;
    return '<div class="circ colore' + (st === 'supprime' ? ' supprimee' : '') + (st === 'nonprevu' ? ' nonprevue' : '') + (ouverte ? ' ouverte' : '') + '" data-id="' + c.id + '"' +
      (prep ? ' data-ligne-demain="1" data-prep="' + prep + '"' : '') + ' style="--g:' + couleur(c.groupe) + '">' +
      '<span class="code" title="' + esc(c.code) + '">' + esc(c.code) + pastilleCoupons(c, prep) + '</span><span class="sens">' + (c.sens === 'D' ? 'Dép.' : 'Arr.') + '</span>' +
      '<span class="num">' + esc(c.numero || c.sillon || '') + '</span>' +
      // pas de HLR pour une arrivée
      saisie('theo', hm(c.theo), 'hh:mm', 'Heure prévue') + (c.sens === 'D' ? saisie('hlr', c.hlr, 'hh:mm', 'HLR') : '<span class="c-hlr"></span>') +
      saisie('wagonsDemandes', c.wagonsDemandes, d.wagons != null ? String(d.wagons) : '', 'Wagons affichés sur les écrans' + (d.wagons != null ? ' (réels : ' + d.wagons + ')' : '')) +
      saisie('voiePrevue', c.voiePrevue, d.voie ? String(d.voie).toUpperCase() : '', 'Voie affichée sur les écrans' + (d.voie ? ' (réelle : ' + String(d.voie).toUpperCase() + ')' : '')) +
      '<span class="etat-c" title="' + esc(etat) + '"><span class="puce ' + st + '">' + esc(etat) + '</span></span>' +
      '<span class="boutons">' + boutons + '</span></div>' + (ouverte ? detailCirculation(c, d) : '');
  }
  /** Choix gardé pour Navettes et Trains de ligne : un groupe (ou tous) puis départs, arrivées (ou tous). */
  function vueDe(fam) {
    var v = app.vue[fam] || (app.vue[fam] = { groupe: fam === 'navette' ? '' : 'tous', sens: fam === 'navette' ? 'D' : 'A' });
    var ids = (app.planning.groupes || []).filter(function (g) { return g.famille === fam; }).map(function (g) { return g.id; });
    if (v.groupe !== 'tous' && ids.indexOf(v.groupe) < 0) v.groupe = ids[0] || 'tous';
    if (['D', 'A', 'tous'].indexOf(v.sens) < 0) v.sens = 'D';
    return v;
  }
  function sensDe(c) { return c.sens === 'D' ? 'D' : 'A'; }
  /** Boutons de choix ; le badge compte ce qui reste à faire (rouge s'il y a un retard). */
  function barreFiltres(fam, v, circs) {
    var j = app.journee, t = maintenant();
    var reste = function (liste) {
      var n = 0, retard = false;
      liste.forEach(function (c) {
        var st = SC.statutCirculation(c, SC.etatCirculation(c, j), t, seuil());
        if (st !== 'fait' && st !== 'supprime' && st !== 'nonprevu') { n++; if (st === 'retard') retard = true; }
      });
      return n ? '<span class="nb' + (retard ? ' retard' : '') + '">' + n + '</span>' : '';
    };
    // navettes : les trois groupes ; trains : seulement les EF qui circulent aujourd'hui
    var groupes = (app.planning.groupes || []).filter(function (g) {
      return g.famille === fam && (fam === 'navette' || circs.some(function (c) { return c.groupe === g.id; }));
    });
    var dansGroupe = v.groupe === 'tous' ? circs : circs.filter(function (c) { return c.groupe === v.groupe; });
    return '<div class="filtre-ligne">' + groupes.map(function (g) {
      return '<button type="button" class="filtre' + (v.groupe === g.id ? ' choisi' : '') + '" data-groupe="' + esc(g.id) + '" style="--g:' + couleur(g.id) + '">' +
        esc(g.libelle.replace(/^navettes?s+/i, '')) + reste(circs.filter(function (c) { return c.groupe === g.id; })) + '</button>';
    }).join('') + '<button type="button" class="filtre tous' + (v.groupe === 'tous' ? ' choisi' : '') + '" data-groupe="tous">Tous' + reste(circs) + '</button></div>' +
      '<div class="filtre-ligne">' + [['D', 'Départs'], ['A', 'Arrivées'], ['tous', 'Tous']].map(function (x) {
        var part = x[0] === 'tous' ? dansGroupe : dansGroupe.filter(function (c) { return sensDe(c) === x[0]; });
        return '<button type="button" class="filtre sens' + (x[0] === 'tous' ? ' tous' : '') + (v.sens === x[0] ? ' choisi' : '') + '" data-sens="' + x[0] + '">' + x[1] + reste(part) + '</button>';
      }).join('') + '</div>';
  }
  function rendreCirculations() {
    // onglet cliqué pendant le chargement : la journée n'est pas encore là
    if (!app.journee) return;
    var j = app.journee, prep = estPrep(app.onglet) ? app.onglet : null, demain = !!prep;
    var liste = prep ? ((prepDe(j, prep) || {}).circulations || []) : j.circulations.filter(function (c) { return famille(c) === app.onglet; });
    var v = prep ? null : vueDe(app.onglet), unSens = !!v && v.sens !== 'tous';
    $('#p-filtres').hidden = !v;
    if (v) {
      $('#p-filtres').innerHTML = barreFiltres(app.onglet, v, liste);
      liste = liste.filter(function (c) { return (v.groupe === 'tous' || c.groupe === v.groupe) && (!unSens || sensDe(c) === v.sens); });
    }
    var jourRef = prep ? prepDe(j, prep).date : j.date, nomJour = SC.JOURS[SC.jourSemaine(jourRef) - 1];
    var notes = '';
    if (demain) {
      var dis = app.lectureSeule ? ' disabled' : '';
      notes = '<div class="notes-prochaines"><b>Texte libre sous « Prochaines navettes » sur les écrans :</b>' +
        (app.planning.groupes || []).filter(function (g) { return g.famille === 'navette'; }).map(function (g) {
          return '<label>' + esc(g.libelle) + '<input data-note="' + esc(g.id) + '" maxlength="90" placeholder="ex. Mercredi : 4 navettes" value="' + esc((j.notesProchaines || {})[g.id] || '') + '"' + dis + '></label>';
        }).join('') + '</div>';
    }
    var html = notes + '<div class="ajout note">' + (demain ? 'Préparation du ' + esc(SC.libelleJour(jourRef)) + '. Heure, HLR, wagons et voie se modifient sur place. ' : '') +
      (app.lectureSeule ? '' : '<button type="button" class="bouton petit" data-act="memoriser" title="Ces wagons et voies seront repris automatiquement les prochains ' + nomJour + 's">Garder pour tous les ' + nomJour + 's</button>' +
        (demain ? ' <button type="button" class="bouton petit" data-act="regenerer">Régénérer depuis le planning</button>' : '')) + '</div>' +
      '<div class="circ entete"><span>Code</span><span class="sens">Sens</span><span>N°</span><span>Heure</span><span class="c-hlr">HLR</span><span>Wagons</span><span>Voie</span><span>État</span><span></span></div>';
    (app.planning.groupes || []).forEach(function (g) {
      var circs = liste.filter(function (c) { return c.groupe === g.id; });
      if (!circs.length) return;
      circs.sort(function (a, b) { return (a.theo || '9') < (b.theo || '9') ? -1 : 1; });
      html += '<div class="groupe" style="--g:' + couleur(g.id) + '">' + esc(g.libelle) + '</div>';
      // arrivées puis départs, séparés ; pour demain et après-demain, les navettes n'ont que leurs départs
      (prep && g.famille === 'navette' ? [['D', 'Départs']] : [['A', 'Arrivées'], ['D', 'Départs']]).forEach(function (s) {
        var part = circs.filter(function (c) { return (c.sens === 'D' ? 'D' : 'A') === s[0]; });
        // un seul sens affiché : pas de sous-titre « Départs » / « Arrivées »
        if (part.length) html += (unSens ? '' : '<div class="sous-groupe" style="--g:' + couleur(g.id) + '">' + s[1] + '</div>') + part.map(function (c) { return ligneCirculation(c, prep); }).join('');
      });
    });
    if (!liste.length) html += '<div class="vide">' + (v ? 'Rien pour ce choix aujourd\'hui.' : 'Aucune circulation prévue.') + ' « + Ajouter » permet d\'ajouter une circulation du planning ou exceptionnelle.</div>';
    var defile = $('#p-liste'), haut = defile.scrollTop;
    defile.className = 'defile' + (unSens ? ' vue-' + v.sens : '');
    var actif = document.activeElement, cle = actif && actif.closest && actif.closest('#p-liste') ? (actif.getAttribute('data-champ') || actif.getAttribute('data-deroule') || actif.getAttribute('data-demain')) : null;
    var cleId = cle ? (actif.closest('[data-id]') || {}).getAttribute('data-id') : null;
    defile.innerHTML = html;
    defile.scrollTop = haut;
    if (cle && cleId) {
      var el = defile.querySelector('[data-id="' + cleId + '"] [data-champ="' + cle + '"], [data-id="' + cleId + '"] [data-deroule="' + cle + '"], [data-id="' + cleId + '"] [data-demain="' + cle + '"]');
      if (el) el.focus();
    }
  }
  function placerEtat(id, classe, texte) {
    var el = $(id); el.className = 'etat ' + classe; el.querySelector('span').textContent = texte;
  }
  function rendreEtats() {
    if (app.serviceOk === false) placerEtat('#e-service', 'crit', 'injoignable');
    else if (app.sauvegarde.evenements.length || app.sauvegarde.enCours) placerEtat('#e-service', 'attente', 'enregistrement…');
    else placerEtat('#e-service', app.serviceOk ? 'ok' : '', app.serviceOk ? 'enregistré' : '…');
    var dif = (app.diffusion || []).filter(function (x) { return x.ok || !/en attente/.test(x.erreur || ''); });
    var ok = dif.filter(function (x) { return x.ok; });
    if (app.lectureSeule) placerEtat('#e-ecrans', '', 'journée passée non diffusée');
    else if (!dif.length) placerEtat('#e-ecrans', 'attente', 'publication…');
    else if (ok.length === dif.length) placerEtat('#e-ecrans', 'ok', 'publié ' + (ok[0].a ? ok[0].a.slice(11) : ''));
    else if (ok.length) placerEtat('#e-ecrans', 'alerte', (dif.length - ok.length) + ' dossier injoignable');
    else placerEtat('#e-ecrans', 'crit', 'partage injoignable');
    var mode = ((app.params && app.params.mails) || {}).mode || 'simulation';
    var erreurs = 0, total = 0;
    if (app.journee) app.journee.circulations.forEach(function (c) { var t = SC.typeMail(c, app.planning), m = t && c.mails && c.mails[t]; if (m) { total++; if (m.statut === 'erreur') erreurs++; } });
    var libMode = { simulation: 'simulation', brouillon: 'brouillons Outlook', auto: 'automatiques', desactive: 'désactivés' }[mode] || mode;
    placerEtat('#e-mails', erreurs ? 'crit' : (mode === 'auto' ? 'ok' : 'alerte'), libMode + (erreurs ? ' · ' + erreurs + ' en erreur' : ''));
    var cm = $('#c-mails'); cm.hidden = !total; cm.textContent = total;
  }
  function rendreBandeau() {
    var b = $('#bandeau'), j = app.journee;
    var html = '', classe = '';
    if (app.serviceOk === false) {
      classe = 'crit';
      html = GOOGLE ? '<span>Serveur Google injoignable (Internet ?) : les saisies sont gardées dans ce navigateur et seront transmises à son retour.</span>'
        : '<span>Service local injoignable : les saisies sont gardées dans ce navigateur et seront transmises à son retour. Relancez « Demarrer-Saisie » si la fenêtre du service a été fermée.</span>';
    } else if (app.lectureSeule && j) {
      classe = 'alerte';
      html = '<span>Journée du ' + esc(SC.libelleJour(j.date)) + ' en lecture seule.</span><button type="button" data-act="aujourdhui">Revenir à la journée en cours</button>';
    } else if (j && SC.cleDate(new Date()) > j.date) {
      classe = 'info';
      html = '<span>Nous sommes le ' + esc(SC.libelleJour(SC.cleDate(new Date()))) + '. La journée affichée est celle du ' + esc(SC.libelleJour(j.date)) + '.</span><button type="button" data-act="nouvelle">Clôturer et ouvrir la nouvelle journée</button>';
    }
    b.className = 'bandeau ' + classe; b.hidden = !html; b.innerHTML = html;
  }
  function horloge() {
    var d = new Date();
    $('#h-horloge').textContent = SC.iso(d).slice(11);
  }

  // ------------------------------------------------------------ dialogues
  function ouvrir(id) { var d = $(id); if (!d.open) d.showModal(); }
  function fermer(el) { var d = el.closest('dialog'); if (d) d.close(); }
  $$('[data-fermer]').forEach(function (b) { b.addEventListener('click', function () { fermer(b); }); });

  // Flash info
  var PHRASES_FLASH = [
    'Travaux RFP en cours : entrée et sortie du terminal impossibles',
    'Travaux sur le site : entrée et sortie impossibles',
    'Dérangement des installations de sécurité',
    'Défaillance des installations de sécurité',
    'Défaillance de la caténaire : entrée et sortie en machine électrique impossibles, les machines thermiques ne sont pas impactées',
    'Coupure de la caténaire programmée : circulations en traction thermique uniquement',
    'Circulations ralenties sur le faisceau : marche à vue',
    'Manœuvres en cours : attendre l\'autorisation avant toute entrée sur le faisceau',
    'Voie neutralisée',
    'Aiguillage hors service',
    'Intempéries : circulations perturbées, retards possibles',
    'Mouvement social : circulations perturbées'
  ];
  function phrasesFlash() { var l = ((app.params || {}).visuel || {}).phrasesFlash; return l && l.length ? l : PHRASES_FLASH; }
  /** 08:00 → 8h, 13:30 → 13h30 */
  function hFr(h) { var m = /^(\d\d):(\d\d)$/.exec(h || ''); return m ? (+m[1]) + 'h' + (m[2] === '00' ? '' : m[2]) : ''; }
  /** Texte publié : phrase + complément + créneau (si coché). */
  function texteFlash() {
    var base = $('#fl-texte').value.trim().replace(/[\s.;,:]+$/, ''), comp = $('#fl-complement').value.trim();
    var de = SC.normHeure($('#fl-de').value.trim()), jq = SC.normHeure($('#fl-jusqua').value.trim()), cr = '';
    if ($('#fl-creneau-texte').checked) cr = de && jq ? 'de ' + hFr(de) + ' à ' + hFr(jq) : (jq ? 'jusqu\'à ' + hFr(jq) : (de ? 'à partir de ' + hFr(de) : ''));
    return [base, comp].filter(Boolean).join(' ') + (base || comp ? (cr ? ' — ' + cr : '') : '');
  }
  function majApercuFlash() { var t = texteFlash(); $('#fl-apercu').textContent = t || '—'; }
  $('#b-flash').addEventListener('click', function () {
    var f = app.journee.flash || {};
    $('#fl-texte').value = f.base != null ? f.base : (f.texte || ''); $('#fl-complement').value = f.complement || '';
    $('#fl-de').value = f.de || ''; $('#fl-jusqua').value = f.jusqua || '';
    $('#fl-creneau-texte').checked = f.creneauTexte !== false;
    $('#fl-actif').checked = true;
    $('#fl-phrases').innerHTML = phrasesFlash().map(function (ph, i) { return '<button type="button" class="fl-ph" data-fl-ph="' + i + '">' + esc(ph) + '</button>'; }).join('');
    $('#fl-etat').textContent = f.actif && f.texte ? 'Affiché actuellement' + (f.de ? ' de ' + f.de : '') + (f.jusqua ? ' jusqu\'à ' + f.jusqua : '') : 'Aucun flash affiché';
    majApercuFlash();
    ouvrir('#d-flash'); $('#fl-texte').focus();
  });
  $('#fl-phrases').addEventListener('click', function (e) {
    var b = e.target.closest('[data-fl-ph]'); if (!b) return;
    $('#fl-texte').value = phrasesFlash()[+b.getAttribute('data-fl-ph')] || '';
    majApercuFlash(); $('#fl-complement').focus();
  });
  $$('[data-fl-cr]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-fl-cr'), m = /^maintenant-(\d)$/.exec(v);
      if (m) { var d = new Date(); $('#fl-de').value = SC.hm(SC.iso(d)); d.setHours(d.getHours() + +m[1]); $('#fl-jusqua').value = SC.hm(SC.iso(d)); }
      else { $('#fl-de').value = v.split('-')[0] || ''; $('#fl-jusqua').value = v.split('-')[1] || ''; }
      majApercuFlash();
    });
  });
  ['#fl-texte', '#fl-complement', '#fl-de', '#fl-jusqua'].forEach(function (s) { $(s).addEventListener('input', majApercuFlash); });
  $('#fl-creneau-texte').addEventListener('change', majApercuFlash);
  $('#fm-flash').addEventListener('submit', function (e) {
    e.preventDefault();
    var jusqua = $('#fl-jusqua').value.trim(), de = $('#fl-de').value.trim();
    if (jusqua && !SC.normHeure(jusqua)) { $('#fl-etat').textContent = 'Heure de fin invalide.'; return; }
    if (de && !SC.normHeure(de)) { $('#fl-etat').textContent = 'Heure de début invalide.'; return; }
    var texte = texteFlash(), base = $('#fl-texte').value.trim(), comp = $('#fl-complement').value.trim(), cr = $('#fl-creneau-texte').checked;
    modifier(texte ? 'Flash info publié' : 'Flash info vidé', 'flash', function (j) {
      j.flash = { actif: $('#fl-actif').checked && !!texte, texte: texte, base: base, complement: comp, creneauTexte: cr,
        de: SC.normHeure(de) || '', jusqua: SC.normHeure(jusqua) || '', depuis: maintenant() };
    });
    fermer($('#fm-flash'));
  });
  $('#fl-retirer').addEventListener('click', function () {
    modifier('Flash info retiré', 'flash', function (j) { var f = j.flash || {}; j.flash = { actif: false, texte: f.texte || '', base: f.base, complement: f.complement || '', creneauTexte: f.creneauTexte, de: '', jusqua: '' }; });
    fermer($('#fl-retirer'));
  });

  // Mails
  var LIB_TYPE = { navetteDepart: 'Départ navette', ligneArrivee: 'Arrivée train', ligneDepart: 'Départ train' };
  function rendreMails() {
    var mode = (app.params.mails || {}).mode || 'simulation';
    var texteMode = {
      simulation: '<b>Mode simulation</b> : aucun mail ne part. Chaque mail est enregistré dans <span class="mono">donnees\\boite-envoi</span>. Passez en envoi automatique dans Paramètres quand le contenu vous convient.',
      brouillon: '<b>Brouillons Outlook</b> : chaque mail est créé dans le dossier Brouillons d\'Outlook, à envoyer vous-même.',
      auto: '<b>Envoi automatique</b> : les mails partent par Outlook dès la saisie de l\'heure réelle.',
      desactive: '<b>Mails désactivés.</b>'
    }[mode] || mode;
    $('#m-mode').innerHTML = '<span>' + texteMode + '</span>';
    var lignes = [];
    app.journee.circulations.forEach(function (c) {
      var type = SC.typeMail(c, app.planning); if (!type) return;
      var d = SC.etatCirculation(c, app.journee);
      var st = c.mails && c.mails[type];
      if (!st && !d.reel) return;
      var mail = SC.construireMail(app.journee, c, app.planning, app.params);
      lignes.push({ c: c, type: type, st: st, mail: mail, h: (st && st.a) || d.reel || '' });
    });
    lignes.sort(function (a, b) { return a.h < b.h ? 1 : -1; });
    $('#m-corps').innerHTML = lignes.length ? lignes.map(function (l) {
      var statut = l.st ? l.st.statut : (l.mail ? 'en attente' : 'sans destinataire');
      return '<tr data-id="' + l.c.id + '"><td class="mono">' + hm(l.h) + '</td><td><b>' + esc(l.c.code) + '</b> ' + esc(groupe(l.c.groupe).libelle) + '</td><td>' + LIB_TYPE[l.type] + '</td>' +
        '<td>' + esc((l.st && l.st.sujet) || (l.mail && l.mail.sujet) || '') + '</td><td><span class="puce ' + (statut === 'erreur' ? 'erreur' : (l.st ? 'fait' : 'neutre')) + '">' + esc(statut) + '</span>' + (l.st && l.st.message ? ' ' + esc(l.st.message) : '') + '</td>' +
        '<td style="white-space:nowrap">' + (l.mail ? '<button type="button" class="bouton petit" data-act="apercu">Aperçu</button> ' : '') +
        (l.mail && !app.lectureSeule ? '<button type="button" class="bouton petit" data-act="renvoyer">' + (l.st ? 'Renvoyer' : 'Envoyer') + '</button>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="vide">Aucun mail pour l\'instant.</td></tr>';
  }
  $('#b-mails').addEventListener('click', function () { $('#m-apercu').hidden = true; rendreMails(); ouvrir('#d-mails'); });
  $('#m-corps').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]'); if (!b) return;
    var c = circDe(app.journee, b.closest('tr').getAttribute('data-id')); if (!c) return;
    if (b.getAttribute('data-act') === 'apercu') {
      var m = SC.construireMail(app.journee, c, app.planning, app.params);
      var f = $('#m-apercu');
      f.srcdoc = '<div style="font:12px Consolas,monospace;background:#eef;padding:8px;margin-bottom:10px">À : ' + esc(m.to.join('; ')) + (m.cc.length ? '<br>Cc : ' + esc(m.cc.join('; ')) : '') +
        (m.bcc.length ? '<br>Cci : ' + esc(m.bcc.join('; ')) : '') + '<br>Objet : ' + esc(m.sujet) + '</div>' + m.html.replace('<!--signature-->', '<p style="color:#888">[signature]</p>');
      f.hidden = false;
    } else {
      var type = SC.typeMail(c, app.planning);
      envoyerMail(c, c.mails && c.mails[type] ? 'r' + Date.now().toString(36) : null);
      setTimeout(rendreMails, 800);
    }
  });

  // Statistiques
  $('#b-stats').addEventListener('click', function () {
    var s = SC.statistiques(app.journee, app.planning, app.params), cp = (app.params.exploitation || {}).coupurePoste || '13:30';
    var l = function (lib, o) {
      var m = o.matin.hlp + o.matin.charge, a = o.apresMidi.hlp + o.apresMidi.charge;
      return '<tr><td>' + lib + '</td><td>' + o.matin.hlp + '</td><td>' + o.matin.charge + '</td><td><b>' + m + '</b></td><td>' + o.apresMidi.hlp + '</td><td>' + o.apresMidi.charge + '</td><td><b>' + a + '</b></td>' +
        '<td>' + (o.matin.hlp + o.apresMidi.hlp) + '</td><td>' + (o.matin.charge + o.apresMidi.charge) + '</td><td><b>' + (m + a) + '</b></td></tr>';
    };
    // LHTE (locom, loco), locosup et manœuvres NRS : HLP ou chargé, matin ou après-midi, puis la journée
    $('#st-corps').innerHTML = '<div class="section"><h4>Mouvements de locomotive (coupure ' + esc(cp) + ')</h4><div class="tableau"><table class="stats"><thead><tr><th></th><th>Matin HLP</th><th>Matin chargé</th><th>Matin total</th><th>Après-midi HLP</th><th>Après-midi chargé</th><th>Après-midi total</th><th>Jour HLP</th><th>Jour chargé</th><th>Jour total</th></tr></thead><tbody>' +
      l('LHTE (locom, loco)', s.locom) + l('Locosup', s.locosup) + l('NRS (nrs1, nrs2…)', s.nrs) + '</tbody></table></div></div>' +
      '<div class="section"><h4>Journée</h4><div class="tableau"><table class="stats"><tbody>' +
      [['Mouvements saisis', s.mouvements], ['Trains numérotés', s.trainsNumerotes], ['Manœuvres NRS', s.manoeuvresNrs], ['Mouvements HLP', s.hlp],
        ['Circulations prévues', s.circulationsPrevues], ['Réalisées', s.realisees], ['Supprimées', s.supprimees], ['Déjà là', s.dejaLa],
        ['Écart moyen des navettes (min)', s.retardMoyenNavettes == null ? '—' : s.retardMoyenNavettes], ['Écart maximal des navettes (min)', s.retardMaxNavettes == null ? '—' : s.retardMaxNavettes]]
        .map(function (r) { return '<tr><td>' + r[0] + '</td><td><b>' + r[1] + '</b></td></tr>'; }).join('') + '</tbody></table></div></div>';
    ouvrir('#d-stats');
  });

  // Planning
  /** Numéro qui change selon le jour : n° interne pour une navette, sillon pour un train de ligne (n° interne à défaut). */
  function cleNumero(fam, sillon) { return fam === 'navette' || !sillon ? 'numero' : 'sillon'; }
  /** Deux lignes par circulation : les réglages, puis les numéros jour par jour (vide = numéro habituel). */
  function lignePlanning(pc) {
    var opts = (app.planning.groupes || []).map(function (g) { return '<option value="' + esc(g.id) + '"' + (g.id === pc.groupe ? ' selected' : '') + '>' + esc(g.libelle) + '</option>'; }).join('');
    var jours = SC.JOURS_COURTS.map(function (j, i) { return '<label>' + j.slice(0, 2) + '<input type="checkbox" data-jour="' + (i + 1) + '"' + ((pc.jours || []).indexOf(i + 1) >= 0 ? ' checked' : '') + '></label>'; }).join('');
    var inp = function (k, v, w) { return '<td><input data-k="' + k + '" value="' + esc(v == null ? '' : v) + '" class="mono" style="min-width:' + (w || 60) + 'px"></td>'; };
    var cle = cleNumero(groupe(pc.groupe).famille, pc.sillon), base = pc[cle] || '';
    // les numéros par jour sont tirés des variantes ; le reste des variantes reste en texte
    var autres = (pc.variantes || []).map(function (va) { var x = SC.copie(va); delete x[cle]; return x; }).filter(function (x) { return Object.keys(x).length > 1; });
    var parJour = SC.JOURS_COURTS.map(function (j, i) {
      var n = SC.appliquerVariantes(pc, i + 1)[cle] || '';
      return '<label>' + j.slice(0, 2) + '<input data-numjour="' + (i + 1) + '" class="mono" value="' + esc(n && n !== base ? n : '') + '" placeholder="' + esc(base) + '"></label>';
    }).join('');
    var teinte = ' style="--g:' + couleur(pc.groupe) + '"';
    return '<tr data-id="' + esc(pc.id) + '"' + teinte + '><td><select data-k="groupe">' + opts + '</select></td>' + inp('code', pc.code, 70) +
      '<td><select data-k="sens"><option value="A"' + (pc.sens === 'A' ? ' selected' : '') + '>Arr.</option><option value="D"' + (pc.sens === 'D' ? ' selected' : '') + '>Dép.</option></select></td>' +
      inp('numero', pc.numero, 70) + inp('sillon', pc.sillon, 64) + inp('hlr', pc.hlr, 52) + inp('heure', pc.heure, 52) + '<td class="jours">' + jours + '</td>' +
      inp('wagonsDemandes', pc.wagonsDemandes, 44) + inp('voiePrevue', pc.voiePrevue, 54) + inp('variantes', SC.variantesEnTexte(autres), 150) +
      '<td><button type="button" class="bouton petit danger" data-act="retirer">Retirer</button></td></tr>' +
      '<tr class="pl-jours"' + teinte + '><td colspan="12"><span class="faible">' + (cle === 'sillon' ? 'Sillon' : 'N°') + ' par jour (vide = ' + esc(base || 'le n° habituel') + ') :</span> ' + parJour + '</td></tr>';
  }
  $('#b-planning').addEventListener('click', ouvrirPlanning);
  $('#pa-planning').addEventListener('click', function () { fermer($('#fm-params')); ouvrirPlanning(); });
  function ouvrirPlanning() {
    $('#pl-corps').innerHTML = (app.planning.circulations || []).map(lignePlanning).join('');
    $('#pl-erreur').textContent = '';
    ouvrir('#d-planning');
  }
  $('#pl-ajouter').addEventListener('click', function () {
    var t = document.createElement('tbody');
    t.innerHTML = lignePlanning({ id: uid('p'), groupe: (app.planning.groupes[0] || {}).id, code: '', sens: 'A', numero: '', sillon: '', hlr: '', heure: '', jours: [1, 2, 3, 4, 5], variantes: [] });
    while (t.firstChild) $('#pl-corps').appendChild(t.firstChild);
  });
  $('#pl-corps').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act="retirer"]'); if (!b) return;
    var tr = b.closest('tr'), suite = tr.nextElementSibling;
    if (suite && suite.classList.contains('pl-jours')) suite.remove();
    tr.remove();
  });
  function lirePlanning() {
    var erreurs = [], circs = [];
    $$('#pl-corps tr[data-id]').forEach(function (tr, i) {
      var v = function (k) { return tr.querySelector('[data-k="' + k + '"]').value.trim(); };
      var pc = { id: tr.getAttribute('data-id'), groupe: v('groupe'), code: v('code'), sens: v('sens'), numero: v('numero'), sillon: v('sillon'), hlr: '', heure: '', jours: [], variantes: [], wagonsDemandes: null, voiePrevue: v('voiePrevue') };
      if (!pc.code) erreurs.push('Ligne ' + (i + 1) + ' : code manquant.');
      ['hlr', 'heure'].forEach(function (k) { var x = v(k); if (x && !SC.normHeure(x)) erreurs.push('Ligne ' + (i + 1) + ' : heure « ' + x + ' » invalide.'); pc[k] = SC.normHeure(x) || ''; });
      $$('[data-jour]', tr).forEach(function (cb) { if (cb.checked) pc.jours.push(+cb.getAttribute('data-jour')); });
      var w = v('wagonsDemandes'); if (w) { if (!/^\d+$/.test(w)) erreurs.push('Ligne ' + (i + 1) + ' : wagons invalides.'); pc.wagonsDemandes = +w; }
      try { pc.variantes = SC.texteEnVariantes(v('variantes')); } catch (err) { erreurs.push('Ligne ' + (i + 1) + ' : ' + err.message); }
      // numéros jour par jour → une variante par numéro différent du numéro habituel
      var cle = cleNumero(groupe(pc.groupe).famille, pc.sillon), parNum = {}, suite = tr.nextElementSibling;
      if (suite && suite.classList.contains('pl-jours')) $$('[data-numjour]', suite).forEach(function (inp) {
        var n = inp.value.trim();
        if (n && n !== pc[cle]) (parNum[n] = parNum[n] || []).push(+inp.getAttribute('data-numjour'));
      });
      Object.keys(parNum).forEach(function (n) { var va = { jours: parNum[n] }; va[cle] = n; pc.variantes.push(va); });
      circs.push(pc);
    });
    return { erreurs: erreurs, planning: { schema: 1, groupes: app.planning.groupes, circulations: circs } };
  }
  $('#fm-planning').addEventListener('submit', function (e) {
    e.preventDefault();
    var r = lirePlanning();
    if (r.erreurs.length) { $('#pl-erreur').textContent = r.erreurs.join(' '); return; }
    api('PUT', '/api/planning', JSON.stringify(r.planning, null, 2)).then(function (rep) {
      if (rep.status !== 200) { $('#pl-erreur').textContent = (rep.data && rep.data.erreur) || 'Enregistrement refusé.'; return; }
      app.planning = r.planning; fermer($('#fm-planning')); rendre();
      toast('Planning enregistré. Il s\'applique aux prochaines journées ; « Régénérer demain » l\'applique à la préparation de demain.');
    }, function () { $('#pl-erreur').textContent = 'Service injoignable.'; });
  });
  /** Les wagons et voies de l'onglet affiché deviennent l'habitude de ce jour de semaine dans le planning. */
  function memoriserHabitudes() {
    var prep = estPrep(app.onglet) ? prepDe(app.journee, app.onglet) : null, j = app.journee;
    var circs = prep ? prep.circulations : j.circulations.filter(function (c) { return famille(c) === app.onglet; });
    var date = prep ? prep.date : j.date, nom = SC.JOURS[SC.jourSemaine(date) - 1];
    var r = SC.memoriserHabitudes(app.planning, circs, date);
    if (!r.modifiees) { toast('Rien de nouveau à garder pour les ' + nom + 's.'); return; }
    api('PUT', '/api/planning', JSON.stringify(r.planning, null, 2)).then(function (rep) {
      if (rep.status !== 200) throw new Error((rep.data && rep.data.erreur) || 'refusé');
      app.planning = r.planning;
      toast(r.modifiees + ' circulation' + (r.modifiees > 1 ? 's' : '') + ' : wagons et voie repris automatiquement les prochains ' + nom + 's.');
    }).catch(function (e) { toast('Planning non modifié : ' + e.message, 'crit'); });
  }
  /** Régénère depuis le planning la préparation affichée (après-demain si cet onglet est ouvert, sinon demain). */
  function regenererDemain() {
    var sur = app.onglet === 'surlendemain', nom = sur ? 'd\'après-demain' : 'de demain';
    modifier('Préparation ' + nom + ' régénérée', 'demain.regeneration', function (j) {
      var date = SC.jourPrep(j.date, sur ? 2 : 1), p = { date: date, circulations: SC.genererCirculations(app.planning, date) };
      if (sur) j.surlendemain = p; else j.demain = p;
    });
    toast('Préparation ' + nom + ' régénérée depuis le planning.', null, { libelle: 'Annuler', fn: annuler });
  }
  $('#pl-regenerer').addEventListener('click', function () { regenererDemain(); });

  // Paramètres
  $('#b-params').addEventListener('click', function () {
    var p = app.params, m = p.mails || {};
    $('#pa-mode').value = m.mode || 'simulation'; $('#pa-signature').value = m.signature || '';
    // adresses par EF (trains de ligne) et par groupe (navettes), puis les copies ; les autres listes restent en texte
    var listes = m.listes || {}, nomCci = m.listeCopieCacheeLignes || '', utilisees = {};
    var trainsM = listesMailGroupes('ligne'), navettesM = listesMailGroupes('navette');
    trainsM.concat(navettesM).forEach(function (x) { utilisees[x.nom] = true; });
    if (nomCci) utilisees[nomCci] = true;
    $('#pa-mails-trains').innerHTML = trainsM.map(function (x) { return ligneMail(x.libelles.join(' · '), 'data-liste="' + esc(x.nom) + '"', listes[x.nom]); }).join('') +
      ligneMail('Copie cachée de tous les mails trains', 'data-copie="cci"', nomCci ? listes[nomCci] : [], 'copie');
    $('#pa-mails-navettes').innerHTML = navettesM.map(function (x) { return ligneMail(x.libelles.join(' · '), 'data-liste="' + esc(x.nom) + '"', listes[x.nom]); }).join('') +
      ligneMail('Copie de tous les mails navettes', 'data-copie="navettes"', m.copieNavettes, 'copie');
    $('#pa-listes').value = Object.keys(listes).filter(function (k) { return !utilisees[k]; }).map(function (k) { return k + ': ' + listes[k].join('; '); }).join('\n');
    $('#pa-seuil').value = (p.exploitation || {}).seuilRetardMinutes || 15; $('#pa-coupure').value = (p.exploitation || {}).coupurePoste || '13:30';
    $('#pa-weekend').checked = (p.exploitation || {}).sauterWeekend !== false;
    $('#pa-site').value = p.site || ''; $('#pa-voies').value = (p.voies || []).join(' ');
    $('#pa-alias').value = Object.keys(p.aliasVoies || {}).map(function (k) { return k + '=' + p.aliasVoies[k]; }).join(', ');
    $('#pa-diffusion').value = ((p.diffusion || {}).dossiers || []).join('\n');
    $('#pa-sauvegarde').value = (p.sauvegarde || {}).dossier || ''; $('#pa-archives').value = (p.archives || {}).dossier || '';
    $('#pa-titre').value = (p.visuel || {}).titre || ''; $('#pa-demain').value = (p.visuel || {}).demainAPartirDe || '00:00'; $('#pa-vitesse').value = (p.visuel || {}).vitesseFlash || 90;
    $('#pa-phrases').value = phrasesFlash().join('\n');
    var noms = Object.assign({}, SC.NOMS_TRAINS, (p.visuel || {}).nomsTrains || {});
    $('#pa-noms').value = Object.keys(noms).map(function (k) { return k + '=' + noms[k]; }).join(', ');
    var base = p.correspondancesEF || {};
    $('#pa-base').innerHTML = Object.keys(base).sort().map(function (k) { return ligneBase(k, base[k]); }).join('');
    $('#pa-vers').value = (p.saisie || {}).versObligatoire || 'internes';
    remplirTravauxParametres(p);
    var st = p.suiviTrains || {}, corr = st.correspondances || SC.CORRESPONDANCES_SUIVI;
    $('#pa-st-classeur').value = st.classeur || '';
    $('#pa-st-corr').value = Object.keys(corr).map(function (k) { return k + '=' + corr[k]; }).join(', ');
    // temps d'arrivée des trains de ligne : un champ par train, retirés du texte des parcours
    var trajets = p.parcours || {}, codesT = codesArriveesTrains(), parcours = Object.assign({}, SC.PARCOURS_DEFAUT, trajets);
    $('#pa-arrivees').innerHTML = codesT.map(function (k) {
      return '<div class="champ"><label for="pa-arr-' + esc(k) + '">' + esc(k) + ' · ' + esc(SC.nomTrain(k, p)) + ' (min)</label>' +
        '<input id="pa-arr-' + esc(k) + '" class="mono" data-arrivee="' + esc(k) + '" inputmode="numeric" placeholder="180" value="' + (trajets[k] ? esc(trajets[k].trajet) : '') + '"></div>';
    }).join('') || '<p class="note">Aucun train de ligne à l\'arrivée dans le planning.</p>';
    codesT.forEach(function (k) { delete parcours[k]; });
    $('#pa-st-parcours').value = SC.parcoursEnTexte(parcours);
    var lu = app.suiviTrains;
    $('#pa-st-etat').textContent = !GOOGLE ? 'Disponible avec la version Google seulement.' : (!st.classeur ? 'Désactivé.' :
      (!lu ? 'Pas encore lu.' : (lu.erreur ? 'Dernière lecture ' + hm(SC.iso(lu.a)) + ' : ' + lu.erreur : 'Dernière lecture ' + hm(SC.iso(lu.a)) + ' : ' + lu.lignes + ' ligne' + (lu.lignes > 1 ? 's' : '') + ' du jour.')));
    $('#pa-erreur').textContent = '';
    ouvrir('#d-params');
  });
  /** Une ligne d'adresses par liste de mails : celle du groupe (Planning), sinon son identifiant ; une liste partagée n'apparaît qu'une fois. */
  function listesMailGroupes(fam) {
    var lignes = [], parNom = {};
    (app.planning.groupes || []).forEach(function (g) {
      if (g.famille !== fam) return;
      var nom = g.listeMail || g.id;
      if (!parNom[nom]) { parNom[nom] = { nom: nom, libelles: [] }; lignes.push(parNom[nom]); }
      parNom[nom].libelles.push(g.libelle || g.id);
    });
    return lignes;
  }
  function ligneMail(libelle, attr, adresses, classe) {
    // toutes les adresses visibles : la case s'agrandit selon leur nombre
    var texte = (adresses || []).join('; '), lignes = Math.max(1, Math.min(4, Math.ceil(texte.length / 95)));
    return '<tr' + (classe ? ' class="' + classe + '"' : '') + '><th>' + esc(libelle) + '</th><td><textarea class="mono" ' + attr + ' rows="' + lignes + '" placeholder="adresse@exemple.fr; …" spellcheck="false">' + esc(texte) + '</textarea></td></tr>';
  }
  /** Codes des trains de ligne qui arrivent ici (planning), pour régler leur temps d'arrivée. */
  function codesArriveesTrains() {
    var vus = {};
    (app.planning.circulations || []).forEach(function (c) { if (c.sens === 'A' && c.code && famille(c) === 'ligne') vus[String(c.code).toUpperCase()] = true; });
    return Object.keys(vus).sort();
  }
  function ligneBase(num, ef) {
    return '<tr><td><input class="mono" data-base="num" value="' + esc(num || '') + '"></td><td><input data-base="ef" list="l-ef" value="' + esc(ef || '') + '"></td>' +
      '<td><button type="button" class="bouton petit danger" data-act="retirer-base">Retirer</button></td></tr>';
  }
  $('#pa-base-ajouter').addEventListener('click', function () {
    var t = document.createElement('tbody'); t.innerHTML = ligneBase('', '');
    var tr = t.firstChild; $('#pa-base').insertBefore(tr, $('#pa-base').firstChild); tr.querySelector('input').focus();
  });
  $('#pa-base').addEventListener('click', function (e) { var b = e.target.closest('[data-act="retirer-base"]'); if (b) b.closest('tr').remove(); });
  $('#fm-params').addEventListener('submit', function (e) {
    e.preventDefault();
    var p = SC.copie(app.params), err = [];
    var base = {};
    $$('#pa-base tr').forEach(function (tr) {
      var n = SC.norm(tr.querySelector('[data-base="num"]').value), ef = tr.querySelector('[data-base="ef"]').value.trim();
      if (!n && !ef) return;
      if (!n || !ef) { err.push('Base : ligne incomplète (' + (n || ef) + ').'); return; }
      if (base[n] && base[n] !== ef) err.push('Base : ' + n + ' apparaît deux fois.');
      base[n] = ef;
    });
    p.correspondancesEF = base;
    p.saisie = p.saisie || {}; p.saisie.versObligatoire = $('#pa-vers').value;
    p.mails = p.mails || {};
    p.mails.mode = $('#pa-mode').value; p.mails.signature = $('#pa-signature').value.trim();
    var adresses = function (texte, quoi) {
      var l = String(texte || '').split(/[;,\s]+/).filter(Boolean);
      l.forEach(function (a) { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) err.push('Mails ' + quoi + ' : « ' + a + ' » n\'est pas une adresse.'); });
      return l;
    };
    var listes = {}, noms = {};
    $('#pa-listes').value.split(/\r?\n/).forEach(function (l) {
      l = l.trim(); if (!l) return; var i = l.indexOf(':');
      if (i < 1) { err.push('Liste sans « : » : ' + l); return; }
      listes[l.slice(0, i).trim()] = adresses(l.slice(i + 1), l.slice(0, i).trim());
    });
    // une ligne par EF (trains) ou par groupe (navettes) : elle l'emporte sur une liste du même nom
    $$('#pa-mails-trains [data-liste], #pa-mails-navettes [data-liste]').forEach(function (inp) {
      var k = inp.getAttribute('data-liste'), l = adresses(inp.value, inp.closest('tr').querySelector('th').textContent);
      noms[k] = true;
      if (l.length) listes[k] = l; else delete listes[k];
    });
    // copie cachée des trains : sa propre liste (son ancien nom si aucune EF ne l'utilise)
    var cci = adresses($('#pa-mails-trains [data-copie="cci"]').value, 'copie cachée des trains');
    var nomCci = p.mails.listeCopieCacheeLignes && !noms[p.mails.listeCopieCacheeLignes] ? p.mails.listeCopieCacheeLignes : 'Copie trains';
    if (cci.length) listes[nomCci] = cci;
    p.mails.listeCopieCacheeLignes = cci.length ? nomCci : '';
    p.mails.copieNavettes = adresses($('#pa-mails-navettes [data-copie="navettes"]').value, 'copie des navettes');
    p.mails.listes = listes;
    p.exploitation = p.exploitation || {};
    var s = +$('#pa-seuil').value; if (!(s >= 1 && s <= 240)) err.push('Seuil de retard entre 1 et 240 minutes.'); p.exploitation.seuilRetardMinutes = s;
    var cp = SC.normHeure($('#pa-coupure').value); if (!cp) err.push('Heure de coupure invalide.'); p.exploitation.coupurePoste = cp;
    p.exploitation.sauterWeekend = $('#pa-weekend').checked;
    p.site = $('#pa-site').value.trim();
    p.voies = $('#pa-voies').value.toLowerCase().split(/[\s,;]+/).filter(Boolean);
    if (!p.voies.length) err.push('Au moins une voie est nécessaire.');
    var alias = {};
    $('#pa-alias').value.split(/[,;]+/).forEach(function (x) { x = x.trim(); if (!x) return; var k = x.split('='); if (k.length !== 2) { err.push('Graphie invalide : ' + x); return; } alias[k[0].trim().toLowerCase()] = k[1].trim().toLowerCase(); });
    p.aliasVoies = alias;
    p.diffusion = p.diffusion || {}; p.diffusion.dossiers = $('#pa-diffusion').value.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    p.sauvegarde = { dossier: $('#pa-sauvegarde').value.trim() }; p.archives = { dossier: $('#pa-archives').value.trim() || 'donnees/archives' };
    p.visuel = p.visuel || {}; p.visuel.titre = $('#pa-titre').value.trim() || 'Circulations du jour';
    var dm = SC.normHeure($('#pa-demain').value || '00:00'); if (!dm) err.push('Heure d\'affichage de demain invalide.'); p.visuel.demainAPartirDe = dm;
    p.visuel.vitesseFlash = Math.max(20, Math.min(400, +$('#pa-vitesse').value || 90));
    p.visuel.phrasesFlash = $('#pa-phrases').value.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    var nomsTrains = {};
    $('#pa-noms').value.split(/[,;]+/).forEach(function (x) {
      x = x.trim(); if (!x) return; var k = x.split('=');
      if (k.length !== 2 || !k[0].trim() || !k[1].trim()) { err.push('Villes des trains : « ' + x + ' » doit s\'écrire CODE=Nom.'); return; }
      nomsTrains[k[0].trim().toUpperCase()] = k[1].trim();
    });
    p.visuel.nomsTrains = nomsTrains;
    var corrST = {};
    $('#pa-st-corr').value.split(/[,;]+/).forEach(function (x) {
      x = x.trim(); if (!x) return; var k = x.split('=');
      if (k.length !== 2 || !k[0].trim() || !k[1].trim()) { err.push('Suivi trains : « ' + x + ' » doit s\'écrire vignette=CODE.'); return; }
      corrST[k[0].trim().toLowerCase()] = k[1].trim().toUpperCase();
    });
    p.suiviTrains = { classeur: $('#pa-st-classeur').value.trim(), correspondances: corrST };
    lireTravauxParametres(p, err);
    try { p.parcours = SC.texteEnParcours($('#pa-st-parcours').value); } catch (ex) { err.push('Parcours : ' + ex.message); }
    // temps d'arrivée des trains : les points de passage déjà réglés pour ce train sont gardés
    $$('#pa-arrivees [data-arrivee]').forEach(function (inp) {
      var k = inp.getAttribute('data-arrivee'), v = inp.value.trim(), avant = (app.params.parcours || {})[k];
      if (!p.parcours) return;
      if (!v) { delete p.parcours[k]; return; }
      if (!/^\d{1,3}$/.test(v) || +v < 1 || +v > 600) { err.push('Temps d\'arrivée de ' + k + ' : un nombre de minutes, de 1 à 600.'); return; }
      p.parcours[k] = { trajet: +v, passages: (avant && avant.passages) || [] };
    });
    if (err.length) { $('#pa-erreur').textContent = err.join(' '); return; }
    enregistrerParametres(p, 'Paramètres enregistrés.').then(function () {
      fermer($('#fm-params')); verifierService();
    }, function (ex) { $('#pa-erreur').textContent = ex.message === 'Failed to fetch' ? 'Service injoignable.' : ex.message; });
  });

  // Journées
  $('#b-journees').addEventListener('click', function () {
    api('GET', '/api/journees').then(function (r) {
      var dates = ((r.data && r.data.dates) || []).slice().reverse();
      var actif = SC.cleDate(new Date());
      $('#jo-corps').innerHTML = dates.length ? '<div class="tableau"><table><tbody>' + dates.map(function (d) {
        return '<tr><td>' + esc(SC.libelleJour(d)) + ' ' + d.slice(0, 4) + '</td><td>' + (d === app.journee.date ? '<span class="puce lien">affichée</span>' : '') + '</td><td style="text-align:right">' +
          (d === actif ? '<button type="button" class="bouton petit" data-date="' + d + '" data-actif="1">Journée en cours</button>' : '<button type="button" class="bouton petit" data-date="' + d + '">Consulter</button>') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="vide">Aucune journée enregistrée.</p>';
      ouvrir('#d-journees');
    });
  });
  $('#jo-corps').addEventListener('click', function (e) {
    var b = e.target.closest('[data-date]'); if (!b) return;
    fermer(b);
    if (b.getAttribute('data-actif')) revenirAujourdhui(); else ouvrirJourneePassee(b.getAttribute('data-date'));
  });

  // Clôture
  $('#b-cloture').addEventListener('click', function () {
    var s = SC.statistiques(app.journee, app.planning, app.params), j = app.journee;
    $('#cl-corps').innerHTML = '<p>La clôture écrit dans le dossier d\'archives les fichiers <span class="mono">' + j.date + '_mouvements.csv</span>, <span class="mono">' + j.date + '_circulations.csv</span>, une copie de la journée, et ajoute sa ligne à <span class="mono">statistiques.csv</span>. Ils s\'ouvrent dans Excel.</p>' +
      '<p>' + s.mouvements + ' mouvements, ' + s.realisees + ' circulations réalisées, ' + s.supprimees + ' supprimées.</p>' +
      (j.cloture ? '<p class="note">Déjà clôturée à ' + hm(j.cloture.a) + ' : une nouvelle clôture remplace les fichiers.</p>' : '') +
      '<p class="note">La journée reste modifiable après la clôture. Le lendemain, la nouvelle journée reprend la préparation de l\'onglet « Demain ».</p>';
    $('#cl-etat').textContent = '';
    ouvrir('#d-cloture');
  });
  $('#cl-valider').addEventListener('click', function () {
    if (app.lectureSeule) { $('#cl-etat').textContent = 'Journée en lecture seule.'; return; }
    $('#cl-etat').textContent = 'Écriture des archives…';
    cloturer(app.journee, app.version, false).then(function (r) {
      fermer($('#cl-valider')); toast('Journée archivée dans ' + r.dossier);
    }, function (e) { $('#cl-etat').textContent = 'Échec : ' + e.message; });
  });

  // Ajout d'une circulation
  function ouvrirAjout() {
    if (app.lectureSeule) return;
    var prep = estPrep(app.onglet) ? prepDe(app.journee, app.onglet) : null;
    var cible = prep ? prep.circulations : app.journee.circulations;
    var presents = {}; cible.forEach(function (c) { presents[c.planId || c.id] = true; });
    var dispo = (app.planning.circulations || []).filter(function (pc) { return !presents[pc.id]; });
    $('#aj-titre').textContent = 'Ajouter une circulation · ' + (prep ? SC.libelleJour(prep.date) : 'aujourd\'hui');
    $('#aj-planning').innerHTML = dispo.length ? dispo.map(function (pc) {
      return '<tr><td><b>' + esc(pc.code) + '</b></td><td>' + esc(groupe(pc.groupe).libelle) + '</td><td>' + (pc.sens === 'D' ? 'départ' : 'arrivée') + '</td><td class="mono">' + esc(pc.numero || pc.sillon || '') + '</td><td class="mono">' + esc(pc.heure || '') + '</td>' +
        '<td style="text-align:right"><button type="button" class="bouton petit" data-plan="' + esc(pc.id) + '">Ajouter</button></td></tr>';
    }).join('') : '<tr><td class="vide">Toutes les circulations du planning sont déjà présentes.</td></tr>';
    $('#aj-groupe').innerHTML = (app.planning.groupes || []).map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(g.libelle) + '</option>'; }).join('');
    $('#aj-erreur').textContent = '';
    ouvrir('#d-ajout');
  }
  function ajouterCirculation(c, libelle) {
    var cle = estPrep(app.onglet) ? app.onglet : null;
    modifier(libelle, 'circulation.ajout', function (j) { (cle ? prepDe(j, cle).circulations : j.circulations).push(c); });
    if (!cle) {
      var v = vueDe(famille(c));
      if (v.groupe !== 'tous') v.groupe = c.groupe;
      if (v.sens !== 'tous') v.sens = sensDe(c);
      lsEcrire('suivi:vue', app.vue);
      if (famille(c) !== app.onglet) { app.onglet = famille(c); majOnglets(); }
      rendre();
    }
  }
  $('#b-ajout').addEventListener('click', ouvrirAjout);
  $('#aj-planning').addEventListener('click', function (e) {
    var b = e.target.closest('[data-plan]'); if (!b) return;
    var pc = app.planning.circulations.filter(function (x) { return x.id === b.getAttribute('data-plan'); })[0];
    var date = estPrep(app.onglet) ? prepDe(app.journee, app.onglet).date : app.journee.date;
    var c = SC.instancier(pc, date, app.planning); c.ajoutee = true;
    fermer(b); ajouterCirculation(c, pc.code + ' ajouté');
  });
  $('#fm-ajout').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('#aj-code').value.trim(), h = $('#aj-heure').value.trim(), hlr = $('#aj-hlr').value.trim();
    if (!code) { $('#aj-erreur').textContent = 'Le code est obligatoire.'; return; }
    if ((h && !SC.normHeure(h)) || (hlr && !SC.normHeure(hlr))) { $('#aj-erreur').textContent = 'Heure invalide.'; return; }
    var date = estPrep(app.onglet) ? prepDe(app.journee, app.onglet).date : app.journee.date;
    var g = $('#aj-groupe').value, sens = $('#aj-sens').value, num = $('#aj-numero').value.trim();
    var fam = groupe(g).famille;
    var c = {
      id: uid('x'), planId: null, groupe: g, code: code, sens: sens, numero: fam === 'navette' ? num : '', sillon: fam === 'navette' ? '' : num,
      hlr: SC.normHeure(hlr) || '', theo: SC.combiner(date, h), wagonsDemandes: null, voiePrevue: '',
      etat: null, reel: null, partie: null, mails: {}, deroule: {}, ajoutee: true
    };
    fermer($('#fm-ajout')); ajouterCirculation(c, code + ' (exceptionnel) ajouté');
  });

  // ------------------------------------------------------------ événements
  F.num.addEventListener('input', function () { surNumero(); proposerNumeros(); });
  // touches des suggestions, avant celles du formulaire (Entrée prend la suggestion puis passe au champ suivant)
  F.num.addEventListener('keydown', function (e) {
    var ouverte = !$('#s-sugg').hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!ouverte) { if (e.key === 'ArrowDown') proposerNumeros(); return; }
      e.preventDefault();
      var n = sugg.liste.length;
      sugg.choisi = e.key === 'ArrowDown' ? (sugg.choisi + 1) % n : (sugg.choisi <= 0 ? n - 1 : sugg.choisi - 1);
      $$('#s-sugg .sugg').forEach(function (x, i) { x.classList.toggle('choisi', i === sugg.choisi); });
    } else if (ouverte && (e.key === 'Enter' || e.key === 'Tab')) {
      if (sugg.choisi >= 0) prendreSuggestion(sugg.choisi); else fermerSuggestions();
    } else if (ouverte && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermerSuggestions(); }
  });
  F.num.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== F.num) fermerSuggestions(); }, 150); });
  $('#s-sugg').addEventListener('mousedown', function (e) {
    var x = e.target.closest('.sugg'); if (!x) return;
    e.preventDefault();
    prendreSuggestion(+x.getAttribute('data-i'));
    avancer(F.num);
  });
  F.compo.addEventListener('input', function (e) {
    // saisie rapide : « h » (ou « hl ») → HLP aussitôt ; un retour arrière ne le remet pas
    if (/^insert/.test(e.inputType || 'insert') && /^h(l(p)?)?$/i.test(F.compo.value.trim()) && F.compo.value.trim().toUpperCase() !== 'HLP') {
      F.compo.value = 'HLP'; F.compo.setSelectionRange(3, 3);
    }
    app.auto.compo = false; F.compo.classList.remove('auto'); surCompo();
  });
  ['voie', 'vers', 'reel', 'annonce', 'comm'].forEach(function (k) { F[k].addEventListener('input', function () { app.auto[k] = false; F[k].classList.remove('auto'); aide(); }); });
  F.ef.addEventListener('input', function () { app.touche.ef = !!F.ef.value; F.ef.classList.remove('auto'); });
  F.sit.addEventListener('change', function () { app.touche.sit = true; });
  F.cv.addEventListener('change', function () { app.touche.cv = true; });
  $('#saisie').addEventListener('submit', function (e) { e.preventDefault(); valider(); });
  $('#saisie').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.target.id === 's-valider')) { e.preventDefault(); valider(); }
    else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'BUTTON') { e.preventDefault(); avancer(e.target); }
    else if (e.key === 'Escape') { e.preventDefault(); viderFormulaire(); F.num.focus(); }
    else if (e.key === 'F2') { e.preventDefault(); if (!reelSurSaisie()) toast('Aucune circulation à marquer pour ce numéro.'); }
  });
  $('#s-annuler').addEventListener('click', function () { viderFormulaire(); F.num.focus(); });

  $('#j-corps').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-id]'); if (!tr) return;
    var id = tr.getAttribute('data-id'), b = e.target.closest('button[data-act]');
    app.selection = id;
    if (b) {
      var a = b.getAttribute('data-act');
      if (a === 'reel') reelMouvement(id); else if (a === 'editer') editerMouvement(id); else if (a === 'supprimer') supprimerMouvement(id);
      return;
    }
    $$('#j-corps tr.choisie').forEach(function (x) { x.classList.remove('choisie'); });
    tr.classList.add('choisie');
  });
  $('#j-corps').addEventListener('dblclick', function (e) { var tr = e.target.closest('tr[data-id]'); if (tr) editerMouvement(tr.getAttribute('data-id')); });
  $('#j-defile').addEventListener('keydown', function (e) {
    if (e.target.tagName === 'BUTTON' && e.key === 'Enter') return;
    var lignes = $$('#j-corps tr[data-id]'), i = lignes.map(function (x) { return x.getAttribute('data-id'); }).indexOf(app.selection);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      i = e.key === 'ArrowDown' ? Math.min(lignes.length - 1, i + 1) : Math.max(0, i < 0 ? lignes.length - 1 : i - 1);
      if (lignes[i]) { app.selection = lignes[i].getAttribute('data-id'); $$('#j-corps tr.choisie').forEach(function (x) { x.classList.remove('choisie'); }); lignes[i].classList.add('choisie'); lignes[i].scrollIntoView({ block: 'nearest' }); }
    } else if (app.selection && e.key === 'Enter') { e.preventDefault(); editerMouvement(app.selection); }
    else if (app.selection && e.key === 'Delete') { e.preventDefault(); supprimerMouvement(app.selection); }
    else if (app.selection && e.key === 'F2') { e.preventDefault(); reelMouvement(app.selection); }
  });
  $('#j-supprimees').addEventListener('change', rendreJournal);

  function majOnglets() { $$('.onglet').forEach(function (o) { o.setAttribute('aria-selected', o.getAttribute('data-onglet') === app.onglet ? 'true' : 'false'); }); }
  $$('.onglet').forEach(function (o) { o.addEventListener('click', function () { app.onglet = o.getAttribute('data-onglet'); app.ouverte = null; majOnglets(); rendreCirculations(); }); });
  $('#p-filtres').addEventListener('click', function (e) {
    var b = e.target.closest('.filtre'); if (!b || estPrep(app.onglet)) return;
    var v = vueDe(app.onglet);
    if (b.hasAttribute('data-groupe')) v.groupe = b.getAttribute('data-groupe'); else v.sens = b.getAttribute('data-sens');
    app.ouverte = null;
    lsEcrire('suivi:vue', app.vue);
    rendreCirculations();
  });

  $('#p-liste').addEventListener('click', function (e) {
    var b = e.target.closest('button'), ligne = e.target.closest('[data-id]');
    if (b && b.getAttribute('data-act') === 'regenerer') { regenererDemain(); return; }
    if (b && b.getAttribute('data-act') === 'memoriser') { memoriserHabitudes(); return; }
    if (!ligne) return;
    var id = ligne.getAttribute('data-id');
    if (b && b.hasAttribute('data-maintenant')) {
      var k = b.getAttribute('data-maintenant'), t = hm(maintenant());
      modifier('Déroulé : ' + k + ' ' + t, 'circulation.deroule', function (j) { var cc = circDe(j, id); cc.deroule = cc.deroule || {}; cc.deroule[k] = t; });
      return;
    }
    if (b && b.getAttribute('data-act')) {
      var a = b.getAttribute('data-act');
      if (a === 'reel') marquerReel(id);
      else if (a === 'annuler-reel') annulerReel(id);
      else if (a === 'deja') basculer(id, 'etat', 'deja', 'Déjà là');
      else if (a === 'partie') marquerPartie(id);
      else if (a === 'annuler-partie') marquerPartie(id, true);
      else if (a === 'fa') marquerFA(id);
      else if (a === 'annoncer') annoncerDepart(id);
      else if (a === 'effacer-etape') modifier(circDe(app.journee, id).code + ' : étape du Suivi trains effacée', 'circulation.etape', function (j) { var cc = circDe(j, id); cc.etape = null; cc.cale = null; });
      else if (a === 'nonprevu') basculer(id, 'etat', 'nonprevu', 'Non prévue / rétablie');
      else if (a === 'suppr') { basculer(id, 'etat', 'supprime', 'Suppression / rétablissement'); }
      else if (a === 'suppr-demain' || a === 'nonprevu-prep') {
        var cle = ligne.getAttribute('data-prep') || 'demain', val = a === 'suppr-demain' ? 'supprime' : 'nonprevu';
        modifier((cle === 'demain' ? 'Demain' : 'Après-demain') + ' : ' + (val === 'supprime' ? 'suppression' : 'non prévue') + ' / rétablissement', 'demain.' + val, function (j) {
          var cc = circPrepDe(j, cle, id); cc.etat = cc.etat === val ? null : val;
        });
      }
      else if (a === 'renvoyer') { var c = circDe(app.journee, id); var t2 = SC.typeMail(c, app.planning); envoyerMail(c, c.mails && c.mails[t2] ? 'r' + Date.now().toString(36) : null); }
      return;
    }
    if (e.target.closest('input, .detail') || ligne.hasAttribute('data-ligne-demain')) return;
    app.ouverte = app.ouverte === id ? null : id;
    rendreCirculations();
  });
  $('#p-liste').addEventListener('change', function (e) {
    if (e.target.hasAttribute('data-note')) {
      var gn = e.target.getAttribute('data-note'), texte = e.target.value.trim();
      modifier('Prochaines navettes ' + gn + ' : ' + (texte || 'texte retiré'), 'prochaines.texte', function (j) { j.notesProchaines = j.notesProchaines || {}; j.notesProchaines[gn] = texte; });
      return;
    }
    var el = e.target, ligne = el.closest('[data-id]'); if (!ligne) return;
    var id = ligne.getAttribute('data-id'), val = el.value.trim();
    if (el.hasAttribute('data-demain')) {
      var kd = el.getAttribute('data-demain'), hd = SC.normHeure(val);
      if (kd === 'wagonsDemandes' && val && !/^\d+$/.test(val)) { toast('Wagons : un nombre.', 'crit'); return; }
      if ((kd === 'theo' || kd === 'hlr') && val && !hd) { toast('Heure invalide.', 'crit'); return; }
      var cleP = ligne.getAttribute('data-prep') || 'demain';
      modifier((cleP === 'demain' ? 'Demain' : 'Après-demain') + ' : ' + kd, 'demain.modification', function (j) {
        var cc = circPrepDe(j, cleP, id);
        if (kd === 'theo') cc.theo = hd ? SC.combiner(prepDe(j, cleP).date, hd) : null;
        else if (kd === 'hlr') cc.hlr = hd || '';
        else cc[kd] = kd === 'wagonsDemandes' ? (val ? +val : null) : val.toUpperCase();
      });
      return;
    }
    if (el.hasAttribute('data-deroule')) {
      var kr = el.getAttribute('data-deroule'), h = SC.normHeure(val);
      if (val && !h) { toast('Heure invalide.', 'crit'); return; }
      modifier('Déroulé : ' + kr, 'circulation.deroule', function (j) { var cc = circDe(j, id); cc.deroule = cc.deroule || {}; cc.deroule[kr] = h || ''; });
      return;
    }
    var k = el.getAttribute('data-champ'); if (!k) return;
    var c = circDe(app.journee, id);
    if (k === 'theo' || k === 'hlr' || k === 'reelManuel') {
      var hh = SC.normHeure(val);
      if (val && !hh) { toast('Heure invalide.', 'crit'); return; }
      if (k === 'theo') modifier(c.code + ' : heure prévue ' + (hh || 'retirée'), 'circulation.modification', function (j) { circDe(j, id).theo = hh ? SC.combiner(j.date, hh) : null; });
      else if (k === 'hlr') modifier(c.code + ' : HLR', 'circulation.modification', function (j) { circDe(j, id).hlr = hh || ''; });
      else modifier(c.code + ' : heure réelle ' + (hh || 'retirée'), 'circulation.reel', function (j) {
        var cc = circDe(j, id); cc.reel = hh ? SC.heureProche(j.date, hh, cc.theo || SC.iso(new Date())) : null;
        if (!hh) SC.mouvementsActifs(j).forEach(function (m) { if (m.lien === id) m.reel = null; });
      });
      return;
    }
    if (k === 'wagonsDemandes' && val && !/^\d+$/.test(val)) { toast('Wagons : un nombre.', 'crit'); return; }
    modifier(c.code + ' : ' + k, 'circulation.modification', function (j) {
      var cc = circDe(j, id);
      if (k === 'wagonsDemandes') cc[k] = val ? +val : null;
      else if (k === 'voiePrevue') cc[k] = val.toUpperCase();
      else cc[k] = val;
    });
  });

  $('#bandeau').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    if (b.getAttribute('data-act') === 'aujourdhui') revenirAujourdhui();
    if (b.getAttribute('data-act') === 'nouvelle') basculerNouvelleJournee();
  });

  document.addEventListener('keydown', function (e) {
    var dansChamp = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || '');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && (!dansChamp || !e.target.value) && !document.querySelector('dialog[open]')) { e.preventDefault(); annuler(); }
    else if (e.altKey && /^[1234]$/.test(e.key)) { e.preventDefault(); app.onglet = ['navette', 'ligne', 'demain', 'surlendemain'][+e.key - 1]; majOnglets(); rendreCirculations(); }
    else if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); F.num.focus(); }
  });
  window.addEventListener('beforeunload', function (e) {
    if (app.sauvegarde.evenements.length || app.sauvegarde.enCours) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------- démarrage
  function rafraichirPeriodique() {
    if (!app.journee) return;
    var actif = document.activeElement;
    if (!(actif && actif.closest && actif.closest('#p-liste') && /^(INPUT|SELECT)$/.test(actif.tagName))) rendreCirculations();
    rendreEtats();
  }
  // ------------------------------------------- connexion au serveur Google
  function lienVisuel() {
    return new URL('visuel.html', location.href).href.split('#')[0].split('?')[0] + '?source=' + encodeURIComponent(CONNEXION.url || '');
  }
  function ouvrirConnexion(message) {
    $('#cx-url').value = CONNEXION.url || ''; $('#cx-cle').value = CONNEXION.cle || '';
    $('#cx-message').textContent = message || '';
    $('#cx-lien').value = CONNEXION.url ? lienVisuel() : '';
    ouvrir('#d-connexion');
  }
  function lireConnexionSaisie() { CONNEXION.url = $('#cx-url').value.trim(); CONNEXION.cle = $('#cx-cle').value.trim(); }
  $('#b-connexion').addEventListener('click', function () { ouvrirConnexion(''); });

  // Raccourcis des postes : fichiers .bat remplis avec l'adresse du serveur (jamais la clé)
  function telecharger(nom, texte) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([texte.replace(/\r?\n/g, '\r\n')], { type: 'application/octet-stream' }));
    a.download = nom;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function adressePage(page) { return location.origin + location.pathname.replace(/[^/]*$/, '') + page; }
  /** « % » est spécial dans un .bat : doublé. */
  function pourBat(t) { return String(t).replace(/%/g, '%%'); }
  $('#b-raccourcis').addEventListener('click', function () { ouvrir('#d-raccourcis'); });
  // Application installable (application.js) : bouton dans la barre et dans « Raccourcis »
  if (window.SuiviAppli) {
    SuiviAppli.suivre(function (possible) {
      $('#b-installer').hidden = !possible || SuiviAppli.installee();
      $('#rc-installer-saisie').disabled = !possible;
      $('#rc-installer-note').textContent = SuiviAppli.installee() ? 'La saisie est déjà ouverte comme application sur ce poste.'
        : (possible ? '' : 'Déjà installée, ou proposée autrement par le navigateur : menu ⋯ d\'Edge › Applications › Installer ce site en tant qu\'application.');
    });
    var installerSaisie = function () { SuiviAppli.installer().then(function (ok) { if (ok) toast('Application Saisie installée : son icône est sur le bureau.'); }); };
    $('#b-installer').addEventListener('click', installerSaisie);
    $('#rc-installer-saisie').addEventListener('click', installerSaisie);
  }
  $('#rc-installer-ecrans').addEventListener('click', function () {
    window.open(adressePage('visuel.html') + '?source=' + encodeURIComponent(CONNEXION.url) + '&installer=1', '_blank');
  });
  $('#rc-saisie').addEventListener('click', function () {
    telecharger('Saisie.bat', '@echo off\nrem Suivi des circulations - ouvre la SAISIE dans une fenetre Edge dediee.\n' +
      'rem A mettre sur le bureau du poste de saisie. La cle se tape une fois dans Connexion.\n' +
      'start "" msedge --app="' + pourBat(adressePage('saisie.html') + (CONNEXION.url ? '#url=' + CONNEXION.url : '')) + '"\n');
  });
  $('#rc-ecrans').addEventListener('click', function () {
    telecharger('Ecrans.bat', '@echo off\nrem Suivi des circulations - ouvre les ECRANS en plein ecran (PC qui alimente les TV).\n' +
      'rem Pour quitter le plein ecran : Alt+F4.\n' +
      'start "" msedge --kiosk "' + pourBat(adressePage('visuel.html') + '?source=' + CONNEXION.url) + '" --edge-kiosk-type=fullscreen --no-first-run\n');
  });
  $('#cx-tester').addEventListener('click', function () {
    lireConnexionSaisie();
    $('#cx-message').textContent = 'Test en cours…';
    api('GET', '/api/sante').then(function (r) {
      $('#cx-message').textContent = r.status === 200 ? 'Connexion réussie : serveur Google version ' + r.data.version + '.' : 'Refusé : ' + ((r.data && r.data.erreur) || r.status);
      $('#cx-lien').value = lienVisuel();
    }, function (e) { $('#cx-message').textContent = 'Serveur injoignable : vérifiez l\'adresse (elle se termine par /exec). ' + e.message; });
  });
  $('#fm-connexion').addEventListener('submit', function (e) {
    e.preventDefault(); lireConnexionSaisie();
    lsEcrire('suivi:connexion', { url: CONNEXION.url, cle: CONNEXION.cle });
    if ($('#cx-fichier').files[0]) { importerDonnees(); return; }
    location.reload();
  });
  $('#cx-copier').addEventListener('click', function () {
    var l = $('#cx-lien'); l.select();
    try { navigator.clipboard.writeText(l.value).then(function () { toast('Lien des écrans copié.'); }, function () { document.execCommand('copy'); }); } catch (e) { document.execCommand('copy'); }
  });
  $('#cx-importer').addEventListener('click', importerDonnees);
  // Un fichier choisi est importé tout de suite, sans autre clic.
  $('#cx-fichier').addEventListener('change', function () { if ($('#cx-fichier').files[0]) importerDonnees(); });
  function importerDonnees() {
    lireConnexionSaisie();
    var f = $('#cx-fichier').files[0];
    if (!f) { $('#cx-message').textContent = 'Choisissez le fichier donnees-initiales.json.'; return; }
    if (!CONNEXION.url || !CONNEXION.cle) { $('#cx-message').textContent = 'Indiquez d\'abord l\'adresse du serveur et la clé.'; return; }
    var lecteur = new FileReader();
    lecteur.onload = function () {
      var d;
      try { d = JSON.parse(lecteur.result); } catch (e) { $('#cx-message').textContent = 'Fichier illisible : ' + e.message; return; }
      if (!d.parametres || !d.planning) { $('#cx-message').textContent = 'Ce fichier ne contient pas de paramètres et de planning.'; return; }
      $('#cx-message').textContent = 'Import en cours…';
      api('PUT', '/api/parametres', JSON.stringify(d.parametres, null, 2)).then(function (r) {
        if (r.status !== 200) throw new Error((r.data && r.data.erreur) || r.status);
        return api('PUT', '/api/planning', JSON.stringify(d.planning, null, 2));
      }).then(function (r) {
        if (r.status !== 200) throw new Error((r.data && r.data.erreur) || r.status);
        lsEcrire('suivi:connexion', { url: CONNEXION.url, cle: CONNEXION.cle });
        $('#cx-message').textContent = 'Données importées : ' + d.planning.circulations.length + ' circulations. Rechargement…';
        setTimeout(function () { location.reload(); }, 1200);
      }).catch(function (e) { $('#cx-message').textContent = 'Import impossible : ' + (e.message === 'Failed to fetch' ? 'serveur injoignable, vérifiez l\'adresse' : e.message); });
    };
    lecteur.readAsText(f);
  }

  // ----------------------------------------------------- nouvelle version
  /** Nouvelle version publiée (version.txt) : la saisie se recharge seule dès que rien n'est en cours. */
  var versionChargee = null;
  function verifierVersion() {
    if (!/^https?:/.test(location.protocol)) return;
    fetch('version.txt?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (v) {
      v = (v || '').trim(); if (!v) return;
      if (versionChargee === null) { versionChargee = v; return; }
      if (v === versionChargee) return;
      var actif = document.activeElement;
      if (sauvegardeEnCours() || document.querySelector('dialog[open]') || F.num.value.trim() || (actif && /^(INPUT|TEXTAREA|SELECT)$/.test(actif.tagName))) return;
      toast('Nouvelle version de la saisie : rechargement…');
      Promise.all(['saisie.js', 'saisie.css', 'commun.js'].map(function (u) { return fetch(u, { cache: 'reload' }).catch(function () { /* sans effet */ }); }))
        .then(function () { setTimeout(function () { if (window.SuiviAppli) SuiviAppli.sansIntroAuProchainChargement(); location.reload(); }, 1500); });
    }, function () { /* sans effet */ });
  }

  // ------------------------------------------------------------- démarrage
  horloge(); setInterval(horloge, 1000);
  $('#b-connexion').hidden = CONNEXION.mode !== 'google';
  $('#b-raccourcis').hidden = CONNEXION.mode !== 'google';
  var GOOGLE = CONNEXION.mode === 'google';
  function demarrer() {
    if (GOOGLE && !CONNEXION.url) { ouvrirConnexion('Première utilisation : indiquez l\'adresse du serveur Google (elle se termine par /exec) et la clé choisie dans Code.gs.'); return; }
    if (GOOGLE && !CONNEXION.cle) { ouvrirConnexion('Première utilisation : tapez la clé choisie dans Code.gs, puis « Tester la connexion ».'); setTimeout(function () { $('#cx-cle').focus(); }, 50); return; }
    api('GET', '/api/config').then(function (r) {
      if (r.status === 403) { ouvrirConnexion('Clé refusée par le serveur : ' + ((r.data && r.data.erreur) || '')); throw new Error('clé refusée'); }
      if (r.status !== 200) throw new Error('configuration illisible');
      app.params = r.data.parametres; app.planning = r.data.planning; app.serviceOk = true; reglerJours();
      if (!(app.planning.circulations || []).length || !(app.params.voies || []).length) {
        ouvrirConnexion('Le serveur ne contient encore ni planning ni paramètres : importez le fichier donnees-initiales.json.');
        throw new Error('serveur vide');
      }
      remplirListes();
      return ouvrirJourActif();
    }).then(function () {
      app.prete = true;
      publier(); traiterMails(); verifierService();
      F.num.focus();
      setInterval(rafraichirPeriodique, 20000);
      setInterval(publierPeriodique, 60000);
      setInterval(verifierService, GOOGLE ? 30000 : 10000);
      setInterval(traiterMails, 60000);
      setInterval(verifierChangementJour, 30000);
      if (GOOGLE) setInterval(function () { if (estJourActif()) api('POST', '/api/battement', '').then(null, function () { /* signalé par verifierService */ }); }, 30000);
      if (GOOGLE) { suivreTrains(); setInterval(suivreTrains, 4000); lireTravaux(); setInterval(lireTravaux, 15000); }
      verifierVersion(); setInterval(verifierVersion, 120000);
    }).catch(function (e) {
      if (e.message === 'clé refusée' || e.message === 'serveur vide') return;
      app.serviceOk = false; rendreEtats();
      var b = $('#bandeau'); b.hidden = false; b.className = 'bandeau crit';
      b.innerHTML = '<span>Impossible de démarrer : ' + esc(e.message) + '. ' + (GOOGLE ? 'Vérifiez la connexion Internet et l\'adresse du serveur Google (bouton Connexion).' : 'Vérifiez que la fenêtre « Suivi des circulations - service » est ouverte.') + ' Nouvel essai dans 5 secondes.</span>';
      setTimeout(demarrer, 5000);
    });
  }
  demarrer();
})();
