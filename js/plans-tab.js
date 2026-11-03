// Onglet "Plans RFP Le Havre" : bascule entre le suivi des trains et
// l'Atlas des plans du Réseau Ferré Portuaire (plans/index.html), chargé dans
// un cadre seulement à la première ouverture pour ne pas ralentir le
// démarrage. Le thème clair/sombre de l'application est transmis au cadre.
// Lien direct vers l'onglet : ajouter #plans-rfp à l'adresse.

const tabs = [...document.querySelectorAll('.view-tab')];
const suiviView = document.getElementById('suiviView');
const plansView = document.getElementById('plansView');
const frame = document.getElementById('plansFrame');

function syncTheme() {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    const dark = document.documentElement.classList.contains('theme-dark');
    doc.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (err) {
    // Cadre pas encore prêt : le thème est relu au chargement (voir 'load').
  }
}

function fitHeight() {
  const top = plansView.getBoundingClientRect().top + window.scrollY;
  plansView.style.setProperty('--plans-top', `${Math.max(0, top)}px`);
}

function show(view, updateHash) {
  tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  suiviView.hidden = view !== 'suivi';
  plansView.hidden = view !== 'plans';
  if (updateHash) {
    try {
      history.replaceState(null, '', view === 'plans' ? '#plans-rfp' : location.pathname + location.search);
    } catch (err) { /* sans conséquence */ }
  }
  if (view === 'plans') {
    window.scrollTo(0, 0);
    fitHeight();
    if (!frame.getAttribute('src')) frame.setAttribute('src', 'plans/index.html');
  }
}

tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.view, true)));
frame.addEventListener('load', syncTheme);
new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', () => { if (!plansView.hidden) fitHeight(); });
window.addEventListener('hashchange', () => { if (location.hash === '#plans-rfp') show('plans'); });
if (location.hash === '#plans-rfp') show('plans');
