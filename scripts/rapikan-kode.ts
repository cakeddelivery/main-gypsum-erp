/*
 * Rapikan kode lama ke format kode otomatis (sekali jalan, aman diulang).
 *
 *   npm run rapikan:kode               -> hanya MENAMPILKAN rencana perubahan (aman, tidak menyimpan apa pun)
 *   npm run rapikan:kode -- --jalankan -> menyimpan perubahan
 *
 * DIUBAH (hanya yang belum sesuai pola):
 *   Karyawan        K001          -> CTK-001       (awalan = kode divisi)
 *   Item stok       BB-GYP        -> BU-001        (awalan = kategori; bahan divisi -> BB-PRD-001)
 *   Produk jadi     (ikut kode item barang jadinya, mis. MG-001)
 *   Tugas borongan  CAT_GIFTBOX   -> BRG-001
 *   Supplier / pelanggan tanpa kode -> SUP-001 / PLG-001
 * TIDAK DIUBAH: akun COA (6-1100), rekening (SEABANK), divisi (CTK), toko (MG), shift (S1), lokasi (GBB)
 *   karena sudah berpola dan dipakai jurnal sistem / bot keuangan; nomor dokumen & periode gaji (sudah tercetak di slip).
 *
 * Semua relasi memakai id, jadi riwayat (absen, slip, stok, jurnal) tetap tersambung. WAJIB backup dulu: npm run backup
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { autoCode, nextSequence } from "../src/lib/codes";
import { categoryPrefix } from "../src/lib/itemCatalog";

const prisma = new PrismaClient();
const apply = process.argv.includes("--jalankan");
class DryRun extends Error {}

type Change = { group: string; from: string; to: string; name: string };
const fits = (code: string, prefix: string) => new RegExp(`^${prefix.replace(/[-]/g, "\\-")}-\\d{3,}$`).test(code);

async function plan(tx: Prisma.TransactionClient) {
  const out: Change[] = [];

  // Karyawan: awalan kode divisi
  const emps = await tx.employee.findMany({ include: { division: { select: { code: true } } }, orderBy: [{ joinDate: "asc" }, { code: "asc" }] });
  for (const e of emps) {
    if (fits(e.code, e.division.code)) continue;
    const code = await autoCode.employee(tx, e.divisionId);
    await tx.employee.update({ where: { id: e.id }, data: { code } });
    out.push({ group: "Karyawan", from: e.code, to: code, name: e.name });
  }

  // Item stok: awalan kategori; bahan per divisi tanpa kategori -> BB-<divisi>
  const items = await tx.item.findMany({ include: { division: { select: { code: true } } }, orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }] });
  for (const i of items) {
    const perDivision = i.type === "BAHAN_BAKU" && !i.category && i.division;
    const prefix = perDivision ? `BB-${i.division!.code}` : categoryPrefix(i.type, i.category);
    if (fits(i.sku, prefix)) continue;
    const sku = await nextSequence(tx, prefix, async (s) => !!(await tx.item.findUnique({ where: { sku: s } })), { key: perDivision ? `KODE-${prefix}` : `SKU-${prefix}` });
    await tx.item.update({ where: { id: i.id }, data: { sku } });
    out.push({ group: "Item stok", from: i.sku, to: sku, name: i.name });
  }

  // Produk jadi: samakan dengan kode item barang jadinya
  const products = await tx.product.findMany({ include: { finishedItem: { select: { sku: true } } }, orderBy: { name: "asc" } });
  for (const p of products) {
    let sku = p.finishedItem?.sku;
    if (!sku) {
      if (fits(p.sku, "MG")) continue;
      sku = await nextSequence(tx, "MG", async (s) => !!(await tx.item.findUnique({ where: { sku: s } })) || !!(await tx.product.findUnique({ where: { sku: s } })), { key: "SKU-MG" });
    }
    if (sku === p.sku) continue;
    const other = await tx.product.findUnique({ where: { sku } });
    if (other) await tx.product.update({ where: { id: other.id }, data: { sku: `${other.sku}-TMP-${other.id.slice(-4)}` } });
    await tx.product.update({ where: { id: p.id }, data: { sku } });
    out.push({ group: "Produk jadi", from: p.sku, to: sku, name: p.name });
  }

  const tasks = await tx.pieceTask.findMany({ orderBy: { code: "asc" } });
  for (const t of tasks) {
    if (fits(t.code, "BRG")) continue;
    const code = await autoCode.pieceTask(tx);
    await tx.pieceTask.update({ where: { id: t.id }, data: { code } });
    out.push({ group: "Tugas borongan", from: t.code, to: code, name: t.name });
  }

  for (const s of await tx.supplier.findMany({ where: { code: null }, orderBy: { name: "asc" } })) {
    const code = await autoCode.supplier(tx);
    await tx.supplier.update({ where: { id: s.id }, data: { code } });
    out.push({ group: "Supplier", from: "-", to: code, name: s.name });
  }
  for (const c of await tx.customer.findMany({ where: { code: null }, orderBy: { createdAt: "asc" } })) {
    const code = await autoCode.customer(tx);
    await tx.customer.update({ where: { id: c.id }, data: { code } });
    out.push({ group: "Pelanggan", from: "-", to: code, name: c.name });
  }
  return out;
}

async function main() {
  let changes: Change[] = [];
  try {
    await prisma.$transaction(
      async (tx) => {
        changes = await plan(tx);
        if (!apply) throw new DryRun();
        await tx.auditLog.create({ data: { actorName: "skrip rapikan:kode", action: "KODE_DIRAPIKAN", entity: "System", entityId: "rapikan-kode", data: { changes } as unknown as Prisma.InputJsonValue } });
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  if (!changes.length) {
    console.log("Semua kode sudah sesuai format. Tidak ada yang diubah.");
    return;
  }
  let group = "";
  for (const c of changes) {
    if (c.group !== group) console.log(`\n== ${(group = c.group)} ==`);
    console.log(`  ${c.from.padEnd(28)} -> ${c.to.padEnd(14)} ${c.name}`);
  }
  console.log(`\nTotal ${changes.length} kode.`);
  console.log(apply ? "SELESAI: kode sudah disimpan." : "Ini baru RENCANA (belum disimpan). Jalankan: npm run rapikan:kode -- --jalankan");
}

main()
  .catch((e) => {
    console.error("GAGAL:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
