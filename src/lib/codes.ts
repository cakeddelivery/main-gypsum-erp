import type { AccountType, Prisma } from "@prisma/client";
import type { prisma } from "./db";
import { jakartaParts } from "./time";

/**
 * Kode otomatis untuk semua master data (permintaan owner 03/11/2026).
 * Awalan kode menunjukkan kelompok datanya, nomor urut dari tabel Counter (aman dipakai bersamaan).
 * Kode yang sudah dipakai (mis. diisi manual dulu) dilewati.
 *
 *   Karyawan        CTK-001      awalan = kode divisi
 *   Divisi          CTK          singkatan nama ("Divisi Cetak")
 *   Toko            MG           inisial nama ("Main Gypsum")
 *   Shift           S3           nomor shift
 *   Rekening        SEABANK      nama rekening (dipakai bot keuangan)
 *   Akun COA        6-2000       digit awal = tipe akun (1 aset … 6 beban)
 *   Lokasi stok     GBB          inisial nama ("Gudang Bahan Baku")
 *   Tugas borongan  BRG-001
 *   Periode gaji    GJ-20261103  tanggal mulai
 *   Supplier        SUP-001
 *   Pelanggan       PLG-001
 *   Item / produk   BU-001, MG-001 (per kategori, lihat itemCatalog)
 *   Bahan divisi    BB-PRD-001   bahan baku laporan shift per divisi
 */

type Tx = Prisma.TransactionClient | typeof prisma;

/** Naikkan penghitung `key` dan kembalikan nilai barunya */
async function bump(tx: Tx, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Counter"("key","value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "Counter"."value" + 1
    RETURNING "value"`;
  return Number(rows[0].value);
}

/** Kode berurutan PREFIX-001; melewati kode yang sudah terpakai */
export async function nextSequence(tx: Tx, prefix: string, taken: (code: string) => Promise<boolean>, opts: { pad?: number; sep?: string; key?: string } = {}) {
  const { pad = 3, sep = "-", key = `KODE-${prefix}` } = opts;
  for (;;) {
    const code = `${prefix}${sep}${String(await bump(tx, key)).padStart(pad, "0")}`;
    if (!(await taken(code))) return code;
  }
}

/** Kode singkatan; bila sudah terpakai diberi angka di belakang (CTK, CTK2, CTK3 …) */
async function uniqueCode(base: string, taken: (code: string) => Promise<boolean>, sep = "") {
  if (!(await taken(base))) return base;
  for (let i = 2; ; i++) if (!(await taken(`${base}${sep}${i}`))) return `${base}${sep}${i}`;
}

const NOISE = new Set(["DIVISI", "DAN", "THE", "&"]);

/**
 * Singkatan huruf besar dari nama:
 *  - 1 kata: huruf pertama + konsonan berikutnya (Cetak → CTK, Produksi → PRD, Packing → PCK)
 *  - >1 kata: inisial tiap kata (Gudang Bahan Baku → GBB), ditambah konsonan kata pertama bila kurang (Filling Cat → FLC)
 */
export function abbreviate(name: string, len = 3): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !NOISE.has(w));
  if (!words.length) return "X";
  const squeeze = (w: string) => (w[0] + w.slice(1).replace(/[AIUEO]/g, "")).replace(/(.)\1+/g, "$1");
  if (words.length === 1) {
    const w = words[0];
    let s = squeeze(w);
    if (s.length < len) s += w.slice(1).replace(/[^AIUEO]/g, "");
    return s.slice(0, Math.max(len, 2));
  }
  let s = words.map((w) => w[0]).join("").slice(0, Math.max(len, 4));
  if (s.length < len) s = s[0] + squeeze(words[0]).slice(1, 1 + len - s.length) + s.slice(1);
  return s;
}

const COA_DIGIT: Record<AccountType, string> = { ASET: "1", KEWAJIBAN: "2", EKUITAS: "3", PENDAPATAN: "4", HPP: "5", BEBAN: "6" };

export const autoCode = {
  /** Karyawan: kode divisi + nomor urut (CTK-001) */
  async employee(tx: Tx, divisionId: string) {
    const d = await tx.division.findUniqueOrThrow({ where: { id: divisionId }, select: { code: true } });
    return nextSequence(tx, d.code, async (code) => !!(await tx.employee.findUnique({ where: { code } })), { key: `KODE-KRY-${d.code}` });
  },

  async division(tx: Tx, name: string) {
    return uniqueCode(abbreviate(name, 3), async (code) => !!(await tx.division.findUnique({ where: { code } })));
  },

  async store(tx: Tx, name: string) {
    return uniqueCode(abbreviate(name, 2), async (code) => !!(await tx.store.findUnique({ where: { code } })));
  },

  async shift(tx: Tx) {
    for (let n = (await tx.shift.count()) + 1; ; n++) if (!(await tx.shift.findUnique({ where: { code: `S${n}` } }))) return `S${n}`;
  },

  /** Rekening: nama huruf besar tanpa spasi (SEABANK, SHOPEEPAY), sama seperti kode yang dipakai bot keuangan */
  async bank(tx: Tx, name: string) {
    const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "REK";
    return uniqueCode(base, async (code) => !!(await tx.bankAccount.findUnique({ where: { code } })));
  },

  /** Akun COA: digit tipe + kelompok ratusan berikutnya (6-1900 → 6-2000); x-9xxx dibiarkan untuk akun "lain-lain" */
  async coa(tx: Tx, type: AccountType) {
    const d = COA_DIGIT[type];
    const rows = await tx.coaAccount.findMany({ where: { code: { startsWith: `${d}-` } }, select: { code: true } });
    const used = new Set(rows.map((r) => r.code));
    const nums = rows.map((r) => Number(r.code.slice(2))).filter((n) => Number.isInteger(n) && n < 9000);
    const max = nums.length ? Math.max(...nums) : 0;
    const fmt = (n: number) => `${d}-${String(n).padStart(4, "0")}`;
    for (let n = (Math.floor(max / 100) + 1) * 100; n < 9000; n += 100) if (!used.has(fmt(n))) return fmt(n);
    for (let n = max + 1; n < 10000; n++) if (!used.has(fmt(n))) return fmt(n);
    throw new Error(`Kode akun tipe ${type} sudah penuh`);
  },

  async location(tx: Tx, name: string) {
    return uniqueCode(abbreviate(name, 3), async (code) => !!(await tx.location.findUnique({ where: { code } })));
  },

  async pieceTask(tx: Tx) {
    return nextSequence(tx, "BRG", async (code) => !!(await tx.pieceTask.findUnique({ where: { code } })));
  },

  /** Periode upah harian: GJ-tanggal mulai (GJ-20261027) */
  async payrollPeriod(tx: Tx, start: Date) {
    const p = jakartaParts(start);
    const base = `GJ-${p.year}${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}`;
    return uniqueCode(base, async (code) => !!(await tx.payrollPeriod.findUnique({ where: { code } })), "-");
  },

  /** Bahan baku per divisi (laporan shift): BB-kode divisi-nomor (BB-PRD-001) */
  async divisionMaterial(tx: Tx, divisionCode: string) {
    return nextSequence(tx, `BB-${divisionCode}`, async (sku) => !!(await tx.item.findUnique({ where: { sku } })));
  },

  async supplier(tx: Tx) {
    return nextSequence(tx, "SUP", async (code) => !!(await tx.supplier.findUnique({ where: { code } })));
  },

  async customer(tx: Tx) {
    return nextSequence(tx, "PLG", async (code) => !!(await tx.customer.findUnique({ where: { code } })));
  },
};
