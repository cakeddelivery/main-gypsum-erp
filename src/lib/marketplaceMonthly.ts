import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { AccountingError, COA, postJournal, reverseJournal, reversalDate } from "./accounting";
import { monthRange } from "./time";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

/**
 * Biaya marketplace bulanan (keputusan Owner 13 Nov 2026).
 * Withdraw dari Saldo Penjual dicatat sebagai Penjualan sebesar uang yang ditarik (neto). Potongan marketplace
 * (biaya admin, layanan/ongkir program, komisi, dll.) tidak pernah lewat rekening, jadi tidak tercatat.
 * Sebulan sekali angka biaya dari "Laporan Penghasilan" Seller Center dicatat per saldo penjual & toko:
 *   Dr Beban Admin & Layanan Platform (6-1500) / Cr Penjualan (4-1000)
 * Laba tidak berubah; Penjualan menjadi omzet kotor dan biaya marketplace terlihat sebagai beban.
 * Satu catatan per (saldo penjual, toko, bulan); menyimpan ulang = jurnal lama dibalik lalu dibukukan baru.
 */
export const MP_SOURCE = "MARKETPLACE_BULANAN";
const FEE_COA = "6-1500";
const settingKey = (sourceId: string) => `mp_bulanan:${sourceId}`;

export const MP_FEE_FIELDS = [
  { key: "admin", label: "Biaya administrasi / komisi platform" },
  { key: "service", label: "Biaya layanan (gratis ongkir, cashback, program)" },
  { key: "affiliate", label: "Komisi affiliate" },
  { key: "other", label: "Biaya lain (proses pesanan, dll.)" },
] as const;
export type MpFees = Record<(typeof MP_FEE_FIELDS)[number]["key"], number>;

export type MpInput = { year: number; month: number; bankId: string; storeId: string; fees: MpFees; gross?: number | null; note?: string | null };
export type MpSaved = { fees: MpFees; total: number; gross: number | null; note: string | null; journalId: string; by: string; at: string };

export const mpSourceId = (bankId: string, storeId: string, year: number, month: number) => `${bankId}:${storeId}:${year}-${String(month).padStart(2, "0")}`;

export function mpTotal(fees: MpFees) {
  const vals = MP_FEE_FIELDS.map((f) => fees[f.key] ?? 0);
  if (vals.some((v) => !Number.isInteger(v) || v < 0)) throw new AccountingError("Biaya harus angka rupiah, tidak boleh minus");
  return vals.reduce((s, v) => s + v, 0);
}

/** Jurnal aktif (belum dibalik) untuk satu catatan */
async function activeJournal(tx: Tx | typeof prisma, sourceId: string) {
  const rows = await tx.journal.findMany({ where: { source: MP_SOURCE, sourceId, reversalOfId: null }, orderBy: { createdAt: "desc" } });
  for (const j of rows) if (!(await tx.journal.findFirst({ where: { reversalOfId: j.id } }))) return j;
  return null;
}

/**
 * Simpan biaya marketplace satu bulan. Bertanggal hari terakhir bulan itu 23.59 WIB bila periodenya masih terbuka;
 * bila sudah tutup buku, dibukukan hari ini (laba bulan yang sudah ditutup tidak berubah).
 */
export async function saveMarketplaceMonth(input: MpInput, actor: Actor, now: Date = new Date()) {
  const total = mpTotal(input.fees);
  if (input.gross != null && (!Number.isInteger(input.gross) || input.gross < 0)) throw new AccountingError("Omzet kotor tidak valid");
  if (input.gross != null && input.gross > 0 && total > input.gross) throw new AccountingError("Total biaya melebihi omzet kotor");
  const { end } = monthRange(input.year, input.month);
  if (monthRange(input.year, input.month).start > now) throw new AccountingError("Bulan ini belum berjalan");
  const sourceId = mpSourceId(input.bankId, input.storeId, input.year, input.month);
  return prisma.$transaction(async (tx) => {
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankId } });
    if (!bank.marketplace) throw new AccountingError(`${bank.name} bukan saldo penjual marketplace`);
    const store = await tx.store.findUniqueOrThrow({ where: { id: input.storeId } });
    // Kunci per catatan: dua simpan bersamaan tidak boleh membukukan dua jurnal aktif
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceId}))`;
    const old = await activeJournal(tx, sourceId);
    if (old) await reverseJournal(tx, old.id, await reversalDate(tx, old.date, now), actor, `ubah biaya marketplace ${bank.name} ${store.code}`);
    const label = `${bank.name} ${store.code} ${String(input.month).padStart(2, "0")}/${input.year}`;
    let journalId = "";
    if (total > 0) {
      const date = await reversalDate(tx, new Date(end.getTime() - 60_000), now);
      const j = await postJournal(tx, {
        date, storeId: store.id, description: `Biaya marketplace ${label}${input.gross ? ` (omzet kotor Rp ${input.gross.toLocaleString("id-ID")})` : ""}`, source: MP_SOURCE, sourceId, actor,
        lines: [
          ...MP_FEE_FIELDS.filter((f) => input.fees[f.key] > 0).map((f) => ({ accountCode: FEE_COA, debit: input.fees[f.key], memo: `${f.label} · ${label}`.slice(0, 120) })),
          { accountCode: COA.PENJUALAN, credit: total, memo: `Potongan marketplace ${label} (omzet kotor)`.slice(0, 120) },
        ],
      });
      journalId = j.id;
    }
    const saved: MpSaved = { fees: input.fees, total, gross: input.gross ?? null, note: input.note?.trim() || null, journalId, by: actor.name, at: now.toISOString() };
    await tx.setting.upsert({ where: { key: settingKey(sourceId) }, create: { key: settingKey(sourceId), value: JSON.stringify(saved) }, update: { value: JSON.stringify(saved) } });
    await audit(actor, "BIAYA_MARKETPLACE_BULANAN", "Journal", journalId || null, { sourceId, total, gross: input.gross ?? null, replaced: old?.number ?? null }, tx);
    return { total, journalId, replaced: old?.number ?? null };
  });
}

/**
 * Ringkasan per saldo penjual × toko untuk satu bulan: penjualan dari withdraw (neto), biaya yang dicatat,
 * omzet kotor tercatat (neto + biaya), omzet kotor menurut marketplace (bila diisi), dan % biaya.
 */
export async function marketplaceMonthSummary(year: number, month: number) {
  const { start, end } = monthRange(year, month);
  const [banks, stores] = await Promise.all([
    prisma.bankAccount.findMany({ where: { marketplace: true }, orderBy: { code: "asc" } }),
    prisma.store.findMany({ orderBy: { code: "asc" } }),
  ]);
  const rows = [];
  for (const b of banks) {
    // Pemasukan penjualan dari withdraw: baris debit saldo penjual bermemo "(withdraw)", dikurangi pembaliknya
    const lines = await prisma.journalLine.findMany({
      where: { accountId: b.coaAccountId, memo: { endsWith: "(withdraw)" }, journal: { date: { gte: start, lt: end } } },
      select: { debit: true, credit: true, journal: { select: { storeId: true } } },
    });
    for (const s of stores) {
      const net = lines.filter((l) => l.journal.storeId === s.id).reduce((t, l) => t + Number(l.debit) - Number(l.credit), 0);
      const sourceId = mpSourceId(b.id, s.id, year, month);
      const raw = (await prisma.setting.findUnique({ where: { key: settingKey(sourceId) } }))?.value;
      const saved = raw ? (JSON.parse(raw) as MpSaved) : null;
      const fees = saved && (await activeJournal(prisma, sourceId)) ? saved.total : saved && saved.total === 0 ? 0 : null;
      if (!net && !saved) continue;
      const grossBook = net + (fees ?? 0);
      rows.push({
        bank: { id: b.id, name: b.name }, store: { id: s.id, code: s.code, name: s.name }, net, fees, saved, grossBook,
        grossMarket: saved?.gross ?? null, feePct: saved?.gross ? Math.round(((fees ?? 0) / saved.gross) * 1000) / 10 : grossBook > 0 && fees ? Math.round((fees / grossBook) * 1000) / 10 : null,
      });
    }
  }
  return { rows, banks, stores };
}
