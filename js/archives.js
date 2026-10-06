// Archives des PDF récap quotidiens (IndexedDB, stockage local au
// navigateur — aucun serveur). Chaque jour est une seule entrée, clé =
// date 'YYYY-MM-DD' (régénérer/écraser le PDF du même jour remplace
// l'entrée existante plutôt que d'en créer une nouvelle). Utilisé par
// generateDailyRecapPDF (bouton "📄 PDF récap", manuel) et
// archiveDailyRecapSilently (automatique, à minuit) dans app.js, ainsi
// que par l'écran "🗄 Archives" (openArchivesModal) qui liste/télécharge/
// supprime ces entrées.
//
// IMPORTANT : ce stockage est local à CET appareil/navigateur, comme
// localStorage (voir storage.js) — il ne synchronise rien entre
// appareils et peut être vidé par l'utilisateur (nettoyage du
// navigateur). Conservé automatiquement ARCHIVE_RETENTION_DAYS jours
// maximum (pruneOldArchives, appelée après chaque archivage automatique
// et une fois au démarrage) pour ne jamais faire grossir indéfiniment le
// stockage.
const DB_NAME = 'traintrack-archives';
const DB_VERSION = 1;
const STORE_NAME = 'recapPdfs';
export const ARCHIVE_RETENTION_DAYS = 400;

let dbPromise = null;

function openArchivesDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB indisponible sur ce navigateur')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'date' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// `blob` : le PDF généré (doc.output('blob') côté jsPDF). `meta` : champs
// supplémentaires optionnels fusionnés dans l'entrée (aucun pour l'instant,
// prévu pour une extension future sans migration de schéma).
export async function saveArchivePdf(dateISO, blob, meta = {}) {
  const db = await openArchivesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({
      date: dateISO,
      blob,
      size: blob.size,
      generatedAt: new Date().toISOString(),
      ...meta,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Liste triée du plus récent au plus ancien — inclut le blob complet de
// chaque PDF (volumes attendus : quelques dizaines à centaines de Ko par
// jour, donc sans souci pour un affichage en liste dans une modale).
export async function listArchivePdfs() {
  const db = await openArchivesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.date.localeCompare(a.date)));
    req.onerror = () => reject(req.error);
  });
}

export async function getArchivePdf(dateISO) {
  const db = await openArchivesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(dateISO);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteArchivePdf(dateISO) {
  const db = await openArchivesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(dateISO);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Supprime les archives plus vieilles que `maxDays` jours (défaut :
// ARCHIVE_RETENTION_DAYS). Appelée après chaque archivage automatique et
// une fois au démarrage de l'app (voir init() dans app.js) — jamais
// bloquante : une erreur ici n'empêche rien d'autre de fonctionner.
export async function pruneOldArchives(maxDays = ARCHIVE_RETENTION_DAYS) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  const pad = (n) => String(n).padStart(2, '0');
  const cutoffISO = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
  const all = await listArchivePdfs();
  const stale = all.filter((r) => r.date < cutoffISO);
  await Promise.all(stale.map((r) => deleteArchivePdf(r.date)));
}
