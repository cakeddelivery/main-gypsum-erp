import type { Prisma, PrismaClient } from "@prisma/client";
import { COA, defaultStoreId, postJournal } from "./accounting";
import { INVENTORY_COA, inventoryValuation, usageAccountCode } from "./stock";

/**
 * Rekonsiliasi persediaan: saldo buku besar 1-1401/1-1402/1-1403 vs nilai stok (Σ qty × avgCost per tipe barang).
 * Penyebab selisih yang dikenali (per baris, dengan usulan koreksi):
 *  - FINANCE_TANPA_STOK: transaksi Finance yang mendebit akun persediaan tetapi stok masuknya (PENERIMAAN, ref nomor transaksi) kurang/tidak ada
 *    (mis. kategori yang berakun Persediaan Bahan Baku tanpa rincian barang).
 *  - PENERIMAAN_TANPA_JURNAL: PENERIMAAN stok bernilai yang refnya tidak punya dokumen berjurnal (pembelian / transaksi Finance / jurnal bersumber ref itu).
 *  - SISA: selisih akun yang belum terjelaskan dua kelompok di atas (stok minus, harga rata-rata, dll.).
 * Koreksi = jurnal penyesuaian REKON_PERSEDIAAN (tidak ada transaksi yang dihapus); tiap baris bermemo `REKON:<kelompok>:<ref>` sehingga
 * penerapan ulang idempoten.
 */
type Db = PrismaClient | Prisma.TransactionClient;
export const REKON_SOURCE = "REKON_PERSEDIAAN";
export const TOLERANSI = 1000; // Rp, pembulatan
const ACCOUNTS = [COA.PERSEDIAAN_BAHAN, COA.PERSEDIAAN_BDP, COA.PERSEDIAAN_JADI] as const;
const TYPE_OF: Record<string, "BAHAN_BAKU" | "BARANG_DALAM_PROSES" | "BARANG_JADI"> = { [COA.PERSEDIAAN_BAHAN]: "BAHAN_BAKU", [COA.PERSEDIAAN_BDP]: "BARANG_DALAM_PROSES", [COA.PERSEDIAAN_JADI]: "BARANG_JADI" };

export type Kelompok = "FINANCE_TANPA_STOK" | "PENERIMAAN_TANPA_JURNAL";
export type RekonRow = { kelompok: Kelompok; account: string; ref: string; date: Date | null; gap: number; detail: string; usul: string };
export type RekonAccount = { code: string; name: string; gl: number; stock: number; diff: number; terjelaskan: number; sisa: number };
export type RekonResult = { accounts: RekonAccount[]; rows: RekonRow[] };

const memoOf = (k: Kelompok | "SISA", ref: string) => `REKON:${k}:${ref}`;

/** Yang sudah dikoreksi sebelumnya per memo (debit − kredit baris akun persediaan pada jurnal REKON_PERSEDIAAN) */
async function adjustedByMemo(db: Db, accId: Map<string, string>) {
  const lines = await db.journalLine.findMany({ where: { accountId: { in: [...accId.values()] }, memo: { startsWith: "REKON:" }, journal: { source: REKON_SOURCE } }, select: { accountId: true, memo: true, debit: true, credit: true } });
  const codeOf = new Map([...accId].map(([c, id]) => [id, c]));
  const m = new Map<string, number>();
  for (const l of lines) {
    const k = `${codeOf.get(l.accountId)}|${l.memo}`;
    m.set(k, (m.get(k) ?? 0) + Number(l.debit) - Number(l.credit));
  }
  return m;
}

export async function rekonPersediaan(db: Db): Promise<RekonResult> {
  const accs = await db.coaAccount.findMany({ where: { code: { in: [...ACCOUNTS] } }, select: { id: true, code: true, name: true } });
  const accId = new Map(accs.map((a) => [a.code, a.id]));
  const codeOfId = new Map(accs.map((a) => [a.id, a.code]));
  const grp = await db.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: accs.map((a) => a.id) } }, _sum: { debit: true, credit: true } });
  const gl = new Map(grp.map((g) => [codeOfId.get(g.accountId)!, Number(g._sum.debit ?? 0) - Number(g._sum.credit ?? 0)]));
  const val = await inventoryValuation(db as never);
  const adjusted = await adjustedByMemo(db, accId);
  const rows: RekonRow[] = [];

  // --- FINANCE_TANPA_STOK ---
  const fin = await db.financeTransaction.findMany({ where: { origin: null, journalId: { not: null } }, select: { id: true, number: true, date: true, note: true, counterparty: true, categoryId: true } });
  const finById = new Map(fin.map((t) => [t.id, t]));
  const js = await db.journal.findMany({ where: { source: "FINANCE", sourceId: { in: fin.map((t) => t.id) } }, select: { id: true, sourceId: true } });
  const revs = js.length ? await db.journal.findMany({ where: { reversalOfId: { in: js.map((j) => j.id) } }, select: { id: true, reversalOfId: true } }) : [];
  const docOfJournal = new Map<string, string>([...js.map((j) => [j.id, j.sourceId!] as const), ...revs.map((r) => [r.id, js.find((j) => j.id === r.reversalOfId)!.sourceId!] as const)]);
  const jl = docOfJournal.size ? await db.journalLine.findMany({ where: { journalId: { in: [...docOfJournal.keys()] }, accountId: { in: accs.map((a) => a.id) } }, select: { journalId: true, accountId: true, debit: true, credit: true } }) : [];
  const glByTx = new Map<string, number>(); // `${txId}|${account}`
  for (const l of jl) {
    const k = `${docOfJournal.get(l.journalId)}|${codeOfId.get(l.accountId)}`;
    glByTx.set(k, (glByTx.get(k) ?? 0) + Number(l.debit) - Number(l.credit));
  }
  const numbers = fin.filter((t) => [...glByTx.keys()].some((k) => k.startsWith(`${t.id}|`))).map((t) => t.number);
  const mv = numbers.length
    ? await db.stockMovement.findMany({ where: { OR: [{ ref: { in: numbers } }, { ref: { in: numbers.map((n) => `BATAL ${n}`) } }] }, select: { ref: true, type: true, qty: true, unitCost: true, item: { select: { type: true } } } })
    : [];
  const mvByTx = new Map<string, number>(); // `${number}|${account}`
  for (const m of mv) {
    const num = m.ref!.replace(/^BATAL /, "");
    const sign = m.type === "PENERIMAAN" ? 1 : m.type === "PENGELUARAN" && m.ref!.startsWith("BATAL ") ? -1 : 0;
    if (!sign) continue;
    const code = INVENTORY_COA[m.item.type];
    const k = `${num}|${code}`;
    mvByTx.set(k, (mvByTx.get(k) ?? 0) + sign * Math.round(Number(m.qty) * Number(m.unitCost)));
  }
  const cats = await db.txCategory.findMany({ where: { id: { in: fin.map((t) => t.categoryId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  for (const [k, g] of glByTx) {
    const [txId, code] = k.split("|");
    const t = finById.get(txId)!;
    const ref = t.number;
    // adjusted = debit − kredit koreksi sebelumnya pada akun persediaan (kredit = negatif): menambahkannya mengurangi selisih yang tersisa
    const gap = g - (mvByTx.get(`${ref}|${code}`) ?? 0) + (adjusted.get(`${code}|${memoOf("FINANCE_TANPA_STOK", ref)}`) ?? 0);
    if (Math.abs(gap) <= TOLERANSI) continue;
    const kat = t.categoryId ? catName.get(t.categoryId) : null;
    rows.push({ kelompok: "FINANCE_TANPA_STOK", account: code, ref, date: t.date, gap, detail: `${t.note ?? t.counterparty ?? "(tanpa catatan)"}${kat ? ` · kategori ${kat}` : ""}`, usul: gap > 0 ? "buat penerimaan stok (Barang masuk/Pembelian dengan barang & qty) ATAU reklas ke beban pemakaian bahan" : "periksa: stok masuk lebih besar dari jurnal transaksi" });
  }

  // --- PENERIMAAN_TANPA_JURNAL ---
  const rec = await db.stockMovement.findMany({ where: { type: "PENERIMAAN", ref: { not: null }, unitCost: { gt: 0 } }, select: { ref: true, qty: true, unitCost: true, item: { select: { type: true } }, date: true } });
  const refs = [...new Set(rec.map((r) => r.ref!))];
  const known = new Set<string>();
  if (refs.length) {
    for (const j of await db.journal.findMany({ where: { sourceId: { in: refs } }, select: { sourceId: true } })) known.add(j.sourceId!);
    for (const p of await db.purchase.findMany({ where: { number: { in: refs } }, select: { number: true } })) known.add(p.number);
    for (const t of await db.financeTransaction.findMany({ where: { number: { in: refs }, journalId: { not: null } }, select: { number: true } })) known.add(t.number);
  }
  const noJ = new Map<string, { code: string; value: number; date: Date }>();
  for (const r of rec) {
    if (known.has(r.ref!)) continue;
    const code = INVENTORY_COA[r.item.type];
    const k = `${code}|${r.ref}`;
    const cur = noJ.get(k) ?? { code, value: 0, date: r.date };
    cur.value += Math.round(Number(r.qty) * Number(r.unitCost));
    noJ.set(k, cur);
  }
  for (const [k, v] of noJ) {
    const ref = k.slice(k.indexOf("|") + 1);
    const gap = -(v.value) + (adjusted.get(`${v.code}|${memoOf("PENERIMAAN_TANPA_JURNAL", ref)}`) ?? 0);
    if (Math.abs(gap) <= TOLERANSI) continue;
    rows.push({ kelompok: "PENERIMAAN_TANPA_JURNAL", account: v.code, ref, date: v.date, gap, detail: `penerimaan stok bernilai Rp${v.value.toLocaleString("id-ID")} tanpa dokumen berjurnal`, usul: "catat jurnalnya (Dr persediaan / Cr saldo awal atau selisih) bila memang aset yang sah" });
  }

  const accounts: RekonAccount[] = accs
    .map((a) => {
      const g = gl.get(a.code) ?? 0;
      const s = val.byType[TYPE_OF[a.code]];
      const terjelaskan = rows.filter((r) => r.account === a.code).reduce((x, r) => x + r.gap, 0);
      return { code: a.code, name: a.name, gl: g, stock: s, diff: g - s, terjelaskan, sisa: g - s - terjelaskan };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  return { accounts, rows: rows.sort((a, b) => a.account.localeCompare(b.account) || a.kelompok.localeCompare(b.kelompok) || (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0)) };
}

export type Keputusan = {
  /** Transaksi Finance debit persediaan tanpa stok: beban pemakaian bahan, atau selisih persediaan; kosong = belum diputuskan (tidak dikoreksi) */
  financeTanpaStok?: "beban-pemakaian" | "selisih";
  /** Penerimaan stok tanpa jurnal: lawan Ekuitas saldo awal atau Beban Selisih Persediaan; kosong = tidak dikoreksi */
  penerimaanTanpaJurnal?: "saldo-awal" | "selisih";
  /** Sisa selisih akun yang belum terjelaskan → Beban Selisih Persediaan (6-1800) */
  sisa?: "selisih";
};

export type RencanaKoreksi = { lines: { account: string; counter: string; amount: number; memo: string; kelompok: string; ref: string }[]; belumDiputuskan: Kelompok[]; result: RekonResult };

/** Baris jurnal penyesuaian: amount > 0 = kurangi persediaan (Cr persediaan / Dr lawan); amount < 0 = tambah persediaan */
export async function rencanaKoreksi(db: Db, k: Keputusan): Promise<RencanaKoreksi> {
  const result = await rekonPersediaan(db);
  const usage = await usageAccountCode(db as never);
  const counterOf = (g: Kelompok): string | null =>
    g === "FINANCE_TANPA_STOK" ? (k.financeTanpaStok === "beban-pemakaian" ? usage : k.financeTanpaStok === "selisih" ? COA.BEBAN_SELISIH_PERSEDIAAN : null)
      : k.penerimaanTanpaJurnal === "saldo-awal" ? COA.EKUITAS_SALDO_AWAL : k.penerimaanTanpaJurnal === "selisih" ? COA.BEBAN_SELISIH_PERSEDIAAN : null;
  const lines: RencanaKoreksi["lines"] = [];
  const belum = new Set<Kelompok>();
  for (const r of result.rows) {
    const counter = counterOf(r.kelompok);
    if (!counter) { belum.add(r.kelompok); continue; }
    lines.push({ account: r.account, counter, amount: r.gap, memo: memoOf(r.kelompok, r.ref), kelompok: r.kelompok, ref: r.ref });
  }
  if (k.sisa === "selisih") for (const a of result.accounts) {
    // Sisa dihitung dengan kelompok yang BELUM diputuskan tetap dianggap terjelaskan (tidak ikut dikoreksi sebagai sisa)
    if (Math.abs(a.sisa) > TOLERANSI) lines.push({ account: a.code, counter: COA.BEBAN_SELISIH_PERSEDIAAN, amount: a.sisa, memo: memoOf("SISA" as never, a.code), kelompok: "SISA", ref: a.code });
  }
  return { lines, belumDiputuskan: [...belum], result };
}

export async function koreksiRekonPersediaan(db: PrismaClient, apply: boolean, k: Keputusan) {
  const plan = await rencanaKoreksi(db, k);
  if (!apply || !plan.lines.length) return { plan, journalId: null as string | null };
  const journalId = await db.$transaction(async (tx) => {
    const fresh = await rencanaKoreksi(tx, k);
    if (!fresh.lines.length) return null;
    const date = new Date();
    const j = await postJournal(tx, {
      date, storeId: await defaultStoreId(tx), description: `Rekonsiliasi persediaan: penyesuaian buku besar ke nilai stok (${fresh.lines.length} baris)`, source: REKON_SOURCE, sourceId: date.toISOString(), actor: { id: "system", name: "skrip koreksi:rekonsiliasi-persediaan" },
      lines: fresh.lines.flatMap((l) =>
        l.amount > 0
          ? [{ accountCode: l.account, credit: Math.round(l.amount), memo: l.memo }, { accountCode: l.counter, debit: Math.round(l.amount), memo: l.memo }]
          : [{ accountCode: l.account, debit: Math.round(-l.amount), memo: l.memo }, { accountCode: l.counter, credit: Math.round(-l.amount), memo: l.memo }]),
    });
    await tx.auditLog.create({ data: { actorName: "skrip koreksi:rekonsiliasi-persediaan", action: "REKON_PERSEDIAAN", entity: "Journal", entityId: j.id, data: { keputusan: k, baris: fresh.lines.map((l) => ({ kelompok: l.kelompok, ref: l.ref, akun: l.account, lawan: l.counter, jumlah: l.amount })) } as unknown as Prisma.InputJsonValue } });
    return j.id;
  }, { isolationLevel: "Serializable", timeout: 120000 });
  return { plan, journalId };
}
