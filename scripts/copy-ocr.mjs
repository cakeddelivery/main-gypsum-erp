// Salin mesin OCR (Tesseract) ke public/ocr agar dimuat dari server sendiri, bukan CDN.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const out = join(process.cwd(), "public", "ocr");
mkdirSync(out, { recursive: true });
const tjs = dirname(require.resolve("tesseract.js/package.json"));
const core = dirname(require.resolve("tesseract.js-core/package.json"));
const lang = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
cpSync(join(tjs, "dist", "worker.min.js"), join(out, "worker.min.js"));
for (const f of readdirSync(core)) if (/^tesseract-core.*lstm\.wasm\.js$/.test(f)) cpSync(join(core, f), join(out, f));
cpSync(join(lang, "4.0.0_best_int", "eng.traineddata.gz"), join(out, "eng.traineddata.gz"));
console.log("OCR disalin ke public/ocr");
