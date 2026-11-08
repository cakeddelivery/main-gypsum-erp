/*
 * Satukan supplier dobel (sekali jalan, aman diulang).
 *
 *   npm run satukan:supplier                                                        -> hanya MENAMPILKAN rencana (aman)
 *   npm run satukan:supplier -- --gabung="Supplier BG Klip Label" --ke="Afdhol Grafika"   -> pratinjau gabung
 *   npm run satukan:supplier -- --gabung="Supplier BG Klip Label" --ke="Afdhol Grafika" --jalankan
 *
 * 1. Hutang supplier & pembelian yang hanya diketik nama pemasoknya (belum tertaut ke master Supplier) ditautkan ke
 *    supplier dengan nama sama (tanpa kata umum "supplier"/"toko"), atau dibuatkan supplier baru.
 * 2. --gabung/--ke: semua hutang, pembelian & item supplier pertama dipindah ke supplier kedua; nama lama disimpan
 *    sebagai nama lain (tetap dikenali bot). --gabung/--ke boleh nama supplier atau nama pemasok di dokumen hutang.
 * 3. Daftar supplier yang namanya mirip (calon dobel) ditampilkan untuk dicek.
 * Jurnal tidak berubah (nama pemasok hanya keterangan). WAJIB backup dulu: npm run backup
 */
import { prisma } from "../src/lib/db";
import { findSupplierByName, mergeSuppliers, resolveSupplier, similarSuppliers, supplierKey } from "../src/lib/suppliers";

const apply = process.argv.includes("--jalankan");
const arg = (k: string) => process.argv.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3).replace(/^"|"$/g, "") ?? null;

type Found = { id: string | null; name: string; code: string | null; pending: boolean; docs: string[] };

/**
 * Cari supplier dari nama: master Supplier (termasuk nama lain), lalu nama pemasok di dokumen hutang (semua jenis)
 * & pembelian. Dokumen tanpa supplier: saat --jalankan dibuatkan/ditautkan supplier-nya.
 */
async function locate(name: string, actor: { id: string; name: string }): Promise<Found | null> {
  const s = await findSupplierByName(prisma, name);
  if (s) return { id: s.id, name: s.name, code: s.code, pending: false, docs: [] };
  const key = supplierKey(name);
  if (key.length < 2) return null;
  const [pays, purs] = await Promise.all([prisma.payable.findMany({ select: { id: true, number: true, vendor: true, supplierId: true } }), prisma.purchase.findMany({ select: { id: true, number: true, vendor: true, supplierId: true } })]);
  const docs = [...pays.map((d) => ({ ...d, type: "hutang" as const })), ...purs.map((d) => ({ ...d, type: "pembelian" as const }))].filter((d) => supplierKey(d.vendor) === key);
  if (!docs.length) return null;
  const linked = docs.find((d) => d.supplierId);
  if (linked) {
    const ls = await prisma.supplier.findUniqueOrThrow({ where: { id: linked.supplierId! } });
    return { id: ls.id, name: ls.name, code: ls.code, pending: false, docs: [] };
  }
  if (!apply) return { id: null, name: docs[0].vendor, code: null, pending: true, docs: docs.map((d) => d.number) };
  const ns = await resolveSupplier(prisma, { name: docs[0].vendor }, actor, "skrip satukan-supplier");
  for (const d of docs) {
    if (d.type === "hutang") await prisma.payable.update({ where: { id: d.id }, data: { supplierId: ns!.id } });
    else await prisma.purchase.update({ where: { id: d.id }, data: { supplierId: ns!.id } });
  }
  return { id: ns!.id, name: ns!.name, code: ns!.code, pending: false, docs: [] };
}

/** Semua nama supplier & pemasok di dokumen, supaya nama persisnya bisa disalin */
async function listNames() {
  const [sups, pays, purs] = await Promise.all([prisma.supplier.findMany({ orderBy: { name: "asc" } }), prisma.payable.findMany({ select: { vendor: true, kind: true } }), prisma.purchase.findMany({ select: { vendor: true } })]);
  console.log(`   Supplier di master: ${sups.map((x) => x.name + (x.aliases ? ` (nama lain: ${x.aliases})` : "")).join(" · ") || "-"}`);
  console.log(`   Pemasok di hutang: ${[...new Set(pays.map((p) => `${p.vendor}${p.kind === "PINJAMAN" ? " [pinjaman]" : ""}`))].join(" · ") || "-"}`);
  console.log(`   Pemasok di pembelian: ${[...new Set(purs.map((p) => p.vendor))].join(" · ") || "-"}`);
}

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true } });
  if (!owner) throw new Error("User owner tidak ditemukan");
  const actor = { id: owner.id, name: "skrip satukan-supplier" };

  // 1. Dokumen tanpa supplier
  const loosePay = await prisma.payable.findMany({ where: { kind: "USAHA", supplierId: null }, orderBy: { date: "asc" } });
  const loosePur = await prisma.purchase.findMany({ where: { supplierId: null }, orderBy: { date: "asc" } });
  console.log(`1. Hutang/pembelian tanpa master supplier: ${loosePay.length} hutang, ${loosePur.length} pembelian`);
  for (const doc of [...loosePay.map((p) => ({ ...p, type: "hutang" as const })), ...loosePur.map((p) => ({ ...p, type: "pembelian" as const }))]) {
    const found = await findSupplierByName(prisma, doc.vendor);
    console.log(`   ${doc.number} "${doc.vendor}" → ${found ? `supplier ${found.name}` : "supplier BARU"}`);
    if (!apply) continue;
    const s = await resolveSupplier(prisma, { name: doc.vendor }, actor, "skrip satukan-supplier");
    if (!s) continue;
    if (doc.type === "hutang") await prisma.payable.update({ where: { id: doc.id }, data: { supplierId: s.id, vendor: s.name } });
    else await prisma.purchase.update({ where: { id: doc.id }, data: { supplierId: s.id, vendor: s.name } });
  }

  // 2. Gabung
  const from = arg("gabung");
  const to = arg("ke");
  if (from || to) {
    if (!from || !to) throw new Error("Isi --gabung=\"nama\" dan --ke=\"nama\"");
    console.log(`\n2. Gabung "${from}" → "${to}"`);
    const src = await locate(from, actor);
    const dst = await locate(to, actor);
    if (!src || !dst) {
      const miss = !src ? from : to;
      console.log(`   "${miss}" tidak ditemukan di database ini: bukan nama supplier, nama lain, atau nama pemasok di hutang/pembelian.`);
      await listNames();
      if (apply) throw new Error(`"${miss}" tidak ditemukan. Salin nama persis dari daftar di atas.`);
    } else if (src.pending || dst.pending) {
      console.log(`   ${[src, dst].filter((x) => x.pending).map((x) => `"${x.name}" belum ada di master Supplier, dibuat dari dokumen ${x.docs.join(", ")} saat --jalankan`).join("; ")}.`);
      console.log(`   Lalu digabung ke ${dst.name}; "${src.name}" disimpan sebagai nama lain.`);
    } else if (src.id === dst.id) {
      console.log(`   Sudah satu supplier: ${dst.name}`);
    } else {
      const [it, pu, pa] = await Promise.all([
        prisma.item.count({ where: { supplierId: src.id! } }),
        prisma.purchase.count({ where: { supplierId: src.id! } }),
        prisma.payable.findMany({ where: { supplierId: src.id! } }),
      ]);
      console.log(`   ${src.name} (${src.code ?? "-"}) → ${dst.name} (${dst.code ?? "-"}): ${pa.length} hutang [${pa.map((p) => `${p.number} sisa Rp ${Number(p.amount - p.paid).toLocaleString("id-ID")}`).join(", ")}], ${pu} pembelian, ${it} item`);
      console.log(`   Nama dipakai: ${dst.name}; "${src.name}" disimpan sebagai nama lain.`);
      if (apply) {
        const r = await mergeSuppliers(src.id!, dst.id!, actor);
        console.log(`   ✓ Digabung: ${r.payables} hutang, ${r.purchases} pembelian, ${r.items} item`);
      }
    }
  }

  // 3. Calon dobel
  const all = await prisma.supplier.findMany({ orderBy: { name: "asc" } });
  const pairs = new Set<string>();
  for (const s of all) {
    for (const o of await similarSuppliers(prisma, s.name, s.id)) {
      const k = [s.id, o.id].sort().join();
      if (pairs.has(k)) continue;
      pairs.add(k);
      console.log(`${pairs.size === 1 ? "\n3. Supplier dengan nama mirip (cek, gabungkan bila sama):\n" : ""}   ${s.name}  ≈  ${o.name}`);
    }
  }
  if (!pairs.size) console.log("\n3. Tidak ada supplier dengan nama mirip.");
  console.log(apply ? "\nSelesai." : "\nIni pratinjau. Tambahkan  --jalankan  untuk menyimpan.");
}

main()
  .catch((e) => {
    console.error("GAGAL:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
