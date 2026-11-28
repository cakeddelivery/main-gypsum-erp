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

export async function planLpgReklas(db: Db): Promise<ReklasRow[]> {
  const word = (f: string) => [{ [f]: { contains: "lpg", mode: "insensitive" as const } }, { [f]: { contains: "elpiji", mode: "insensitive" as const } }];
  const txs = await db.financeTransaction.findMany({
    where: { direction: "KELUAR", status: "DIBUKUKAN", deletedAt: null, origin: null, journalId: { not: null }, OR: [...word("note"), ...word("rawText"), ...word("counterparty"), { splits: { some: { OR: word("note") } } }] },
    include: { splits: true }, orderBy: { date: "asc" },
  });
  if (!txs.length) return [];
  const done = new Set((await db.journal.findMany({ where: { source: REKLAS_SOURCE, sourceId: { in: txs.map((t) => t.id) }, reversalOfId: null }, select: { id: true, sourceId: true } })).map((j) => j.sourceId!));
  const lines = await db.journalLine.findMany({ where: { journalId: { in: txs.map((t) => t.journalId!) }, debit: { gt: 0 }, account: { type: "BEBAN" } }, select: { journalId: true, debit: true, account: { select: { code: true, name: true } } } });
  const out: ReklasRow[] = [];
  for (const t of txs) {
    if (done.has(t.id)) continue;
    const total = Number(t.amount);
    const teks = [t.note, t.rawText, t.counterparty].filter(Boolean).join(" · ");
    let amount = 0;
    if (t.splits.length) amount = t.splits.filter((x) => lpgShare(x.note, Number(x.amount)).mode !== "tidak-lpg").reduce((a, x) => a + Number(x.amount), 0);
    else { const sh = lpgShare(teks, total); amount = sh.mode === "penuh" || sh.mode === "baris" ? sh.amount : 0; }
    if (!(amount > 0)) continue;
    const dl = lines.filter((l) => l.journalId === t.journalId && l.account.code !== COA.BEBAN_LPG_PRODUKSI).sort((a, b) => Number(b.debit) - Number(a.debit))[0];
    if (!dl) continue; // bukan beban (mis. persediaan: dikoreksi lewat koreksi:rekonsiliasi-persediaan) atau sudah di 6-1310
    out.push({ txId: t.id, number: t.number, date: t.date, amount: Math.min(amount, Number(dl.debit)), akun: dl.account.code, akunNama: dl.account.name, teks });
  }
  return out;
}

export async function lpgReklas(db: PrismaClient, apply: boolean) {
  const rows = await planLpgReklas(db);
  const target = await db.coaAccount.findUnique({ where: { code: COA.BEBAN_LPG_PRODUKSI }, select: { id: true } });
  if (!apply || !rows.length || !target) return { rows, journals: 0, gagal: [] as string[], akunAda: !!target };
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
  return { rows, journals, gagal, akunAda: true };
}
