// Lien avec l'application « Suivi des circulations » (poste de saisie + écrans
// TV du terminal). Sens circulations → Suivi trains : on relit, sans clé et en
// lecture seule, ce que reçoivent les écrans (Web App Apps Script du suivi des
// circulations, ?action=diffusion) et on reporte ici ce qui a été validé dans
// la saisie : départ d'une navette de son terminal (FL1 « partie »), son
// arrivée, le tableau rapide des départs (LF1 parti) et les arrivées fret.
// L'autre sens (Suivi trains → circulations) passe déjà par l'onglet
// "Navettes" du Google Sheet (voir pushShuttleLogToSheet dans sheets-sync.js).
//
// Règle « le dernier changement gagne » : une valeur n'est reportée que si
// elle est nouvelle ou a changé côté circulations depuis la dernière lecture
// (mémorisée dans `seen`). Une correction faite ici reste donc tant que la
// saisie n'envoie pas une nouvelle heure, et rien ne rebondit d'une
// application à l'autre. Logique pure (pas de DOM), appliquée par app.js.

// Trains de ligne du suivi des circulations (code) → vignette d'arrivée fret
// d'ici (id de ARRIVAL_GROUPS dans config.js).
export const CIRCULATIONS_ARRIVAL_IDS = { VNX: 'venissieux', SPCO: 'spco', BDX: 'bordeaux', VIERZN: 'vierzon', CLERMT: 'clermont' };

function hhmm(isoLocal) { return isoLocal ? String(isoLocal).slice(11, 16) : ''; }

export async function fetchCirculationsDiffusion(execUrl, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const sep = execUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${execUrl}${sep}action=diffusion&t=${Date.now()}`, { cache: 'no-store', redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.diffusion) throw new Error('aucune donnée publiée par la saisie');
    return data.diffusion;
  } finally {
    clearTimeout(timer);
  }
}

// Valeurs publiées pour aujourd'hui, une par case d'ici :
// [{ key, kind, code, value: 'HH:MM' | '' }]. null si la diffusion est d'un autre jour.
// kind : shuttleDeparture / shuttleArrival (vignettes navettes FL, NL, AL…),
// quickboard (tableau rapide LF, LN, LA…), arrivalDeparture / arrivalArrival (arrivées fret).
export function circulationsValues(diffusion, todayISO) {
  if (!diffusion || diffusion.date !== todayISO) return null;
  const out = [];
  (diffusion.navettes || []).forEach((g) => (g.lignes || []).forEach((l) => {
    if (!l || !l.code) return;
    if (l.sens === 'D') {
      out.push({ key: `Q:${l.code}`, kind: 'quickboard', code: l.code, value: hhmm(l.reel) });
    } else {
      out.push({ key: `N:${l.code}`, kind: 'shuttleDeparture', code: l.code, value: hhmm(l.partie) });
      out.push({ key: `N:${l.code}-arr`, kind: 'shuttleArrival', code: l.code, value: hhmm(l.reel) });
    }
  }));
  (diffusion.trains || []).forEach((t) => {
    const id = CIRCULATIONS_ARRIVAL_IDS[t.code];
    if (!id || !t.arrivee) return;
    out.push({ key: `A:${id}`, kind: 'arrivalDeparture', code: id, value: hhmm(t.arrivee.partie) });
    out.push({ key: `A:${id}-arr`, kind: 'arrivalArrival', code: id, value: hhmm(t.arrivee.reel) });
  });
  return out;
}

// Changements à faire ici. `current(kind, code)` renvoie la valeur locale
// actuelle ('HH:MM' ou ''). `seen` est mis à jour en place.
// Une valeur effacée côté circulations n'efface ici que si la valeur locale
// est encore celle qui venait de là-bas.
export function planCirculationsUpdates(values, seen, current) {
  const updates = [];
  (values || []).forEach((v) => {
    if (seen[v.key] === v.value) return;
    const previous = seen[v.key];
    seen[v.key] = v.value;
    const local = current(v.kind, v.code);
    if (v.value) {
      if (local !== v.value) updates.push(v);
    } else if (previous && local === previous) {
      updates.push(v);
    }
  });
  return updates;
}
