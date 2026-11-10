// Buat ikon PWA dari src/app/icon.png (512px) ke public/pwa/.
// Versi "-tes" diberi pita merah "TES" untuk staging agar tidak tertukar dengan aplikasi asli.
// Pakai: node scripts/pwa-icons.mjs   (hasilnya di-commit; tidak dijalankan saat build)
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const SRC = "src/app/icon.png";
const OUT = "public/pwa";
const BG = { r: 255, g: 239, b: 0, alpha: 1 }; // kuning latar logo
mkdirSync(OUT, { recursive: true });

const ribbon = (size) => {
  const h = Math.round(size * 0.2);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect x="0" y="0" width="${size}" height="${h}" fill="#dc2626"/>
    <text x="50%" y="${h * 0.74}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${h * 0.7}" fill="#fff" text-anchor="middle">TES</text>
  </svg>`);
};

async function base(size, tes) {
  let img = sharp(SRC).resize(size, size).flatten({ background: BG });
  if (tes) img = sharp(await img.png().toBuffer()).composite([{ input: ribbon(size) }]);
  return img.png().toBuffer();
}

// Maskable: isi logo di 80% tengah (zona aman), sisanya latar kuning
async function maskable(size, tes) {
  const inner = Math.round(size * 0.8);
  const logo = await sharp(SRC).resize(inner, inner).toBuffer();
  let buf = await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: "center" }]).png().toBuffer();
  if (tes) {
    // pita di dalam zona aman (lingkaran 80%)
    const r = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect x="${size * 0.25}" y="${size * 0.12}" width="${size * 0.5}" height="${size * 0.14}" rx="${size * 0.03}" fill="#dc2626"/>
      <text x="50%" y="${size * 0.229}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${size * 0.1}" fill="#fff" text-anchor="middle">TES</text>
    </svg>`);
    buf = await sharp(buf).composite([{ input: r }]).png().toBuffer();
  }
  return buf;
}

for (const tes of [false, true]) {
  const sfx = tes ? "-tes" : "";
  for (const s of [96, 192, 512]) await sharp(await base(s, tes)).toFile(`${OUT}/icon-${s}${sfx}.png`);
  await sharp(await base(180, tes)).removeAlpha().toFile(`${OUT}/apple-180${sfx}.png`);
  await sharp(await maskable(512, tes)).toFile(`${OUT}/maskable-512${sfx}.png`);
}
console.log("Ikon PWA dibuat di", OUT);
