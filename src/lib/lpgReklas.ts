import type { Prisma, PrismaClient } from "@prisma/client";
import { COA, defaultStoreId, postJournal } from "./accounting";
import { lpgShare } from "./lpgText";

/**
 * LPG oven = Biaya Overhead Pabrik (6-1310), bukan beban umum (6-1300 Listrik, Air & Gas). Transaksi lama berdeskripsi LPG yang sudah
 * terposting ke akun beban lain DITAMPILKAN (cek:rekonsiliasi-persediaan, hitung:biaya-oven) dan boleh direklas lewat jurnal
 * Dr 6-1310 / Cr akun lama (satu jurnal per transaksi, bertanggal transaksi, memo `LPG-REKLAS:<nomor>`). Transaksi tidak diubah.
 */
type Db = PrismaClient | Prisma.TransactionClient;
export const REKLAS_SOURCE = "REKLAS_LPG";

export type ReklasRow = { txId: string; number: string; date: Date; amount: number; akun: string; akunNama: string; teks: string };

export type ReklasManual = { txId: string; number: string; teks: string; alasan: string };
export type ReklasPlan = { rows: ReklasRow[]; manual: ReklasManual[] };

/**
 * Rencana reklas LPG per transaksi. Hanya nominal LPG yang dipindah:
 *  - nominal LPG dari teks (bagian LPG-nya saja; tidak terbaca → "perlu cek manual", bukan ditebak)
 *  - dikurangi LPG yang sudah ada di leg persediaan jurnal itu (itu urusan cek:rekonsiliasi-persediaan, bukan reklas beban)
 *  - leg beban sumber ≥ nominal; bila ada beberapa leg beban, dipakai yang nilainya persis sama, kalau tidak ada → cek manual
 */
export async function planLpgReklasFull(db: Db, opt: { hargaTabung?: number } = {}): Promise<ReklasPlan> {
  const word = (f: string) => [{ [f]: { contains: "lpg", mode: "insensitive" as const } }, { [f]: { contains: "elpiji", mode: "insensitive" as const } }];
  const txs = await db.financeTransaction.findMany({
    where: { direction: "KELUAR", status: "DIBUKUKAN", deletedAt: null, origin: null, journalId: { not: null }, OR: [...word("note"), ...word("rawText"), ...word("counterparty"), { splits: { some: { OR: word("note") } } }] },
    include: { splits: true }, orderBy: { date: "asc" },
  });
  if (!txs.length) return { rows: [], manual: [] };
  const done = new Set((await db.journal.findMany({ where: { source: REKLAS_SOURCE, sourceId: { in: txs.map((t) => t.id) }, reversalOfId: null }, select: { id: true, sourceId: true } })).map((j) => j.sourceId!));
  const lines = await db.journalLine.findMany({ where: { journalId: { in: txs.map((t) => t.journalId!) }, debit: { gt: 0 } }, select: { journalId: true, debit: true, account: { select: { code: true, name: true, type: true } } } });
  const rows: ReklasRow[] = [];
  const manual: ReklasManual[] = [];
  for (const t of txs) {
    if (done.has(t.id)) continue;
    const total = Number(t.amount);
    const teks = [t.note, t.rawText, t.counterparty].filter(Boolean).join(" · ");
    let amount = 0;
    let unclear = false;
    if (t.splits.length) {
      // rincian barang (itemId) masuk persediaan, bukan beban; hanya rincian beban bernada LPG
      for (const x of t.splits.filter((x) => !x.itemId)) {
        const sh = lpgShare(x.note, Number(x.amount), opt);
        if (sh.mode === "penuh" || sh.mode === "baris") amount += sh.mode === "penuh" ? Number(x.amount) : sh.amount;
        else if (sh.mode === "tidak-terparse") unclear = true;
      }
    } else {
      const sh = lpgShare(teks, total, opt);
      if (sh.mode === "penuh" || sh.mode === "baris") amount = sh.amount;
      else if (sh.mode === "tidak-terparse") unclear = true;
    }
    const legs = lines.filter((l) => l.journalId === t.journalId);
    if (unclear && !(amount > 0)) { manual.push({ txId: t.id, number: t.number, teks, alasan: "ada baris LPG tetapi nominalnya tidak terbaca dari teks" }); continue; }
    if (!(amount > 0)) continue;
    const exp = legs.filter((l) => l.account.type === "BEBAN" && l.account.code !== COA.BEBAN_LPG_PRODUKSI);
    // 1) Leg beban yang nilainya PERSIS sama dengan nominal LPG: itu leg LPG-nya. Bila ada beberapa, akun gas (6-1300 Listrik, Air & Gas) didahulukan
    const exact = exp.filter((l) => Number(l.debit) === amount);
    let leg: (typeof legs)[number] | null = null;
    let remaining = amount;
    const invTotal = legs.filter((l) => l.account.type === "ASET" && l.account.code.startsWith("1-14")).reduce((a, l) => a + Number(l.debit), 0);
    if (exact.length && invTotal >= amount) {
      // LPG sama besar dengan leg beban DAN leg persediaan: tidak bisa dipastikan mana LPG-nya
      manual.push({ txId: t.id, number: t.number, teks, alasan: `LPG Rp${amount.toLocaleString("id-ID")} cocok dengan leg beban (${exact.map((l) => l.account.code).join(", ")}) sekaligus leg persediaan Rp${invTotal.toLocaleString("id-ID")}` });
      continue;
    }
    if (exact.length) {
      const gas = exact.filter((l) => l.account.code === "6-1300");
      leg = gas.length === 1 ? gas[0] : exact.length === 1 ? exact[0] : null;
      if (!leg) { manual.push({ txId: t.id, number: t.number, teks, alasan: `LPG Rp${amount.toLocaleString("id-ID")} cocok dengan ${exact.length} leg beban (${exact.map((l) => l.account.code).join(", ")}), akun gas (6-1300) tidak tunggal` }); continue; }
    } else {
      // 2) Tidak ada leg beban yang persis: LPG yang sudah ada di leg persediaan (1-14xx) tidak direklas dari beban (urusan cek:rekonsiliasi-persediaan)
      const inv = legs.filter((l) => l.account.type === "ASET" && l.account.code.startsWith("1-14")).reduce((a, l) => a + Number(l.debit), 0);
      remaining = amount - Math.min(amount, inv);
      if (!(remaining > 0)) continue;
      if (!exp.length) continue; // sudah di 6-1310 atau bukan beban
      leg = exp.length === 1 ? exp[0] : null;
      if (!leg) { manual.push({ txId: t.id, number: t.number, teks, alasan: `LPG Rp${remaining.toLocaleString("id-ID")} tetapi ada ${exp.length} leg beban (${exp.map((l) => `${l.account.code} Rp${Number(l.debit).toLocaleString("id-ID")}`).join(", ")}) dan tidak ada yang persis sama` }); continue; }
    }
    if (Number(leg.debit) < remaining) { manual.push({ txId: t.id, number: t.number, teks, alasan: `leg beban ${leg.account.code} Rp${Number(leg.debit).toLocaleString("id-ID")} lebih kecil dari LPG Rp${remaining.toLocaleString("id-ID")}` }); continue; }
    rows.push({ txId: t.id, number: t.number, date: t.date, amount: remaining, akun: leg.account.code, akunNama: leg.account.name, teks });
  }
  return { rows, manual };
}

export async function planLpgReklas(db: Db): Promise<ReklasRow[]> {
  return (await planLpgReklasFull(db)).rows;
}

export async function lpgReklas(db: PrismaClient, apply: boolean, opt: { hargaTabung?: number } = {}) {
  const { rows, manual } = await planLpgReklasFull(db, opt);
  const target = await db.coaAccount.findUnique({ where: { code: COA.BEBAN_LPG_PRODUKSI }, select: { id: true } });
  if (!apply || !rows.length || !target) return { rows, manual, journals: 0, gagal: [] as string[], akunAda: !!target };
  const gagal: string[] = [];
  let journals = 0;
  for (const r of rows) {
    try {
      await db.$transaction(async (tx) => {
        if (await tx.journal.findFirst({ where: { source: REKLAS_SOURCE, sourceId: r.txId, reversalOfId: null } })) return; // idempoten
        const j = await postJournal(tx, {
          date: r.date, storeId: await defaultStoreId(tx), description: `Reklas LPG oven ke BOP: ${r.number} (${r.akun} → ${COA.BEBAN_LPG_PRODUKSI})`, source: REKLAS_SOURCE, sourceId: r.txId, actor: { id: "system", name: "skrip koreksi:lpg-reklas" },
          lines: [{ accountCode: COA.BEBAN_LPG_PRODUKSI, debit: r.amount, memo: `LPG-REKLAS:${r.number}` }, { accountCode: r.akun, credit: r.amount, memo: `LPG-REKLAS:${r.number}` }],
        });
        await tx.auditLog.create({ data: { actorName: "skrip koreksi:lpg-reklas", action: "REKLAS_LPG", entity: "FinanceTransaction", entityId: r.txId, data: { number: r.number, dari: r.akun, ke: COA.BEBAN_LPG_PRODUKSI, jumlah: r.amount, journalId: j.id } as unknown as Prisma.InputJsonValue } });
        journals++;
      }, { isolationLevel: "Serializable", timeout: 30000 });
    } catch (e) {
      gagal.push(`${r.number}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { rows, manual, journals, gagal, akunAda: true };
}
