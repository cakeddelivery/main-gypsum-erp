/*
 * Audit resep HPP (HANYA MEMBACA, tidak mengubah data):
 *   npm run cek:resep-hpp
 * Mencari upah borongan / overhead yang dihitung dobel antar tahap, upah yang diketik manual (bukan dari Tugas & Tarif),
 * biaya manual lama di produk, dan faktor overhead selain 1; menampilkan usul perbaikan per resep.
 */
import { prisma } from "../src/lib/db";
import { auditRecipes } from "../src/lib/recipeRules";

const LABEL: Record<string, string> = { DOBEL_UPAH: "UPAH DOBEL", DOBEL_OVERHEAD: "OVERHEAD DOBEL", UPAH_MANUAL: "Upah manual", BIAYA_MANUAL_LAMA: "Biaya manual lama", FAKTOR_OVERHEAD: "Faktor overhead" };
(async () => {
  const list = await auditRecipes();
  const dobel = list.filter((x) => x.kind === "DOBEL_UPAH" || x.kind === "DOBEL_OVERHEAD");
  console.log(`${list.length} temuan (${dobel.length} dobel antar tahap)\n`);
  let last = "";
  for (const x of list.sort((a, b) => a.name.localeCompare(b.name))) {
    const head = `${x.owner}: ${x.name}`;
    if (head !== last) console.log(head);
    last = head;
    console.log(`   [${LABEL[x.kind]}] ${x.detail}\n      → ${x.proposal}`);
  }
  if (!list.length) console.log("Tidak ada masalah resep.");
  else console.log("\nPerbaiki lewat Produk & HPP → Ubah Resep (baris bertanda merah). Skrip ini tidak mengubah data.");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
