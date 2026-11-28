import type { Prisma, PrismaClient } from "@prisma/client";
import { COA, defaultStoreId, postJournal } from "./accounting";
import { REKON_SOURCE } from "./rekonPersediaan";
import { namaCocok } from "./saldoUtang";

/**
 * UTANG supplier yang dicatat Dr persediaan / Cr Hutang Usaha tanpa stok masuk (jurnal utang awal dari data lama).
 * Dugaan: saldo utang awal sebelum ERP, barangnya sudah masuk stok awal (CUTOVER) sehingga persediaan terhitung dua kali. DI BALIK FLAG, pratinjau dulu:
 *  - utangAwal "ekuitas": per jurnal utang Dr 3-9000 Saldo Awal Ekuitas / Cr akun persediaan (memo REKON:UTANG-AWAL:<UTG>)
 *  - angsuran "ya": Finance (cicilan/angsuran/pelunasan) ke supplier yang punya UTG, yang mendebit persediaan: Dr 2-1100 / Cr persediaan (memo REKON:UTANG-ANGSURAN:<TRX>)
 *    dan menandai pembayaran di UTG (paid bertambah, Finance ditautkan ke UTG)
 *  - Finance serupa tanpa UTG = "utang tanpa catatan": hanya ditampilkan (menunggu data dari user)
 * Tidak ada yang berubah tanpa apply=true; idempoten lewat memo/sourceId.
 */
type Db = PrismaClient | Prisma.TransactionClient;
const INV = [COA.PERSEDIAAN_BAHAN, COA.PERSEDIAAN_BDP, COA.PERSEDIAAN_JADI] as string[];
const PAY_WORDS = /cicil|angsur|pelunasan|lunas|bayar\s+(?:hutang|utang)|(?:hutang|utang)/i;

export type UtangRow = { number: string; vendor: string; supplier: string | null; amount: number; paid: number; journalId: string; journalNumber: string; date: Date; akun: string; nominalPersediaan: number; sudahDikoreksi: boolean };
export type AngsuranRow = { txId: string; txNumber: string; date: Date; teks: string; akun: string; nominal: number; utg: string; payableId: string; /** Pembayaran bertanggal SEBELUM UTG dibuat: UTG sudah saldo bersih → melunasi utang lama (Dr Ekuitas Saldo Awal), TIDAK mengurangi UTG */ sebelumUtg: boolean; sudahDikoreksi: boolean };
export type TanpaCatatan = { txNumber: string; date: Date; teks: string; nominal: number };
export type UtangAwalPlan = { utang: UtangRow[]; angsuran: AngsuranRow[]; tanpaCatatan: TanpaCatatan[]; totalUtang: number };

export async function planUtangAwal(db: Db): Promise<UtangAwalPlan> {
  const payables = await db.payable.findMany({ where: { kind: "USAHA", journalId: { not: null } }, include: { supplier: { select: { name: true, aliases: true } } }, orderBy: { number: "asc" } });
  const journals = await db.journal.findMany({ where: { id: { in: payables.map((p) => p.journalId!) } }, select: { id: true, number: true, date: true, lines: { select: { debit: true, account: { select: { code: true } } } } } });
  const done = new Set((await db.journal.findMany({ where: { source: REKON_SOURCE, sourceId: { startsWith: "UTANG-AWAL:" }, reversalOfId: null }, select: { sourceId: true } })).map((j) => j.sourceId!));
  const utang: UtangRow[] = [];
  for (const p of payables) {
    const j = journals.find((x) => x.id === p.journalId);
    const inv = j?.lines.filter((l) => INV.includes(l.account.code) && Number(l.debit) > 0) ?? [];
    if (!j || !inv.length) continue; // hutang yang bukan Dr persediaan tidak dibahas
    const nominal = inv.reduce((a, l) => a + Number(l.debit), 0);
    utang.push({ number: p.number, vendor: p.vendor, supplier: p.supplier?.name ?? null, amount: Number(p.amount), paid: Number(p.paid), journalId: j.id, journalNumber: j.number, date: j.date, akun: inv[0].account.code, nominalPersediaan: nominal, sudahDikoreksi: done.has(`UTANG-AWAL:${p.number}`) });
  }
  // Finance bertema cicilan/pelunasan yang mendebit persediaan
  const txs = await db.financeTransaction.findMany({ where: { direction: "KELUAR", status: "DIBUKUKAN", deletedAt: null, origin: null, journalId: { not: null }, payableId: null }, select: { id: true, number: true, date: true, amount: true, note: true, rawText: true, counterparty: true, journalId: true } });
  const cand = txs.filter((t) => PAY_WORDS.test([t.note, t.rawText, t.counterparty].filter(Boolean).join(" ")));
  const lines = cand.length ? await db.journalLine.findMany({ where: { journalId: { in: cand.map((t) => t.journalId!) }, debit: { gt: 0 }, account: { code: { in: INV } } }, select: { journalId: true, debit: true, account: { select: { code: true } } } }) : [];
  const doneAng = new Set((await db.journal.findMany({ where: { source: REKON_SOURCE, sourceId: { startsWith: "UTANG-ANGSURAN:" }, reversalOfId: null }, select: { sourceId: true } })).map((j) => j.sourceId!));
  const angsuran: AngsuranRow[] = [];
  const tanpaCatatan: TanpaCatatan[] = [];
  for (const t of cand) {
    const l = lines.filter((x) => x.journalId === t.journalId);
    if (!l.length) continue;
    const teks = [t.note, t.rawText, t.counterparty].filter(Boolean).join(" · ");
    // Cocok bila SEMUA kata salah satu nama (vendor "A / B" dipecah per bagian, atau alias supplier) ada di teks (bukan sekadar satu kata umum)
    const match = payables.find((p) => [p.vendor, p.supplier?.name, ...(p.supplier?.aliases ?? [])].filter((x): x is string => !!x).flatMap((n) => n.split(/[\/|,]/)).some((n) => namaCocok(teks, [n])));
    const nominal = l.reduce((a, x) => a + Number(x.debit), 0);
    if (match) angsuran.push({ txId: t.id, txNumber: t.number, date: t.date, teks, akun: l[0].account.code, nominal, utg: match.number, payableId: match.id, sebelumUtg: t.date.getTime() < match.date.getTime(), sudahDikoreksi: doneAng.has(`UTANG-ANGSURAN:${t.number}`) || doneAng.has(`UTANG-ANGSURAN-AWAL:${t.number}`) });
    else tanpaCatatan.push({ txNumber: t.number, date: t.date, teks, nominal });
  }
  return { utang, angsuran, tanpaCatatan, totalUtang: utang.reduce((a, u) => a + u.nominalPersediaan, 0) };
}

export type UtangAwalOpsi = { utangAwal?: "ekuitas"; angsuran?: "ya" };
export type UtangAwalLine = { sourceId: string; memo: string; akunDr: string; akunCr: string; amount: number; keterangan: string };

export async function koreksiUtangAwal(db: PrismaClient, apply: boolean, opsi: UtangAwalOpsi) {
  const plan = await planUtangAwal(db);
  const lines: UtangAwalLine[] = [];
  if (opsi.utangAwal === "ekuitas") for (const u of plan.utang.filter((x) => !x.sudahDikoreksi)) lines.push({ sourceId: `UTANG-AWAL:${u.number}`, memo: `REKON:UTANG-AWAL:${u.number}`, akunDr: COA.EKUITAS_SALDO_AWAL, akunCr: u.akun, amount: u.nominalPersediaan, keterangan: `Saldo utang awal ${u.number} ${u.vendor} (${u.journalNumber}): persediaan sudah ada di stok awal` });
  if (opsi.angsuran === "ya") for (const a of plan.angsuran.filter((x) => !x.sudahDikoreksi)) {
    // Sebelum UTG dibuat: melunasi utang lama yang belum ada di sistem → Ekuitas Saldo Awal (UTG tidak dikurangi). Sesudah UTG: bayar UTG (Dr hutang)
    if (a.sebelumUtg) lines.push({ sourceId: `UTANG-ANGSURAN-AWAL:${a.txNumber}`, memo: `REKON:UTANG-ANGSURAN-AWAL:${a.txNumber}`, akunDr: COA.EKUITAS_SALDO_AWAL, akunCr: a.akun, amount: a.nominal, keterangan: `Pelunasan utang lama ${a.txNumber} (sebelum ${a.utg}): Dr saldo awal ekuitas, bukan persediaan` });
    else lines.push({ sourceId: `UTANG-ANGSURAN:${a.txNumber}`, memo: `REKON:UTANG-ANGSURAN:${a.txNumber}`, akunDr: COA.UTANG_USAHA, akunCr: a.akun, amount: a.nominal, keterangan: `Angsuran utang ${a.utg} dibukukan ${a.txNumber}: Dr hutang, bukan persediaan` });
  }
  if (!apply || !lines.length) return { plan, lines, journals: 0 };
  let journals = 0;
  for (const l of lines) {
    await db.$transaction(async (tx) => {
      if (await tx.journal.findFirst({ where: { source: REKON_SOURCE, sourceId: l.sourceId, reversalOfId: null } })) return;
      const date = new Date();
      const j = await postJournal(tx, { date, storeId: await defaultStoreId(tx), description: l.keterangan.slice(0, 150), source: REKON_SOURCE, sourceId: l.sourceId, actor: { id: "system", name: "skrip koreksi:utang-awal" }, lines: [{ accountCode: l.akunDr, debit: l.amount, memo: l.memo }, { accountCode: l.akunCr, credit: l.amount, memo: l.memo }] });
      if (l.sourceId.startsWith("UTANG-ANGSURAN:")) {
        const a = plan.angsuran.find((x) => `UTANG-ANGSURAN:${x.txNumber}` === l.sourceId)!;
        const p = await tx.payable.findUniqueOrThrow({ where: { id: a.payableId } });
        const room = Number(p.amount) - Number(p.paid);
        await tx.payable.update({ where: { id: p.id }, data: { paid: { increment: BigInt(Math.max(0, Math.min(room, a.nominal))) } } });
        await tx.financeTransaction.update({ where: { id: a.txId }, data: { payableId: p.id } });
      }
      await tx.auditLog.create({ data: { actorName: "skrip koreksi:utang-awal", action: "KOREKSI_UTANG_AWAL", entity: "Journal", entityId: j.id, data: { sourceId: l.sourceId, dr: l.akunDr, cr: l.akunCr, jumlah: l.amount } as unknown as Prisma.InputJsonValue } });
      journals++;
    }, { isolationLevel: "Serializable", timeout: 30000 });
  }
  return { plan, lines, journals };
}
