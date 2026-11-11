/**
 * Isi katalog produk induk + varian: Giftbox (Tipe × Paket × Series), Satuan Single Pack (Series),
 * Paket Single Pack (Jumlah × Series), plus bahan baku "Air" untuk resep Patung Kering.
 *
 *   npm run katalog:produk                          → pratinjau (tidak mengubah apa pun)
 *   npm run katalog:produk -- --jalankan            → simpan (jalankan npm run backup dulu)
 *   npm run katalog:produk -- --air-ml=120          → sekalian isi resep Patung Kering: 120 ml air per patung
 *                                                     (hanya untuk patung kering yang resepnya belum ada Air)
 *
 * Tidak menghapus apa pun. Produk lama yang cocok dimasukkan ke induk (kode, riwayat penjualan & HPP tetap).
 * Harga tidak diisi (isi lewat Produk & HPP → Produk Induk → Isi harga). Aman diulang.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { CATALOG, applySkuPlan, ensureFamily, planFamilySkus } from "../src/lib/productFamily";
import { ensureWaterItem, addWaterToKeringRecipes } from "../src/lib/water";
import { flowItem } from "../src/lib/shiftReportFlow";
import { VARIANTS } from "../src/lib/shiftReport";

const run = process.argv.includes("--jalankan");
const airMl = Number(process.argv.find((a) => a.startsWith("--air-ml="))?.split("=")[1] ?? "") || 0;
class Rollback extends Error {}

const LABEL = { baru: "BARU          ", "item-lama": "BARU+stok lama", "produk-lama": "PRODUK LAMA   ", ada: "sudah ada     " } as const;

async function main() {
  console.log(run ? "MODE SIMPAN" : "PRATINJAU (tambahkan -- --jalankan untuk menyimpan)");
  const storeId = (await prisma.setting.findUnique({ where: { key: "default_store_id" } }))?.value ?? (await prisma.store.findFirst({ orderBy: { code: "asc" } }))?.id;
  if (!storeId) throw new Error("Toko default belum diatur di Pengaturan");
  try {
    await prisma.$transaction(async (tx) => {
      for (const [i, spec] of CATALOG.entries()) {
        const f = await ensureFamily(tx, spec, i + 1);
        const plans = await planFamilySkus(tx, f, spec, storeId);
        console.log(`\n${f.code} ${f.name} — ${spec.axes.map((a) => `${a.name} (${a.options.map((o) => o.name).join(", ")})`).join(" × ")} = ${plans.length} SKU`);
        for (const p of plans) {
          const ref = p.existingProduct ? `  ← ${p.existingProduct.sku} ${p.existingProduct.name}` : p.existingItem ? `  ← item stok ${p.existingItem.sku} ${p.existingItem.name}` : "";
          console.log(`  ${LABEL[p.action]} ${p.name.padEnd(48)} ${String(p.attrs.packQty).padStart(3)} patung${ref}`);
        }
        const r = await applySkuPlan(tx, f, plans, { storeId, unit: spec.unit });
        console.log(`  → ${r.created} SKU baru, ${r.linked} produk lama dimasukkan ke induk`);
      }
      const water = await ensureWaterItem(tx);
      console.log(`\nBahan baku Air: ${water.created ? "BARU" : "sudah ada"} ${water.item.sku} (${water.item.unit}, resep dalam ml, harga Rp${Number(water.item.lastCost).toLocaleString("id-ID")}/liter)`);
      if (airMl > 0) {
        // Patung kering per karakter (SJ-PTG-…) dibuat bila belum ada, sama seperti alur laporan shift
        for (const v of VARIANTS) await flowItem(tx, { kind: "kering", key: v });
        const added = await addWaterToKeringRecipes(tx, water.item.id, airMl);
        for (const a of added) console.log(`  + resep ${a.sku} ${a.name}: Air ${airMl} ml`);
        if (!added.length) console.log("  (tidak ada patung kering yang perlu ditambah Air)");
      } else console.log("  Takaran air per patung diisi di Produk & HPP → Barang Setengah Jadi → Patung kering (atau ulangi dengan --air-ml=N)");
      if (!run) throw new Rollback();
    }, { timeout: 120000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    console.log("\nTersimpan. Lanjut isi harga & resep di Produk & HPP → Produk Induk.");
  } catch (e) {
    if (e instanceof Rollback) console.log("\nBelum ada yang diubah.");
    else throw e;
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
