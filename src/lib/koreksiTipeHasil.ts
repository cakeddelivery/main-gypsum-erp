import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { postJournal } from "./accounting";
import { INVENTORY_COA, locationSettings, recordMovement, stockBalances } from "./stock";

type Actor = { id: string; name: string };

/**
 * Hasil Cat Plastik & Cat Giftbox adalah barang SETENGAH JADI (BARANG_DALAM_PROSES). Setup borongan lama membuat item hasil Cat Plastik
 * (merah/biru/kuning) sebagai BAHAN_BAKU; item itu lalu salah masuk "perlu diorder" dan tidak ikut hitungan stok akhir hasil / limit
 * "perlu diproduksi". Koreksi tipe:
 *  - item hasil tugas "Cat plastik …" / "Cat giftbox" bertipe lain → BARANG_DALAM_PROSES (kategori Barang Setengah Jadi, divisi = divisi tugas bila kosong);
 *  - stok yang ada di gudang bahan baku dipindah ke gudang setengah jadi (TRANSFER, jumlah total tidak berubah; stok di titik/driver tidak disentuh);
 *  - akun persediaan ikut dipindah: jurnal reklasifikasi Dr Persediaan Barang Dalam Proses / Cr Persediaan Bahan (nilai = jumlah total × harga pokok).
 */
export const HASIL_CAT = /^cat\s*(plastik|giftbox)/i;

export type TipeRow = {
  /** TIPE = ganti tipe jadi setengah jadi; DIVISI = pindahkan ke divisi yang benar; POT = Pot cat giftbox dilepas dari divisi (hanya stok titik BMR) */
  aksi: ("TIPE" | "DIVISI" | "POT")[];
  targetDivisionId?: string | null; itemId: string; sku: string; name: string; fromType: string; task: string; division: string | null; itemDivision: string | null; qtyRaw: number; qtyTotal: number; value: number; setDivision: boolean };

export const POT_CAT = /^pot\s*cat\s*giftbox/i;

export async function planTipeHasil(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<TipeRow[]> {
  const tasks = await db.pieceTask.findMany({ where: { outputItemId: { not: null } }, include: { outputItem: true, division: true } });
  const giftbox = await db.division.findFirst({ where: { reportTemplate: "GIFTBOX" } });
  const hasil = [...new Map(tasks.filter((t) => HASIL_CAT.test(t.name) && t.outputItem).map((t) => [t.outputItem!.id, t])).values()];
  const pots = await db.item.findMany({ where: { name: { contains: "pot cat giftbox", mode: "insensitive" }, divisionId: { not: null }, active: true } });
  const { raw } = await locationSettings(db as typeof prisma);
  const bal = await stockBalances(db as typeof prisma);
  const names = new Map((await db.division.findMany({ select: { id: true, name: true } })).map((d) => [d.id, d.name]));
  const rows: TipeRow[] = [];
  for (const t of hasil) {
    const it = t.outputItem!;
    const aksi: TipeRow["aksi"] = [];
    if (it.type !== "BARANG_DALAM_PROSES") aksi.push("TIPE");
    // Cat Giftbox = barang setengah jadi milik divisi Giftbox
    const target = /^cat\s*giftbox/i.test(t.name) && giftbox ? giftbox.id : null;
    if (target && it.divisionId !== target) aksi.push("DIVISI");
    if (!aksi.length) continue;
    const mine = bal.filter((b) => b.itemId === it.id);
    const total = mine.reduce((a, b) => a + b.qty, 0);
    rows.push({
      aksi, targetDivisionId: target, itemId: it.id, sku: it.sku, name: it.name, fromType: it.type, task: t.name, division: t.division?.name ?? null, itemDivision: it.divisionId ? names.get(it.divisionId) ?? null : null,
      qtyRaw: Math.max(0, Math.round((mine.find((b) => b.locationId === raw)?.qty ?? 0) * 1000) / 1000), qtyTotal: Math.round(total * 1000) / 1000,
      value: aksi.includes("TIPE") ? Math.round(Math.max(0, total) * Number(it.avgCost)) : 0, setDivision: !it.divisionId && !!t.divisionId,
    });
  }
  // Pot cat giftbox: bahan baku yang hanya ada di stok titik koordinator BMR; tidak boleh muncul di stok akhir / daftar order divisi mana pun
  for (const it of pots) {
    if (rows.some((r) => r.itemId === it.id)) continue;
    rows.push({ aksi: ["POT"], targetDivisionId: null, itemId: it.id, sku: it.sku, name: it.name, fromType: it.type, task: "(bahan Cat Giftbox)", division: null, itemDivision: it.divisionId ? names.get(it.divisionId) ?? null : null, qtyRaw: 0, qtyTotal: 0, value: 0, setDivision: false });
  }
  return rows;
}

/** Terapkan koreksi (satu transaksi Serializable). Aman diulang: yang sudah setengah jadi tidak diproses lagi */
export async function applyTipeHasil(actor: Actor, opts: { jurnal?: boolean } = {}) {
  const withJournal = opts.jurnal !== false;
  return prisma.$transaction(async (tx) => {
    const rows = await planTipeHasil(tx);
    if (!rows.length) return { items: 0, moved: 0, journals: 0, rows };
    const { raw, wip } = await locationSettings(tx as unknown as typeof prisma);
    if (!wip) throw new Error("Lokasi gudang setengah jadi belum diatur di Pengaturan");
    const cat = await tx.itemCategory.findFirst({ where: { type: "BARANG_DALAM_PROSES", active: true }, orderBy: { sortOrder: "asc" } });
    let moved = 0;
    let journals = 0;
    for (const r of rows) {
      if (r.aksi.length === 1 && r.aksi[0] === "POT") {
        await tx.item.update({ where: { id: r.itemId }, data: { divisionId: null } });
        continue;
      }
      const task = await tx.pieceTask.findFirst({ where: { outputItemId: r.itemId, divisionId: { not: null } }, select: { divisionId: true } });
      if (!r.aksi.includes("TIPE")) {
        if (r.targetDivisionId) await tx.item.update({ where: { id: r.itemId }, data: { divisionId: r.targetDivisionId } });
        continue;
      }
      if (r.qtyRaw > 0.0005 && raw && raw !== wip) {
        await recordMovement(tx, { type: "TRANSFER", itemId: r.itemId, qty: r.qtyRaw, fromLocationId: raw, toLocationId: wip, ref: "KOREKSI-TIPE-HASIL", note: "Koreksi tipe: hasil Cat jadi barang setengah jadi (pindah gudang)", date: new Date() }, actor);
        moved++;
      }
      await tx.item.update({ where: { id: r.itemId }, data: { type: "BARANG_DALAM_PROSES", ...(cat ? { category: cat.name } : {}), ...(r.targetDivisionId ? { divisionId: r.targetDivisionId } : r.setDivision && task?.divisionId ? { divisionId: task.divisionId } : {}) } });
      if (withJournal && r.value > 0 && r.aksi.includes("TIPE")) {
        await postJournal(tx, {
          date: new Date(), description: `Reklasifikasi persediaan ${r.name}: ${r.fromType === "BAHAN_BAKU" ? "bahan baku" : "barang jadi"} → barang setengah jadi`, source: "KOREKSI_TIPE_HASIL", sourceId: r.itemId, actor,
          lines: [{ accountCode: INVENTORY_COA.BARANG_DALAM_PROSES, debit: r.value }, { accountCode: INVENTORY_COA[r.fromType as keyof typeof INVENTORY_COA], credit: r.value }],
        });
        journals++;
      }
    }
    await audit(actor, "KOREKSI_TIPE_HASIL_CAT", "Item", null, { barang: rows.map((r) => ({ sku: r.sku, aksi: r.aksi, dari: r.fromType, nilai: r.value })), pindahGudang: moved, jurnal: journals }, tx);
    return { items: rows.length, moved, journals, rows };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
}
