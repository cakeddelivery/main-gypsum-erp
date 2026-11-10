/**
 * Kompres foto bukti lama di folder penyimpanan (STORAGE_DIR) agar hemat disk VPS.
 *
 *   npm run kompres:file                         → pratinjau: jumlah file, ukuran sekarang → perkiraan sesudah, 10 terbesar
 *   npm run kompres:file -- --jalankan           → kompres di tempat
 *   npm run kompres:file -- --dir=/path/folder   → folder lain (mis. staging)
 *
 * Folder: --dir, lalu STORAGE_DIR di environment, lalu STORAGE_DIR di file .env folder ini, lalu ./storage/private.
 * Path & nama file tidak berubah, jadi tautan di database tetap valid. PDF tidak diubah.
 * Aman diulang: file yang sudah kecil / sudah diproses dilewati. Tulis lewat file sementara lalu rename.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compressStorage, fmtBytes } from "../src/lib/compressStorage";

const run = process.argv.includes("--jalankan");
const dirArg = process.argv.find((a) => a.startsWith("--dir="))?.slice(6);

function envFileStorageDir(): string | undefined {
  if (!existsSync(".env")) return undefined;
  const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => /^\s*(export\s+)?STORAGE_DIR\s*=/.test(l));
  return line?.replace(/^\s*(export\s+)?STORAGE_DIR\s*=\s*/, "").replace(/^["']|["']$/g, "").trim() || undefined;
}

async function main() {
  const dir = path.resolve(dirArg || process.env.STORAGE_DIR || envFileStorageDir() || "./storage/private");
  if (!existsSync(dir)) {
    console.log(`Folder tidak ditemukan: ${dir}`);
    process.exit(1);
  }
  console.log(run ? "MODE JALANKAN (file dikompres di tempat)" : "PRATINJAU (tidak mengubah apa pun; tambahkan -- --jalankan untuk mengompres)");
  console.log(`Folder: ${dir}\n`);
  let n = 0;
  const r = await compressStorage(dir, {
    run,
    onFile: () => {
      if (++n % 50 === 0) process.stdout.write(`  ...${n} file diperiksa\n`);
    },
  });
  const count = (s: string) => r.files.filter((f) => f.status === s).length;
  console.log(`Jumlah file          : ${r.total}`);
  console.log(`  dikompres          : ${count("dikompres")}`);
  if (count("metadata dibuang")) console.log(`  EXIF/GPS dibuang   : ${count("metadata dibuang")} (file kecil, piksel tidak diubah)`);
  console.log(`  sudah kecil        : ${count("sudah kecil")}`);
  console.log(`  sudah diproses     : ${count("sudah diproses")}`);
  console.log(`  tidak lebih kecil  : ${count("tidak lebih kecil")}`);
  console.log(`  PDF / bukan gambar : ${count("bukan gambar")}`);
  if (count("gagal")) console.log(`  gagal (dibiarkan)  : ${count("gagal")}`);
  console.log(`\nTotal ukuran sekarang : ${fmtBytes(r.before)}`);
  console.log(`${run ? "Total ukuran sesudah  " : "Perkiraan sesudah     "}: ${fmtBytes(r.after)}`);
  console.log(`${run ? "Ruang yang dihemat    " : "Perkiraan hemat       "}: ${fmtBytes(r.before - r.after)}${r.before ? ` (${Math.round(((r.before - r.after) / r.before) * 100)}%)` : ""}`);
  const top = [...r.files].sort((a, b) => b.before - a.before).slice(0, 10);
  if (top.length) {
    console.log(`\n10 file terbesar:`);
    for (const f of top) console.log(`  ${fmtBytes(f.before).padStart(9)} → ${fmtBytes(f.after).padStart(9)}  ${f.status.padEnd(17)} ${f.rel}`);
  }
  if (!run && r.changed) console.log(`\nUntuk mengompres: npm run kompres:file -- --jalankan${dirArg ? ` --dir=${dirArg}` : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
