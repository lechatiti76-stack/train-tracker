// Composant "panneau à palettes" (style ancien panneau d'aéroport / gare).
// Chaque caractère est une tuile indépendante qui ne se retourne que si sa
// valeur change réellement, ce qui garde l'effet léger même sur mobile.
// Le nombre de tuiles s'adapte à la largeur disponible (ResizeObserver) afin
// de ne jamais déborder ni imposer de défilement horizontal sur une petite
// vignette.
const CELL_FLIP_MS = 260;
const STAGGER_MS = 18;
const CELL_WITH_GAP_PX = 20; // largeur de tuile (~17px) + espacement (3px)

function stripAccents(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export class SplitFlapDisplay {
  constructor(container, { maxLength = 26, minLength = 8 } = {}) {
    this.container = container;
    this.maxLength = maxLength;
    this.minLength = minLength;
    this.length = minLength;
    this.current = '';
    this.lastRaw = '';
    this.cells = [];
    this.container.classList.add('flap-row');
    this._rebuild(this._computeLength());

    if ('ResizeObserver' in window) {
      this._observer = new ResizeObserver(() => this._handleResize());
      this._observer.observe(this.container);
    }
  }

  _computeLength() {
    const width = this.container.clientWidth || this.container.parentElement?.clientWidth || 0;
    if (!width) return this.minLength;
    const fit = Math.floor(width / CELL_WITH_GAP_PX);
    return Math.max(this.minLength, Math.min(this.maxLength, fit));
  }

  _handleResize() {
    const nextLength = this._computeLength();
    if (nextLength === this.length) return;
    this._rebuild(nextLength);
    this._paint(this.lastRaw, { animate: false });
  }

  _rebuild(length) {
    this.length = length;
    this.current = '';
    this.container.innerHTML = '';
    this.cells = [];
    for (let i = 0; i < length; i++) {
      const cell = document.createElement('span');
      cell.className = 'flap-cell';
      cell.textContent = ' ';
      this.container.appendChild(cell);
      this.cells.push(cell);
    }
  }

  setText(text) {
    this.lastRaw = text;
    this._paint(text, { animate: true });
  }

  _paint(text, { animate }) {
    const padded = stripAccents(String(text || ''))
      .toUpperCase()
      .slice(0, this.length)
      .padEnd(this.length, ' ');

    if (padded === this.current) return;
    const previous = this.current || ' '.repeat(this.length);
    this.current = padded;

    for (let i = 0; i < this.length; i++) {
      if (previous[i] === padded[i]) continue;
      const cell = this.cells[i];
      const nextChar = padded[i];

      if (!animate) {
        cell.textContent = nextChar;
        continue;
      }
      const delay = i * STAGGER_MS;
      setTimeout(() => {
        cell.classList.add('flipping');
        setTimeout(() => {
          cell.textContent = nextChar;
        }, CELL_FLIP_MS / 2);
        setTimeout(() => {
          cell.classList.remove('flipping');
        }, CELL_FLIP_MS);
      }, delay);
    }
  }
}
