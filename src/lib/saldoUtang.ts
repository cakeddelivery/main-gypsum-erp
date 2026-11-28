import type { Prisma, PrismaClient } from "@prisma/client";
import { COA, defaultStoreId, postJournal } from "./accounting";
import { nextNumber } from "./numbering";
import { createLoanRecord } from "./payables";
import { REKON_SOURCE } from "./rekonPersediaan";

/**
 * Saldo utang per pihak dari data konfirmasi user (CSV di luar repo: `pihak,jenis(supplier|modal),sisa,tanggal`; alias pihak dipisah `|`).
 * HANYA tampilan + usulan; koreksi hanya dengan flag eksplisit per pihak. Tidak ada data nyata di kode/tes.
 *  - supplier: saldo sistem = Σ sisa UTG yang cocok nama; pembayaran Finance yang cocok nama (sebelum/sesudah tanggal UTG, bertaut/tidak, akun debitnya)
 *    → saldo sistem setelah koreksi utang-awal (pembayaran ≥ tanggal UTG yang mendebit persediaan mengurangi UTG) → selisih terhadap target.
 *  - modal: pinjaman (Payable PINJAMAN) cocok nama + transaksi Finance yang menyebut pihak itu.
 */
type Db = PrismaClient | Prisma.TransactionClient;
const INV = [COA.PERSEDIAAN_BAHAN, COA.PERSEDIAAN_BDP, COA.PERSEDIAAN_JADI] as string[];
const TOL = 500;

export type CsvRow = { pihak: string; aliases: string[]; jenis: "supplier" | "modal"; sisa: number; tanggal: string };

export function parseUtangCsv(text: string): CsvRow[] {
  const out: CsvRow[] = [];
  for (const raw of text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
    const c = raw.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    if (c.length < 3 || /^pihak$/i.test(c[0])) continue; // baris judul
    const jenis = c[1].toLowerCase();
    if (jenis !== "supplier" && jenis !== "modal") throw new Error(`Jenis harus supplier|modal: "${raw.slice(0, 40)}"`);
    const sisa = Number(c[2].replace(/[^0-9]/g, ""));
    if (!Number.isFinite(sisa) || sisa < 0) throw new Error(`Sisa tidak valid: "${raw.slice(0, 40)}"`);
    const aliases = c[0].split("|").map((x) => x.trim()).filter(Boolean);
    out.push({ pihak: aliases[0] ?? c[0], aliases, jenis, sisa, tanggal: (c[3] ?? "").slice(0, 10) });
  }
  return out;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
/** Alias cocok bila semua kata alias (≥3 huruf) ada di teks */
export const namaCocok = (teks: string, aliases: string[]) => {
  const tw = new Set(words(teks));
  return aliases.some((a) => { const aw = words(a); return aw.length > 0 && aw.every((w) => tw.has(w)); });
};

export type PembayaranRow = { txNumber: string; txId: string; date: Date; nominal: number; teks: string; bertaut: string | null; debit: { akun: string; nominal: number }[]; sebelumUtg: boolean };
export type UtgRow = { number: string; id: string; date: Date; amount: number; paid: number; sisa: number; vendor: string };
export type Usulan = { jenis: "RECLAS_BAYAR" | "UTANG_LAMA" | "SALDO_AWAL_MODAL" | "KONFIRMASI"; amount: number; keterangan: string; txNumber?: string; akunCr?: string; txId?: string };
export type PihakAnalisa = {
  row: CsvRow; utg: UtgRow[]; pembayaran: PembayaranRow[]; modal: UtgRow[]; saldoSistem: number; efekKoreksiAwal: number; saldoSetelahKoreksi: number; selisih: number; usulan: Usulan[];
  transaksiModal: { txNumber: string; date: Date; arah: string; nominal: number; teks: string }[];
};

export async function analisaSaldoUtang(db: Db, rows: CsvRow[]): Promise<PihakAnalisa[]> {
  const payables = await db.payable.findMany({ include: { supplier: { select: { name: true, aliases: true } } }, orderBy: { date: "asc" } });
  const txs = await db.financeTransaction.findMany({ where: { status: "DIBUKUKAN", deletedAt: null, origin: null }, select: { id: true, number: true, date: true, amount: true, direction: true, note: true, rawText: true, counterparty: true, payableId: true, journalId: true } });
  const jl = txs.length ? await db.journalLine.findMany({ where: { journalId: { in: txs.map((t) => t.journalId).filter((x): x is string => !!x) }, debit: { gt: 0 } }, select: { journalId: true, debit: true, account: { select: { code: true } } } }) : [];
  const payNum = new Map(payables.map((p) => [p.id, p.number]));
  const out: PihakAnalisa[] = [];
  for (const row of rows) {
    const mine = payables.filter((p) => namaCocok([p.vendor, p.supplier?.name, ...(p.supplier?.aliases ?? [])].filter(Boolean).join(" "), row.aliases) || row.aliases.some((a) => namaCocok(p.vendor, [a])));
    const toUtg = (p: (typeof payables)[number]): UtgRow => ({ number: p.number, id: p.id, date: p.date, amount: Number(p.amount), paid: Number(p.paid), sisa: Number(p.amount) - Number(p.paid), vendor: p.vendor });
    const utg = mine.filter((p) => p.kind === "USAHA").map(toUtg);
    const modal = mine.filter((p) => p.kind === "PINJAMAN").map(toUtg);
    const own = row.jenis === "supplier" ? utg : modal;
    const saldoSistem = own.reduce((a, u) => a + u.sisa, 0);
    const firstUtg = utg.length ? Math.min(...utg.map((u) => u.date.getTime())) : null;
    const matched = txs.filter((t) => namaCocok([t.note, t.rawText, t.counterparty].filter(Boolean).join(" "), row.aliases));
    const pembayaran: PembayaranRow[] = row.jenis === "supplier" ? matched.filter((t) => t.direction === "KELUAR").map((t) => ({
      txNumber: t.number, txId: t.id, date: t.date, nominal: Number(t.amount), teks: [t.note, t.rawText, t.counterparty].filter(Boolean).join(" · "), bertaut: t.payableId ? payNum.get(t.payableId) ?? "?" : null,
      debit: jl.filter((l) => l.journalId === t.journalId).map((l) => ({ akun: l.account.code, nominal: Number(l.debit) })), sebelumUtg: firstUtg != null && t.date.getTime() < firstUtg,
    })) : [];
    // Efek koreksi utang-awal (--angsuran=ya): pembayaran tak bertaut, mendebit persediaan, pada/sesudah tanggal UTG pertama → mengurangi sisa UTG
    const efek = pembayaran.filter((p) => !p.bertaut && !p.sebelumUtg && firstUtg != null).reduce((a, p) => a + p.debit.filter((d) => INV.includes(d.akun)).reduce((x, d) => x + d.nominal, 0), 0);
    const efekKoreksiAwal = Math.min(efek, saldoSistem);
    const saldoSetelahKoreksi = saldoSistem - efekKoreksiAwal;
    const selisih = saldoSetelahKoreksi - row.sisa;
    const usulan: Usulan[] = [];
    if (row.jenis === "supplier") {
      if (selisih > TOL) {
        let left = selisih;
        for (const p of pembayaran.filter((x) => !x.bertaut && !x.sebelumUtg && firstUtg != null)) {
          for (const d of p.debit.filter((x) => !INV.includes(x.akun) && x.akun !== COA.UTANG_USAHA && x.akun.startsWith("6-"))) {
            if (left <= TOL) break;
            const a = Math.min(left, d.nominal);
            usulan.push({ jenis: "RECLAS_BAYAR", amount: a, txNumber: p.txNumber, txId: p.txId, akunCr: d.akun, keterangan: `reklas pembayaran ${p.txNumber}: Dr 2-1100 / Cr ${d.akun} (dibukukan sebagai beban)` });
            left -= a;
          }
        }
        if (left > TOL) usulan.push({ jenis: "KONFIRMASI", amount: left, keterangan: "perlu konfirmasi: pembayaran tak tercatat? (sistem masih lebih besar dari target)" });
      } else if (selisih < -TOL) {
        usulan.push({ jenis: "UTANG_LAMA", amount: -selisih, keterangan: "sistem lebih kecil dari target: catat pembelian kredit lewat Pembelian (tempo) dengan barang & qty, ATAU bila utang lama → Dr 3-9000 Saldo Awal Ekuitas / Cr 2-1100 (--utang-lama)" });
      }
    } else {
      if (selisih < -TOL) usulan.push({ jenis: "SALDO_AWAL_MODAL", amount: -selisih, keterangan: "saldo awal pinjaman: Dr 3-9000 / Cr akun pinjaman (--saldo-awal-modal). Pencairan SETELAH ERP: Dr kas/persediaan / Cr pinjaman — catat lewat Pinjaman bila ada buktinya" });
      else if (selisih > TOL) usulan.push({ jenis: "KONFIRMASI", amount: selisih, keterangan: "perlu konfirmasi: cicilan/pelunasan tak tercatat? (sistem lebih besar dari target)" });
    }
    const transaksiModal = row.jenis === "modal" ? matched.map((t) => ({ txNumber: t.number, date: t.date, arah: t.direction, nominal: Number(t.amount), teks: [t.note, t.rawText, t.counterparty].filter(Boolean).join(" · ") })) : [];
    out.push({ row, utg, pembayaran, modal, saldoSistem, efekKoreksiAwal, saldoSetelahKoreksi, selisih, usulan, transaksiModal });
  }
  return out;
}

export type OpsiSaldoUtang = { pihak: string; utangLama?: boolean; reklasBayar?: boolean; saldoAwalModal?: boolean };

/** Koreksi per pihak (HARUS menyebut pihak, tiap jenis koreksi dengan flag sendiri). Idempoten: sourceId + selisih dihitung ulang. */
export async function koreksiSaldoUtang(db: PrismaClient, rows: CsvRow[], apply: boolean, opsi: OpsiSaldoUtang) {
  const target = rows.filter((r) => r.aliases.some((a) => a.toLowerCase() === opsi.pihak.toLowerCase()));
  if (!target.length) throw new Error(`Pihak "${opsi.pihak}" tidak ada di file`);
  const [a] = await analisaSaldoUtang(db, target);
  const actor = { id: "system", name: "skrip koreksi:saldo-utang" };
  const done: string[] = [];
  const rencana: { kode: string; keterangan: string; amount: number }[] = [];
  if (opsi.reklasBayar) for (const u of a.usulan.filter((x) => x.jenis === "RECLAS_BAYAR")) rencana.push({ kode: `SALDO-UTANG-REKLAS:${u.txNumber}`, keterangan: u.keterangan, amount: u.amount });
  if (opsi.utangLama) for (const u of a.usulan.filter((x) => x.jenis === "UTANG_LAMA")) rencana.push({ kode: `SALDO-UTANG-LAMA:${a.row.pihak}`, keterangan: `Utang lama ${a.row.pihak}: Dr 3-9000 / Cr 2-1100 + UTG`, amount: u.amount });
  if (opsi.saldoAwalModal) for (const u of a.usulan.filter((x) => x.jenis === "SALDO_AWAL_MODAL")) rencana.push({ kode: `SALDO-AWAL-MODAL:${a.row.pihak}`, keterangan: `Saldo awal pinjaman ${a.row.pihak}: Dr 3-9000 / Cr pinjaman`, amount: u.amount });
  if (!apply) return { analisa: a, rencana, done };
  for (const r of rencana) {
    await db.$transaction(async (tx) => {
      if (await tx.journal.findFirst({ where: { sourceId: r.kode, reversalOfId: null, source: { in: [REKON_SOURCE, "SALDO_AWAL", "UTANG"] } } })) return;
      const date = new Date();
      if (r.kode.startsWith("SALDO-UTANG-REKLAS:")) {
        const u = a.usulan.find((x) => `SALDO-UTANG-REKLAS:${x.txNumber}` === r.kode)!;
        const j = await postJournal(tx, { date, storeId: await defaultStoreId(tx), description: r.keterangan.slice(0, 150), source: REKON_SOURCE, sourceId: r.kode, actor, lines: [{ accountCode: COA.UTANG_USAHA, debit: r.amount, memo: `REKON:${r.kode}` }, { accountCode: u.akunCr!, credit: r.amount, memo: `REKON:${r.kode}` }] });
        const utg = a.utg[0];
        if (utg) {
          const room = utg.amount - utg.paid;
          await tx.payable.update({ where: { id: utg.id }, data: { paid: { increment: BigInt(Math.max(0, Math.min(room, r.amount))) } } });
          await tx.financeTransaction.update({ where: { id: u.txId! }, data: { payableId: utg.id } });
        }
        await tx.auditLog.create({ data: { actorName: actor.name, action: "SALDO_UTANG_REKLAS", entity: "Journal", entityId: j.id, data: { kode: r.kode, jumlah: r.amount } as unknown as Prisma.InputJsonValue } });
      } else if (r.kode.startsWith("SALDO-UTANG-LAMA:")) {
        const storeId = await defaultStoreId(tx);
        const j = await postJournal(tx, { date, storeId, description: r.keterangan.slice(0, 150), source: "SALDO_AWAL", sourceId: r.kode, actor, lines: [{ accountCode: COA.EKUITAS_SALDO_AWAL, debit: r.amount }, { accountCode: COA.UTANG_USAHA, credit: r.amount }] });
        const sup = await tx.supplier.findFirst({ where: { name: { equals: a.row.pihak, mode: "insensitive" } }, select: { id: true } });
        await tx.payable.create({ data: { number: await nextNumber(tx, "UTG", date), vendor: a.row.pihak, supplierId: sup?.id ?? null, storeId, date, amount: BigInt(r.amount), note: "Utang lama (saldo awal)", journalId: j.id } });
        await tx.auditLog.create({ data: { actorName: actor.name, action: "SALDO_UTANG_LAMA", entity: "Journal", entityId: j.id, data: { kode: r.kode, jumlah: r.amount } as unknown as Prisma.InputJsonValue } });
      } else {
        // Pinjaman lama lewat fungsi yang sudah ada (Dr Ekuitas Saldo Awal / Cr Hutang pinjaman + catatan Payable PINJAMAN)
        // Idempoten lewat selisih: sesudah dicatat, saldo sistem = target sehingga usulan hilang
        await createLoanRecord({ lender: a.row.pihak, amount: r.amount, date, note: "Saldo awal (konfirmasi user)", paidBefore: 0 }, actor, tx);
      }
      done.push(r.kode);
    }, { isolationLevel: "Serializable", timeout: 30000 });
  }
  return { analisa: a, rencana, done };
}
