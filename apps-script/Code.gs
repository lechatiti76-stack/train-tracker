/**
 * Web App Google Apps Script — publie en lecture seule les horaires
 * théoriques d'un Google Sheet, au format JSON, pour l'application
 * "Suivi Trains". Aucune clé API n'est nécessaire : Apps Script gère
 * l'autorisation sous le compte du propriétaire de la feuille, et le Web
 * App ne fait QUE lire (aucune fonction d'écriture n'est exposée ici).
 *
 * Installation : voir la section "Connecter Google Sheets" du README.md
 * à la racine du projet.
 *
 * Colonnes attendues dans l'onglet "Horaires" (ligne d'en-tête obligatoire) :
 *   Date | Train | Étape | Heure théorique | Cause
 * - Date            : JJ/MM/AAAA (ou une vraie date de cellule Sheets)
 * - Train           : numéro du train (ex : 1234)
 * - Étape           : doit correspondre au libellé configuré côté app
 *                     (ex : "Départ", "Point 1", ..., "Arrivée")
 * - Heure théorique : HH:MM (ou une vraie heure de cellule Sheets)
 * - Cause           : texte libre, optionnel (laisser vide ou "-" si non
 *                     renseigné)
 */

const SHEET_NAME = 'Horaires';

function doGet(e) {
  try {
    const rows = readScheduleRows_();
    return jsonResponse_(rows);
  } catch (err) {
    return jsonResponse_({ error: String(err) });
  }
}

function readScheduleRows_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map((h) => String(h).trim().toLowerCase());
  const idx = {
    date: headers.indexOf('date'),
    train: headers.indexOf('train'),
    etape: headers.findIndex((h) => h.indexOf('etape') !== -1 || h.indexOf('étape') !== -1),
    heure: headers.findIndex((h) => h.indexOf('heure') !== -1),
    cause: headers.indexOf('cause'),
  };

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const trainValue = idx.train > -1 ? row[idx.train] : '';
    if (!trainValue) continue;
    rows.push({
      date: formatDateValue_(idx.date > -1 ? row[idx.date] : ''),
      train: String(trainValue).trim(),
      etape: idx.etape > -1 ? String(row[idx.etape] || '').trim() : '',
      heureTheorique: formatTimeValue_(idx.heure > -1 ? row[idx.heure] : ''),
      cause: idx.cause > -1 ? String(row[idx.cause] || '').trim() : '',
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
