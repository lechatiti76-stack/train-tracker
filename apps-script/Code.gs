/**
 * Web App Google Apps Script pour l'application "Suivi Trains" :
 *  - LECTURE (doGet, inchangée) : publie en JSON les horaires théoriques de
 *    l'onglet "Horaires", en lecture seule.
 *  - ÉCRITURE (doPost) : reçoit une action 'logStep' à chaque heure réelle
 *    de train enregistrée/corrigée/réinitialisée côté app (onglet "Journal"),
 *    et une action 'logShuttle' pour les navettes internes, le tableau
 *    rapide des départs et les arrivées (trains fret) — onglet "Navettes".
 *    L'onglet "Horaires" n'est jamais modifié par l'écriture.
 * Aucune clé API n'est nécessaire : Apps Script gère l'autorisation sous le
 * compte du propriétaire de la feuille.
 *
 * Installation : voir la section "Connecter Google Sheets" du README.md
 * à la racine du projet. Après toute modification de ce fichier, il faut
 * créer une NOUVELLE VERSION du déploiement (Déployer → Gérer les
 * déploiements → ✎ → Version : Nouvelle version → Déployer) pour que les
 * changements soient pris en compte — l'URL /exec ne change pas.
 *
 * Colonnes attendues dans l'onglet "Horaires" (ligne d'en-tête obligatoire) :
 *   Train | Étape | Heure théorique | Cause | Jours de circulation
 * - Train                  : numéro du train (ex : 1234)
 * - Étape                  : doit correspondre au libellé configuré côté
 *                            app pour cette étape (ex : "Départ FA / Titoir-
 *                            Fosse", "Arrivée LHTE", ...)
 * - Heure théorique        : HH:MM (ou une vraie heure de cellule Sheets)
 * - Cause                  : texte libre, optionnel (laisser vide ou "-" si
 *                            non renseigné)
 * - Jours de circulation   : jours de la semaine où ce sillon circule, ex :
 *                            "Mardi,Jeudi" ou "Lundi,Mercredi,Vendredi" ou
 *                            "Tous les jours" — le sillon est un service
 *                            récurrent, PAS lié à une date précise.
 *
 * L'onglet "Journal" (écriture, trains) est créé automatiquement avec les
 * colonnes :
 *   Date | Train | Étape | Heure théorique | Heure réelle | Écart (min) |
 *   Cause | Wagons | Poids (t) | Longueur (m) | Traction | Mis à jour le
 * Les colonnes Wagons/Poids/Longueur/Traction reprennent la composition du
 * train saisie via le bouton "Composition" côté app (identique sur toutes
 * les lignes d'un même train/jour, vide tant que rien n'a été renseigné).
 * Une ligne par (Date, Train, Étape) : un nouvel envoi met à jour la ligne
 * existante plutôt que d'en créer une autre (upsert).
 *
 * L'onglet "Navettes" (écriture, navettes/quickboard/arrivées) est créé
 * automatiquement avec les colonnes :
 *   Date | Type | Code | Libellé | Heure théorique | Heure réelle |
 *   Écart (min) | Mis à jour le
 * - Type   : "Navette" (ligne 1, FL/NL/AL...), "Quickboard" (tableau rapide
 *            des départs, ligne 2, LF/LN/LA) ou "Arrivée" (trains fret en
 *            provenance d'autres sites).
 * - Code   : identifiant unique par ligne du jour (ex : "FL1" pour le départ
 *            d'une navette, "FL1-arr" pour son arrivée — un départ et une
 *            arrivée ne partagent jamais le même code, pour ne jamais
 *            s'écraser l'un l'autre).
 * Une ligne par (Date, Type, Code) : un nouvel envoi met à jour la ligne
 * existante plutôt que d'en créer une autre (upsert), comme "Journal".
 */

const SHEET_NAME = 'Horaires';
const JOURNAL_SHEET_NAME = 'Journal';
const JOURNAL_HEADERS = ['Date', 'Train', 'Étape', 'Heure théorique', 'Heure réelle', 'Écart (min)', 'Cause', 'Wagons', 'Poids (t)', 'Longueur (m)', 'Traction', 'Mis à jour le'];
const SHUTTLE_JOURNAL_SHEET_NAME = 'Navettes';
const SHUTTLE_JOURNAL_HEADERS = ['Date', 'Type', 'Code', 'Libellé', 'Heure théorique', 'Heure réelle', 'Écart (min)', 'Mis à jour le'];

function doGet(e) {
  try {
    const rows = readScheduleRows_();
    return jsonResponse_(rows);
  } catch (err) {
    return jsonResponse_({ error: String(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return jsonResponse_({ error: 'Verrou indisponible, réessayez.' });
  }
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    if (payload.action === 'logStep') {
      upsertJournalRow_(payload);
      return jsonResponse_({ ok: true });
    }
    if (payload.action === 'logShuttle') {
      upsertShuttleJournalRow_(payload);
      return jsonResponse_({ ok: true });
    }
    return jsonResponse_({ error: 'Action inconnue : ' + payload.action });
  } catch (err) {
    return jsonResponse_({ error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function upsertJournalRow_(payload) {
  const sheet = getOrCreateJournalSheet_();
  const values = sheet.getDataRange().getValues();
  const key = [payload.date, payload.train, payload.etape].join('|');

  let targetRow = -1;
  for (let i = 1; i < values.length; i++) {
    const rowKey = [cellToKey_(values[i][0]), String(values[i][1]), String(values[i][2])].join('|');
    if (rowKey === key) { targetRow = i + 1; break; }
  }

  const rowValues = [
    payload.date || '',
    payload.train || '',
    payload.etape || '',
    payload.heureTheorique || '',
    payload.heureReelle || '',
    payload.ecartMin === '' || payload.ecartMin === undefined ? '' : Number(payload.ecartMin),
    payload.cause || '',
    payload.wagons === '' || payload.wagons === undefined ? '' : Number(payload.wagons),
    payload.poidsTonnes === '' || payload.poidsTonnes === undefined ? '' : Number(payload.poidsTonnes),
    payload.longueurM === '' || payload.longueurM === undefined ? '' : Number(payload.longueurM),
    payload.traction || '',
    payload.misAJour || new Date().toISOString(),
  ];

  if (targetRow > -1) {
    sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}

// Même principe qu'upsertJournalRow_ ci-dessus, pour l'onglet "Navettes" :
// une ligne par (Date, Type, Code) plutôt que (Date, Train, Étape).
function upsertShuttleJournalRow_(payload) {
  const sheet = getOrCreateShuttleJournalSheet_();
  const values = sheet.getDataRange().getValues();
  const key = [payload.date, payload.type, payload.code].join('|');

  let targetRow = -1;
  for (let i = 1; i < values.length; i++) {
    const rowKey = [cellToKey_(values[i][0]), String(values[i][1]), String(values[i][2])].join('|');
    if (rowKey === key) { targetRow = i + 1; break; }
  }

  const rowValues = [
    payload.date || '',
    payload.type || '',
    payload.code || '',
    payload.libelle || '',
    payload.heureTheorique || '',
    payload.heureReelle || '',
    payload.ecartMin === '' || payload.ecartMin === undefined || payload.ecartMin === null ? '' : Number(payload.ecartMin),
    payload.misAJour || new Date().toISOString(),
  ];

  if (targetRow > -1) {
    sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}

function getOrCreateShuttleJournalSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHUTTLE_JOURNAL_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHUTTLE_JOURNAL_SHEET_NAME);
    sheet.appendRow(SHUTTLE_JOURNAL_HEADERS);
    sheet.setFrozenRows(1);
    // Colonnes Date/Type/Code en texte, pour éviter que Sheets ne les
    // réinterprète (ex : un code "01" tronqué en nombre).
    sheet.getRange('A2:C').setNumberFormat('@');
  }
  return sheet;
}

function cellToKey_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value || '');
}

function getOrCreateJournalSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(JOURNAL_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(JOURNAL_SHEET_NAME);
    sheet.appendRow(JOURNAL_HEADERS);
    sheet.setFrozenRows(1);
    // Colonnes Date/Train/Étape en texte, pour éviter que Sheets ne les
    // réinterprète (ex : un numéro de train "01234" tronqué en nombre).
    sheet.getRange('A2:C').setNumberFormat('@');
  }
  return sheet;
}

/**
 * À exécuter UNE FOIS manuellement depuis l'éditeur Apps Script (menu
 * déroulant en haut → sélectionner "setupSheets" → ▶ Exécuter) pour créer
 * les onglets "Journal" et "Navettes" avec leurs en-têtes avant le premier
 * envoi depuis l'app. Sans appel manuel, ils se créent de toute façon
 * automatiquement au premier "logStep"/"logShuttle" reçu — cette fonction
 * sert juste à vérifier/forcer la création à l'avance.
 */
function setupSheets() {
  getOrCreateJournalSheet_();
  getOrCreateShuttleJournalSheet_();
}

function readScheduleRows_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map((h) => String(h).trim().toLowerCase());
  const idx = {
    train: headers.indexOf('train'),
    etape: headers.findIndex((h) => h.indexOf('etape') !== -1 || h.indexOf('étape') !== -1),
    heure: headers.findIndex((h) => h.indexOf('heure') !== -1),
    cause: headers.indexOf('cause'),
    jours: headers.findIndex((h) => h.indexOf('jour') !== -1),
    // Colonne "Date" facultative, conservée pour compatibilité avec un
    // ancien Sheet basé sur des dates précises plutôt que des jours
    // récurrents.
    date: headers.indexOf('date'),
  };

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const trainValue = idx.train > -1 ? row[idx.train] : '';
    if (!trainValue) continue;
    rows.push({
      train: String(trainValue).trim(),
      etape: idx.etape > -1 ? String(row[idx.etape] || '').trim() : '',
      heureTheorique: formatTimeValue_(idx.heure > -1 ? row[idx.heure] : ''),
      cause: idx.cause > -1 ? String(row[idx.cause] || '').trim() : '',
      jours: idx.jours > -1 ? String(row[idx.jours] || '').trim() : '',
      date: idx.date > -1 ? formatDateValue_(row[idx.date]) : '',
    });
  }
  return rows;
}

function formatDateValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  }
  return String(value || '').trim();
}

function formatTimeValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(value || '').trim();
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
