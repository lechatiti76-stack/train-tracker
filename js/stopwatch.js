// Chronomètre indépendant (pas lié à un train précis) pour mesurer un temps
// de pause/arrêt, avec un indicateur façon feu tricolore :
//   rouge   : 0 à 15 min
//   orange  : 15 à 20 min
//   vert    : à partir de 20 min
// L'état persiste (localStorage) pour survivre à un rechargement accidentel
// pendant une mesure en cours.
const STORAGE_KEY = 'traintrack:stopwatch:v1';
const THRESHOLDS_MIN = { orange: 15, green: 20 };

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.elapsedMs === 'number') return parsed;
  } catch (err) {
    // Etat corrompu : on repart de zéro plutôt que de planter.
  }
  return { status: 'idle', startedAt: null, elapsedMs: 0 };
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // localStorage indisponible (quota, navigation privée...) : le
    // chronomètre reste fonctionnel pour la session en cours.
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function currentElapsedMs(state) {
  if (state.status === 'running' && state.startedAt) {
    return state.elapsedMs + (Date.now() - new Date(state.startedAt).getTime());
  }
  return state.elapsedMs;
}

function toneForElapsed(ms) {
  const minutes = ms / 60000;
  if (minutes >= THRESHOLDS_MIN.green) return 'green';
  if (minutes >= THRESHOLDS_MIN.orange) return 'orange';
  return 'red';
}

export function initStopwatch(root) {
  let state = loadState();
  const displayEl = root.querySelector('[data-role="stopwatch-display"]');
  const startBtn = root.querySelector('[data-action="stopwatch-start"]');
  const stopBtn = root.querySelector('[data-action="stopwatch-stop"]');
  const resetBtn = root.querySelector('[data-action="stopwatch-reset"]');
  const lights = {
    red: root.querySelector('[data-role="light-red"]'),
    orange: root.querySelector('[data-role="light-orange"]'),
    green: root.querySelector('[data-role="light-green"]'),
  };

  function render() {
    const elapsed = currentElapsedMs(state);
    displayEl.textContent = formatElapsed(elapsed);
    const tone = toneForElapsed(elapsed);
    Object.entries(lights).forEach(([key, el]) => {
      if (el) el.classList.toggle('active', key === tone);
    });
    root.classList.toggle('is-running', state.status === 'running');
    startBtn.disabled = state.status === 'running';
    stopBtn.disabled = state.status !== 'running';
  }

  startBtn.addEventListener('click', () => {
    if (state.status === 'running') return;
    state = { status: 'running', startedAt: new Date().toISOString(), elapsedMs: state.elapsedMs };
    saveState(state);
    render();
  });

  stopBtn.addEventListener('click', () => {
    if (state.status !== 'running') return;
    state = { status: 'stopped', startedAt: null, elapsedMs: currentElapsedMs(state) };
    saveState(state);
    render();
  });

  resetBtn.addEventListener('click', () => {
    if (state.elapsedMs > 0 || state.status === 'running') {
      if (!confirm('Réinitialiser le chronomètre ?')) return;
    }
    state = { status: 'idle', startedAt: null, elapsedMs: 0 };
    saveState(state);
    render();
  });

  render();
  setInterval(() => {
    if (state.status === 'running') render();
  }, 1000);
}
