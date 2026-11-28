import type { Prisma, PrismaClient } from "@prisma/client";
import { COA, defaultStoreId, postJournal } from "./accounting";
import { INVENTORY_COA, inventoryValuation, usageAccountCode } from "./stock";
import { lpgShare } from "./lpgText";

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
export type RekonRow = { kelompok: Kelompok; account: string; ref: string; date: Date | null; gap: number; detail: string; usul: string; /** Bagian selisih yang berupa pembelian LPG (dari deskripsi) → beban LPG, bukan beban pemakaian bahan */ lpgPart?: number; lpgNote?: string };
export type RekonAccount = { code: string; name: string; gl: number; stock: number; diff: number; terjelaskan: number; sisa: number };
export type RekonResult = { accounts: RekonAccount[]; rows: RekonRow[]; lpgAccount: { code: string; name: string } | null };

/** Akun beban LPG: akun kategori transaksi bernama LPG/gas, atau akun BEBAN bernama LPG; null bila belum ada */
export async function lpgExpenseAccount(db: Db): Promise<{ code: string; name: string } | null> {
  // 6-1310 Beban LPG Produksi (Oven) — BOP didahulukan; kategori/akun bernama LPG lain hanya cadangan
  const bop = await db.coaAccount.findUnique({ where: { code: COA.BEBAN_LPG_PRODUKSI }, select: { code: true, name: true, active: true } });
  if (bop?.active) return { code: bop.code, name: bop.name };
  const cat = await db.txCategory.findFirst({ where: { name: { contains: "lpg", mode: "insensitive" }, direction: "KELUAR" }, include: { coaAccount: true } });
  if (cat && cat.coaAccount.type === "BEBAN") return { code: cat.coaAccount.code, name: cat.coaAccount.name };
  const acc = await db.coaAccount.findFirst({ where: { type: "BEBAN", active: true, OR: [{ name: { contains: "lpg", mode: "insensitive" } }, { name: { contains: "elpiji", mode: "insensitive" } }] }, orderBy: { code: "asc" } });
  return acc ? { code: acc.code, name: acc.name } : null;
}

/** Jenis referensi stok dari ref mutasi: "BATAL KRM:x" → KRM; "LPH:abc:1" → LPH; tanpa ref → "(tanpa ref)" */
export const refGroup = (ref: string | null | undefined) => (ref ? /^[A-Za-z]+/.exec(ref.replace(/^BATAL[ -]/i, ""))?.[0]?.toUpperCase() ?? "(lain)" : "(tanpa ref)");
/** Sumber jurnal → grup yang setara dengan awalan ref mutasi stok (agar selisih per grup bermakna) */
const JOURNAL_GROUP: Record<string, string> = { LAPORAN_SHIFT: "LPH", REKON_PERSEDIAAN: "REKON", REVALUASI_HPP: "REVALUASI", PRODUKSI: "PRD", PEMBELIAN: "PBL", FINANCE: "TRX", STOK_AWAL: "STOK_AWAL", PENJUALAN: "JUAL", BORONGAN: "BORONGAN(jurnal)" };
/** Awalan ref mutasi → grup gabungan (stok awal dibukukan satu jurnal STOK_AWAL; mutasinya ber-ref CUTOVER / AWAL) */
const MOVEMENT_ALIAS: Record<string, string> = { CUTOVER: "STOK_AWAL", AWAL: "STOK_AWAL" };

export type DiagRow = { account: string; group: string; mutasi: number; jurnal: number; selisih: number };
export type Diagnosa = { rows: DiagRow[]; /** Σ nilai mutasi stok − nilai stok (Σ qty × harga rata-rata sekarang): pergeseran harga rata-rata, dll. */ nilaiStokVsMutasi: Record<string, number>; /** Bagian terbukti 1-1401 terlalu tinggi & 1-1403 terlalu rendah pada jenis referensi yang sama */ antar: { total: number; sudah: number; sisa: number; perGrup: { group: string; amount: number }[] } };

/**
 * Diagnosis sisa per jenis referensi stok untuk tiap akun persediaan: nilai mutasi stok (qty × harga mutasi, masuk +, keluar −, transfer 0)
 * vs nilai jurnal pada akun itu. Jurnal dikelompokkan ke jenis referensi lewat mutasi yang terhubung (StockMovement.journalId) atau sumber jurnalnya.
 * Selisih = jurnal − mutasi: positif = buku besar lebih tinggi dari stok untuk jenis referensi itu.
 */
export async function diagnosaSisa(db: Db): Promise<Diagnosa> {
  const accs = await db.coaAccount.findMany({ where: { code: { in: [...ACCOUNTS] } }, select: { id: true, code: true } });
  const codeOfId = new Map(accs.map((a) => [a.id, a.code]));
  const mvs = await db.stockMovement.findMany({ select: { ref: true, qty: true, unitCost: true, fromLocationId: true, toLocationId: true, journalId: true, item: { select: { type: true } } } });
  const mutasi = new Map<string, number>();
  const groupOfJournal = new Map<string, string>();
  for (const m of mvs) {
    const g0 = refGroup(m.ref);
    const g = MOVEMENT_ALIAS[g0] ?? g0;
    if (m.journalId && !groupOfJournal.has(m.journalId)) groupOfJournal.set(m.journalId, g);
    const sign = m.toLocationId && !m.fromLocationId ? 1 : m.fromLocationId && !m.toLocationId ? -1 : 0;
    if (!sign) continue;
    const k = `${INVENTORY_COA[m.item.type]}|${g}`;
    mutasi.set(k, (mutasi.get(k) ?? 0) + sign * Math.round(Number(m.qty) * Number(m.unitCost)));
  }
  const lines = await db.journalLine.findMany({ where: { accountId: { in: accs.map((a) => a.id) } }, select: { accountId: true, debit: true, credit: true, journal: { select: { id: true, source: true, sourceId: true, reversalOfId: true } } } });
  const jurnal = new Map<string, number>();
  const parentIds = [...new Set(lines.map((l) => l.journal.reversalOfId).filter((x): x is string => !!x))];
  const parents = new Map((parentIds.length ? await db.journal.findMany({ where: { id: { in: parentIds } }, select: { id: true, source: true, sourceId: true } }) : []).map((x) => [x.id, x]));
  for (const l of lines) {
    const j = l.journal;
    const own = (x: { id: string; source: string; sourceId: string | null }) => groupOfJournal.get(x.id) ?? (x.source === "WORKSHOP" ? refGroup(x.sourceId) : JOURNAL_GROUP[x.source] ?? `J:${x.source}`);
    // Jurnal pembalik (PEMBALIK/koreksi) ikut grup jurnal aslinya, bukan grup tersendiri
    const g = j.reversalOfId && !groupOfJournal.has(j.id) ? (groupOfJournal.get(j.reversalOfId) ?? (parents.get(j.reversalOfId) ? own(parents.get(j.reversalOfId)!) : own(j))) : own(j);
    const k = `${codeOfId.get(l.accountId)}|${g}`;
    jurnal.set(k, (jurnal.get(k) ?? 0) + Number(l.debit) - Number(l.credit));
  }
  const keys = new Set([...mutasi.keys(), ...jurnal.keys()]);
  const rows: DiagRow[] = [...keys].map((k) => {
    const [account, group] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    const mu = mutasi.get(k) ?? 0, jr = jurnal.get(k) ?? 0;
    return { account, group, mutasi: mu, jurnal: jr, selisih: jr - mu };
  }).filter((r) => Math.abs(r.mutasi) > 0 || Math.abs(r.jurnal) > 0).sort((a, b) => a.account.localeCompare(b.account) || Math.abs(b.selisih) - Math.abs(a.selisih));
  const val = await inventoryValuation(db as never);
  const nilaiStokVsMutasi: Record<string, number> = {};
  for (const a of ACCOUNTS) nilaiStokVsMutasi[a] = Math.round([...mutasi].filter(([k]) => k.startsWith(`${a}|`)).reduce((x, [, v]) => x + v, 0) - val.byType[TYPE_OF[a]]);
  // Bagian terbukti: jenis referensi (selain REKON) yang membuat 1-1401 terlalu tinggi DAN 1-1403 terlalu rendah sekaligus
  const perGrup: { group: string; amount: number }[] = [];
  for (const g of new Set(rows.map((r) => r.group))) {
    if (g === "REKON") continue;
    const a = rows.find((r) => r.account === COA.PERSEDIAAN_BAHAN && r.group === g)?.selisih ?? 0;
    const c = rows.find((r) => r.account === COA.PERSEDIAAN_JADI && r.group === g)?.selisih ?? 0;
    const amount = Math.round(Math.min(Math.max(a, 0), Math.max(-c, 0)));
    if (amount > TOLERANSI) perGrup.push({ group: g, amount });
  }
  const total = perGrup.reduce((x, r) => x + r.amount, 0);
  const sudah = await antarSudah(db);
  return { rows, nilaiStokVsMutasi, antar: { total, sudah, sisa: Math.max(0, total - sudah), perGrup: perGrup.sort((a, b) => b.amount - a.amount) } };
}

/** Reklas antar persediaan yang sudah dibukukan (Cr 1-1401 memo REKON:ANTAR) */
async function antarSudah(db: Db): Promise<number> {
  const acc = await db.coaAccount.findUnique({ where: { code: COA.PERSEDIAAN_BAHAN }, select: { id: true } });
  if (!acc) return 0;
  const ls = await db.journalLine.findMany({ where: { accountId: acc.id, memo: { startsWith: "REKON:ANTAR" }, journal: { source: REKON_SOURCE } }, select: { debit: true, credit: true } });
  return Math.round(ls.reduce((x, l) => x + Number(l.credit) - Number(l.debit), 0));
}

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
  const fin = await db.financeTransaction.findMany({ where: { origin: null, journalId: { not: null } }, select: { id: true, number: true, date: true, amount: true, note: true, rawText: true, counterparty: true, categoryId: true, splits: { select: { note: true, amount: true, itemId: true } } } });
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
    const gap = g - (mvByTx.get(`${ref}|${code}`) ?? 0) + (adjusted.get(`${code}|${memoOf("FINANCE_TANPA_STOK", ref)}`) ?? 0) + (adjusted.get(`${code}|${memoOf("FINANCE_TANPA_STOK", ref)}:LPG`) ?? 0);
    if (Math.abs(gap) <= TOLERANSI) continue;
    const kat = t.categoryId ? catName.get(t.categoryId) : null;
    // Pembelian LPG (dari deskripsi / rincian): bagian LPG → beban LPG; deskripsi campur → hanya nominal baris LPG bila terbaca
    const teks = [t.note, t.rawText, t.counterparty].filter(Boolean).join(" · ");
    let lpgPart = 0;
    let lpgNote: string | undefined;
    if (gap > 0) {
      if (t.splits.length) lpgPart = t.splits.filter((x) => !x.itemId && lpgShare(x.note, Number(x.amount)).mode !== "tidak-lpg").reduce((a, x) => a + Number(x.amount), 0);
      else {
        const sh = lpgShare(teks, Number(t.amount));
        // Mode "baris": hanya LPG bila leg persediaan sebesar nominal LPG dari teks (leg 5.000 kardus bekas bukan LPG 60rb); "penuh": seluruh transaksi LPG
        if (sh.mode === "penuh") lpgPart = sh.amount;
        else if (sh.mode === "baris") lpgPart = gap >= sh.amount - TOLERANSI ? sh.amount : 0;
        else if (sh.mode === "tidak-terparse") lpgNote = `deskripsi campur, nominal baris LPG tidak terbaca ("${sh.lines.join(" / ").slice(0, 60)}") → tidak dipisah`;
      }
      lpgPart = Math.min(gap, lpgPart);
      const done = -(adjusted.get(`${code}|${memoOf("FINANCE_TANPA_STOK", ref)}:LPG`) ?? 0);
      lpgPart = Math.max(0, lpgPart - done);
    }
    rows.push({ kelompok: "FINANCE_TANPA_STOK", account: code, ref, date: t.date, gap, detail: `${t.note ?? t.counterparty ?? "(tanpa catatan)"}${kat ? ` · kategori ${kat}` : ""}`, lpgPart: lpgPart > 0 ? lpgPart : undefined, lpgNote, usul: gap > 0 ? (lpgPart > 0 ? `pembelian LPG Rp${lpgPart.toLocaleString("id-ID")} → reklas ke beban LPG${gap - lpgPart > TOLERANSI ? `; sisa Rp${(gap - lpgPart).toLocaleString("id-ID")}: penerimaan stok atau beban pemakaian bahan` : ""}` : "buat penerimaan stok (Barang masuk/Pembelian dengan barang & qty) ATAU reklas ke beban pemakaian bahan") : "periksa: stok masuk lebih besar dari jurnal transaksi" });
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
  return { lpgAccount: await lpgExpenseAccount(db), accounts, rows: rows.sort((a, b) => a.account.localeCompare(b.account) || a.kelompok.localeCompare(b.kelompok) || (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0)) };
}

export type Keputusan = {
  /** Transaksi Finance debit persediaan tanpa stok: beban pemakaian bahan, atau selisih persediaan; kosong = belum diputuskan (tidak dikoreksi) */
  financeTanpaStok?: "beban-pemakaian" | "selisih";
  /** Penerimaan stok tanpa jurnal: lawan Ekuitas saldo awal atau Beban Selisih Persediaan; kosong = tidak dikoreksi */
  penerimaanTanpaJurnal?: "saldo-awal" | "selisih";
  /** Sisa selisih akun yang belum terjelaskan → Beban Selisih Persediaan (6-1800) */
  sisa?: "selisih";
  /** Pindahkan hanya bagian terbukti (jenis referensi yang sama) dari 1-1401 (terlalu tinggi) ke 1-1403 (terlalu rendah): Cr 1-1401 / Dr 1-1403 */
  sisaAntar?: "reklas-antar-persediaan";
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
    let gap = r.gap;
    // Pembelian LPG → beban LPG (agar cek:overhead-bulanan / biaya LPG per pcs benar), bukan beban pemakaian bahan
    if (r.kelompok === "FINANCE_TANPA_STOK" && r.lpgPart && result.lpgAccount) {
      lines.push({ account: r.account, counter: result.lpgAccount.code, amount: r.lpgPart, memo: `${memoOf(r.kelompok, r.ref)}:LPG`, kelompok: "FINANCE_LPG", ref: r.ref });
      gap -= r.lpgPart;
      if (Math.abs(gap) <= TOLERANSI) continue;
    }
    const counter = counterOf(r.kelompok);
    if (!counter) { belum.add(r.kelompok); continue; }
    lines.push({ account: r.account, counter, amount: gap, memo: memoOf(r.kelompok, r.ref), kelompok: r.kelompok, ref: r.ref });
  }
  let antar = 0;
  if (k.sisaAntar === "reklas-antar-persediaan") {
    antar = (await diagnosaSisa(db)).antar.sisa;
    if (antar > TOLERANSI) lines.push({ account: COA.PERSEDIAAN_BAHAN, counter: COA.PERSEDIAAN_JADI, amount: antar, memo: "REKON:ANTAR:1-1401", kelompok: "SISA_ANTAR", ref: "1-1401→1-1403" });
    else antar = 0;
  }
  if (k.sisa === "selisih") for (const a0 of result.accounts) {
    // Reklas antar-persediaan (bila dipilih) mengurangi sisa 1-1401 dan menambah sisa 1-1403 dengan jumlah yang sama
    const a = { ...a0, sisa: a0.sisa + (a0.code === COA.PERSEDIAAN_BAHAN ? -antar : a0.code === COA.PERSEDIAAN_JADI ? antar : 0) };
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

export type RincianJurnal = { number: string; date: Date; description: string; sourceId: string | null; account: string; amount: number; lawan: string; pihak: string | null };

/**
 * Rincian jurnal bersumber `source` yang menyentuh akun persediaan (tanpa mengubah apa pun): nomor, tanggal, pihak (supplier untuk UTANG),
 * nominal pada akun persediaan (debit − kredit) dan akun lawan. Dipakai untuk menelusuri grup jurnal tanpa mutasi stok (mis. J:UTANG).
 */
export async function rincianJurnal(db: Db, source: string): Promise<RincianJurnal[]> {
  const accs = await db.coaAccount.findMany({ where: { code: { in: [...ACCOUNTS] } }, select: { id: true, code: true } });
  const codeOfId = new Map(accs.map((a) => [a.id, a.code]));
  const js = await db.journal.findMany({ where: { source, lines: { some: { accountId: { in: accs.map((a) => a.id) } } } }, orderBy: { date: "asc" }, select: { number: true, date: true, description: true, sourceId: true, lines: { select: { accountId: true, debit: true, credit: true, account: { select: { code: true, name: true } } } } } });
  const payables = source === "UTANG" ? await db.payable.findMany({ where: { number: { in: js.map((j) => j.sourceId).filter((x): x is string => !!x) } }, select: { number: true, vendor: true, supplier: { select: { name: true } } } }) : [];
  const party = new Map(payables.map((p) => [p.number, p.supplier?.name ?? p.vendor]));
  const out: RincianJurnal[] = [];
  for (const j of js) {
    for (const l of j.lines.filter((x) => codeOfId.has(x.accountId))) {
      out.push({
        number: j.number, date: j.date, description: j.description, sourceId: j.sourceId, account: codeOfId.get(l.accountId)!, amount: Number(l.debit) - Number(l.credit),
        lawan: j.lines.filter((x) => x !== l).map((x) => `${x.account.code} ${x.account.name}`).join(" / "), pihak: j.sourceId ? party.get(j.sourceId) ?? null : null,
      });
    }
  }
  return out;
}

export type BarangDiag = { sku: string; name: string; type: string; account: string; avgCost: number; qty: number; nilaiStok: number; nilaiMutasi: number; selisihValuasi: number; lokasiNegatif: { lokasi: string; qty: number }[] };

/**
 * Per barang: qty per lokasi (Σ masuk − keluar), nilai stok sekarang (qty × harga rata-rata) vs Σ nilai mutasi (qty × harga mutasi, masuk +, keluar −).
 * negatif = barang yang qty total, nilai, atau qty di salah satu lokasi negatif. selisihValuasi = nilai mutasi − nilai stok: dominan dari
 * pergeseran harga rata-rata (mis. keluar dihargai harga rata-rata saat itu, harga rata-rata kini berbeda) atau stok minus.
 */
export async function diagnosaBarang(db: Db): Promise<{ negatif: BarangDiag[]; perAkun: Record<string, BarangDiag[]> }> {
  const mvs = await db.stockMovement.findMany({ select: { itemId: true, qty: true, unitCost: true, fromLocationId: true, toLocationId: true } });
  const locs = new Map((await db.location.findMany({ select: { id: true, name: true } })).map((l) => [l.id, l.name]));
  const qtyLoc = new Map<string, Map<string, number>>();
  const nilai = new Map<string, number>();
  const add = (itemId: string, loc: string, q: number) => { const m = qtyLoc.get(itemId) ?? new Map<string, number>(); m.set(loc, (m.get(loc) ?? 0) + q); qtyLoc.set(itemId, m); };
  for (const m of mvs) {
    const q = Number(m.qty);
    if (m.toLocationId) add(m.itemId, m.toLocationId, q);
    if (m.fromLocationId) add(m.itemId, m.fromLocationId, -q);
    const sign = m.toLocationId && !m.fromLocationId ? 1 : m.fromLocationId && !m.toLocationId ? -1 : 0;
    if (sign) nilai.set(m.itemId, (nilai.get(m.itemId) ?? 0) + sign * Math.round(q * Number(m.unitCost)));
  }
  const items = await db.item.findMany({ where: { id: { in: [...qtyLoc.keys()] } }, select: { id: true, sku: true, name: true, type: true, avgCost: true } });
  const rows: BarangDiag[] = items.map((i) => {
    const per = qtyLoc.get(i.id)!;
    const qty = Math.round([...per.values()].reduce((a, b) => a + b, 0) * 1000) / 1000;
    const nilaiStok = Math.round(qty * Number(i.avgCost));
    const nilaiMutasi = nilai.get(i.id) ?? 0;
    return { sku: i.sku, name: i.name, type: i.type, account: INVENTORY_COA[i.type], avgCost: Number(i.avgCost), qty, nilaiStok, nilaiMutasi, selisihValuasi: nilaiMutasi - nilaiStok, lokasiNegatif: [...per].filter(([, q]) => q < -0.0005).map(([l, q]) => ({ lokasi: locs.get(l) ?? l, qty: Math.round(q * 1000) / 1000 })) };
  });
  const negatif = rows.filter((r) => r.qty < -0.0005 || r.nilaiStok < 0 || r.lokasiNegatif.length > 0).sort((a, b) => a.nilaiStok - b.nilaiStok);
  const perAkun: Record<string, BarangDiag[]> = {};
  for (const a of ACCOUNTS) perAkun[a] = rows.filter((r) => r.account === a && Math.abs(r.selisihValuasi) > TOLERANSI).sort((x, y) => Math.abs(y.selisihValuasi) - Math.abs(x.selisihValuasi)).slice(0, 15);
  return { negatif, perAkun };
}
