// Générateur d'icônes PWA (sans dépendance externe, utilise seulement "zlib").
// Usage : node tools/generate-icons.js
// Régénère toutes les icônes dans /assets/icons à partir d'un pictogramme
// "train" dessiné procéduralement (formes vectorielles simples).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets', 'icons');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------- Encodeur PNG minimal (RGBA 8 bits) ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- Petit "canvas" avec anti-aliasing par sur-échantillonnage ----------
function createCanvas(size) {
  const buf = new Float64Array(size * size * 4); // r,g,b,a en 0..1 (alpha pré-multiplié)
  function blend(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const outA = a + buf[i + 3] * (1 - a);
    if (outA <= 0) return;
    buf[i] = (r * a + buf[i] * buf[i + 3] * (1 - a)) / outA;
    buf[i + 1] = (g * a + buf[i + 1] * buf[i + 3] * (1 - a)) / outA;
    buf[i + 2] = (b * a + buf[i + 2] * buf[i + 3] * (1 - a)) / outA;
    buf[i + 3] = outA;
  }
  // Dessine une forme définie par une fonction de test `inside(nx, ny)` (coords 0..100)
  // avec 4x sur-échantillonnage par pixel pour lisser les bords.
  function fillShape(inside, colorFn) {
    const SS = 4;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        let coverage = 0;
        let r = 0, g = 0, b = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const x = px + (sx + 0.5) / SS;
            const y = py + (sy + 0.5) / SS;
            const nx = (x / size) * 100;
            const ny = (y / size) * 100;
            if (inside(nx, ny)) {
              coverage++;
              const c = colorFn(nx, ny);
              r += c[0]; g += c[1]; b += c[2];
            }
          }
        }
        const total = SS * SS;
        if (coverage > 0) {
          blend(px, py, r / coverage, g / coverage, b / coverage, coverage / total);
        }
      }
    }
  }
  function toPNGBuffer() {
    const out = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      out[i * 4] = Math.round(buf[i * 4] * 255);
      out[i * 4 + 1] = Math.round(buf[i * 4 + 1] * 255);
      out[i * 4 + 2] = Math.round(buf[i * 4 + 2] * 255);
      out[i * 4 + 3] = Math.round(buf[i * 4 + 3] * 255);
    }
    return out;
  }
  return { fillShape, toPNGBuffer };
}

// ---------- Primitives géométriques (coords 0..100) ----------
function inRoundedRect(nx, ny, x, y, w, h, r) {
  const cx = x + w / 2, cy = y + h / 2;
  const halfW = w / 2, halfH = h / 2;
  if (Math.abs(nx - cx) > halfW || Math.abs(ny - cy) > halfH) return false;
  const qx = Math.max(Math.abs(nx - cx) - (halfW - r), 0);
  const qy = Math.max(Math.abs(ny - cy) - (halfH - r), 0);
  return qx * qx + qy * qy <= r * r;
}
function inCircle(nx, ny, cx, cy, r) {
  const dx = nx - cx, dy = ny - cy;
  return dx * dx + dy * dy <= r * r;
}
function lerp(a, b, t) { return a + (b - a) * t; }
function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => c / 255);
}

function drawIcon(size, { maskable = false } = {}) {
  const canvas = createCanvas(size);
  const bgTop = hexToRgb('#0f1b33');
  const bgBottom = hexToRgb('#16233d');
  const accentA = hexToRgb('#22d3ee');
  const accentB = hexToRgb('#2563eb');
  const light = hexToRgb('#eaf6ff');
  const dark = hexToRgb('#0b1220');
  const track = hexToRgb('#3b4a63');

  // Fond dégradé vertical plein cadre (utile pour icônes "maskable")
  canvas.fillShape(
    () => true,
    (nx, ny) => {
      const t = ny / 100;
      return [lerp(bgTop[0], bgBottom[0], t), lerp(bgTop[1], bgBottom[1], t), lerp(bgTop[2], bgBottom[2], t)];
    }
  );

  // Zone de sécurité : pour les icônes "maskable", le contenu doit tenir
  // dans le cercle central à 80% (marge ~10% de chaque côté).
  const pad = maskable ? 14 : 8;
  const scale = (100 - pad * 2) / 100;
  const off = pad;
  const S = (v) => off + v * scale;

  // Rail
  canvas.fillShape(
    (nx, ny) => inRoundedRect(nx, ny, S(8), S(80), 84 * scale, 3 * scale, 1.5 * scale),
    () => track
  );

  // Corps du train (silhouette "pilule" façon TGV)
  canvas.fillShape(
    (nx, ny) => inRoundedRect(nx, ny, S(14), S(38), 72 * scale, 30 * scale, 14 * scale),
    (nx) => {
      const t = (nx - S(14)) / (72 * scale);
      return [lerp(accentA[0], accentB[0], t), lerp(accentA[1], accentB[1], t), lerp(accentA[2], accentB[2], t)];
    }
  );

  // Vitres
  canvas.fillShape((nx, ny) => inRoundedRect(nx, ny, S(23), S(45), 20 * scale, 12 * scale, 4 * scale), () => light);
  canvas.fillShape((nx, ny) => inRoundedRect(nx, ny, S(50), S(45), 27 * scale, 12 * scale, 4 * scale), () => light);

  // Roues
  canvas.fillShape((nx, ny) => inCircle(nx, ny, S(30), S(70), 6.5 * scale), () => dark);
  canvas.fillShape((nx, ny) => inCircle(nx, ny, S(70), S(70), 6.5 * scale), () => dark);
  canvas.fillShape((nx, ny) => inCircle(nx, ny, S(30), S(70), 2.6 * scale), () => light);
  canvas.fillShape((nx, ny) => inCircle(nx, ny, S(70), S(70), 2.6 * scale), () => light);

  return canvas.toPNGBuffer();
}

function save(name, size, opts) {
  const rgba = drawIcon(size, opts);
  const png = encodePNG(size, size, rgba);
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log('Généré:', name, `(${size}x${size})`);
}

save('icon-192.png', 192, { maskable: false });
save('icon-512.png', 512, { maskable: false });
save('icon-maskable-512.png', 512, { maskable: true });
save('apple-touch-icon-180.png', 180, { maskable: false });
save('favicon-32.png', 32, { maskable: false });
save('favicon-16.png', 16, { maskable: false });

console.log('Terminé. Icônes écrites dans', OUT_DIR);
