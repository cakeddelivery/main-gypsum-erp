import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { COA } from "./accounting";
import { activeDuplicateJournals } from "./auditChecks";
import { inventoryValuation, negativeStock } from "./stock";
import { addDays, dateOnly, dateStr, todayStr } from "./time";
import { lastCompletedCycle } from "./payroll";

/**
 * Cek Konsistensi (HANYA MEMBACA): menelusuri uang, barang, absensi → gaji, dan karyawan dari awal sampai akhir.
 * Setiap dokumen harus punya status akhir yang jelas dan jejak ke jurnal / stok / rekening. Hasilnya daftar masalah
 * dengan tautan ke dokumennya. Dipakai halaman Akuntansi → Cek konsistensi dan job harian 06.00 (ringkasan ke Owner).
 */
export type Level = "KRITIS" | "SEDANG" | "INFO";
export type Area = "UANG" | "BARANG" | "ABSENSI_GAJI" | "KARYAWAN";
export type IssueItem = { label: string; detail?: string; href?: string };
export type Issue = { key: string; area: Area; level: Level; title: string; hint: string; items: IssueItem[] };

export const AREA_LABEL: Record<Area, string> = { UANG: "Uang", BARANG: "Barang & stok", ABSENSI_GAJI: "Absensi & gaji", KARYAWAN: "Karyawan & akun" };

/** Ambang "menggantung" (hari) */
export const STALE = { draft: 3, wdProcess: 5, delivery: 14, receipt: 3, handover: 3, request: 7, borongan: 30, attendance: 3, registration: 3 };

const idr = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
/** Selisih pembulatan yang masih wajar antara nilai stok (qty × harga rata-rata) dan saldo akun persediaan */
const INV_TOLERANCE = 1000;

type Ctx = { now: Date; today: string };
type Check = (c: Ctx) => Promise<Issue | null>;
const issue = (key: string, area: Area, level: Level, title: string, hint: string, items: IssueItem[]): Issue | null => (items.length ? { key, area, level, title, hint, items } : null);
const daysAgo = (c: Ctx, n: number) => new Date(c.now.getTime() - n * 86_400_000);

/** Saldo (debit − kredit) per akun COA */
async function balances(codes?: string[]) {
  const accounts = await prisma.coaAccount.findMany({ where: codes ? { code: { in: codes } } : {}, select: { id: true, code: true, name: true } });
  const sums = await prisma.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: accounts.map((a) => a.id) } }, _sum: { debit: true, credit: true } });
  const m = new Map(sums.map((s) => [s.accountId, Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0)]));
  return accounts.map((a) => ({ ...a, net: m.get(a.id) ?? 0 }));
}

/** Jurnal yang sudah dibalik (id jurnal asli) */
async function reversedIds(ids: string[]) {
  if (!ids.length) return new Set<string>();
  return new Set((await prisma.journal.findMany({ where: { reversalOfId: { in: ids } }, select: { reversalOfId: true } })).map((r) => r.reversalOfId!));
}

// =============================== UANG ===============================

const unbalancedJournals: Check = async () => {
  const rows = await prisma.$queryRaw<{ id: string; number: string; d: Prisma.Decimal; k: Prisma.Decimal }[]>`
    SELECT j.id, j.number, COALESCE(SUM(l.debit),0) AS d, COALESCE(SUM(l.credit),0) AS k
    FROM "Journal" j LEFT JOIN "JournalLine" l ON l."journalId" = j.id
    GROUP BY j.id, j.number HAVING COALESCE(SUM(l.debit),0) <> COALESCE(SUM(l.credit),0) OR COUNT(l.id) < 2`;
  return issue("jurnal-tidak-seimbang", "UANG", "KRITIS", "Jurnal tidak seimbang", "Debit harus sama dengan kredit. Jurnal ini membuat neraca tidak seimbang; koreksi dengan jurnal pembalik.",
    rows.map((r) => ({ label: r.number, detail: `debit ${idr(Number(r.d))} ≠ kredit ${idr(Number(r.k))}`, href: `/akuntansi/jurnal?q=${r.number}` })));
};

const duplicateJournals: Check = async () => {
  const g = await activeDuplicateJournals(prisma, new Date(0));
  return issue("jurnal-ganda", "UANG", "KRITIS", "Jurnal ganda untuk satu dokumen", "Satu dokumen tercatat lebih dari sekali (uang/penjualan terhitung dobel). Balik salah satunya.",
    g.map((x) => ({ label: `${x.source} ${x.sourceId}`, detail: x.numbers.join(", "), href: `/akuntansi/jurnal?q=${x.numbers[0]}` })));
};

const bookedWithoutJournal: Check = async () => {
  const rows = await prisma.financeTransaction.findMany({ where: { status: { in: ["DIBUKUKAN", "DALAM_PROSES"] }, journalId: null }, select: { id: true, number: true, amount: true } });
  return issue("trx-tanpa-jurnal", "UANG", "KRITIS", "Transaksi Dibukukan tanpa jurnal", "Status Dibukukan tetapi tidak ada jurnalnya: saldo rekening tidak ikut berubah.",
    rows.map((r) => ({ label: r.number, detail: idr(Number(r.amount)), href: `/finance/${r.id}` })));
};

const cancelledNotReversed: Check = async () => {
  const rows = await prisma.financeTransaction.findMany({ where: { status: "DIBATALKAN", journalId: { not: null } }, select: { id: true, number: true, amount: true, journalId: true } });
  const rev = await reversedIds(rows.map((r) => r.journalId!));
  return issue("trx-batal-belum-dibalik", "UANG", "KRITIS", "Transaksi Dibatalkan tetapi jurnalnya belum dibalik", "Uangnya masih terhitung di saldo rekening walau transaksinya dibatalkan.",
    rows.filter((r) => !rev.has(r.journalId!)).map((r) => ({ label: r.number, detail: idr(Number(r.amount)), href: `/finance/${r.id}` })));
};

const mirrorOfReversed: Check = async () => {
  const rows = await prisma.financeTransaction.findMany({ where: { status: "DIBUKUKAN", origin: { not: null }, journalId: { not: null } }, select: { id: true, number: true, amount: true, journalId: true, origin: true } });
  const rev = await reversedIds(rows.map((r) => r.journalId!));
  return issue("trx-tertaut-basi", "UANG", "SEDANG", "Baris tertaut masih Dibukukan padahal dokumen sumbernya dibatalkan", "Hanya tampilan di menu Transaksi (saldo sudah benar). Jalankan npm run tautkan:transaksi atau batalkan di menu sumbernya.",
    rows.filter((r) => rev.has(r.journalId!)).map((r) => ({ label: r.number, detail: `${r.origin} ${idr(Number(r.amount))}`, href: `/finance/${r.id}` })));
};

const staleDrafts: Check = async (c) => {
  const rows = await prisma.financeTransaction.findMany({ where: { status: { in: ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"] }, deletedAt: null, createdAt: { lt: daysAgo(c, STALE.draft) } }, orderBy: { date: "asc" }, select: { id: true, number: true, amount: true, status: true, date: true } });
  return issue("trx-menggantung", "UANG", "SEDANG", `Transaksi belum final lebih dari ${STALE.draft} hari`, "Draft / Perlu Ditinjau / Menunggu Konfirmasi: bukukan atau tolak agar saldo & laporan lengkap.",
    rows.map((r) => ({ label: r.number, detail: `${r.status.replace(/_/g, " ").toLowerCase()} · ${dateStr(r.date)} · ${idr(Number(r.amount))}`, href: `/finance/${r.id}` })));
};

const staleWdProcess: Check = async (c) => {
  const rows = await prisma.financeTransaction.findMany({ where: { status: "DALAM_PROSES", date: { lt: daysAgo(c, STALE.wdProcess) } }, select: { id: true, number: true, amount: true, date: true } });
  return issue("wd-proses-lama", "UANG", "SEDANG", `Withdraw Dalam Proses lebih dari ${STALE.wdProcess} hari`, "Uang WD biasanya masuk 1–3 hari. Tekan \"Uang diterima\" bila sudah masuk, atau cek ke marketplace.",
    rows.map((r) => ({ label: r.number, detail: `${dateStr(r.date)} · ${idr(Number(r.amount))}`, href: `/finance/${r.id}` })));
};

const transitBalance: Check = async () => {
  const code = (await prisma.setting.findUnique({ where: { key: "coa_dana_perjalanan" } }))?.value;
  if (!code) return null;
  const [acc] = await balances([code]);
  if (!acc) return null;
  const open = await prisma.financeTransaction.aggregate({ where: { status: "DALAM_PROSES" }, _sum: { amount: true } });
  const want = Number(open._sum.amount ?? 0);
  return issue("dana-perjalanan", "UANG", "KRITIS", "Saldo Dana dalam Perjalanan ≠ total WD Dalam Proses", "Ada WD yang uangnya sudah/tidak diterima tetapi jurnalnya tidak sesuai.",
    acc.net !== want ? [{ label: `${acc.code} ${acc.name}`, detail: `saldo ${idr(acc.net)} · WD dalam proses ${idr(want)} · selisih ${idr(acc.net - want)}`, href: "/finance?status=DALAM_PROSES" }] : []);
};

const bankNegative: Check = async (c) => {
  const banks = await prisma.bankAccount.findMany({ select: { id: true, name: true, active: true, coaAccountId: true, marketplace: true } });
  const sums = await prisma.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: banks.map((b) => b.coaAccountId) }, journal: { date: { lt: dateOnly(addDays(c.today, 1)) } } }, _sum: { debit: true, credit: true } });
  const bal = (id: string) => { const s = sums.find((x) => x.accountId === id); return Number(s?._sum.debit ?? 0) - Number(s?._sum.credit ?? 0); };
  const items: IssueItem[] = [];
  for (const b of banks) {
    const v = bal(b.coaAccountId);
    // Saldo penjual marketplace boleh minus (penjualan baru diakui saat withdraw)
    if (v < 0 && !b.marketplace) items.push({ label: b.name, detail: `saldo ${idr(v)} (minus)`, href: `/finance/mutasi?account=${b.id}` });
    else if (!b.active && v !== 0) items.push({ label: `${b.name} (nonaktif)`, detail: `masih bersaldo ${idr(v)}`, href: `/finance/mutasi?account=${b.id}` });
  }
  return issue("rekening-minus", "UANG", "KRITIS", "Saldo rekening minus / rekening nonaktif masih bersaldo", "Rekening asli tidak bisa minus: ada uang keluar yang salah rekening atau uang masuk yang belum dicatat.", items);
};

/** Daftar dokumen hutang/piutang vs saldo akunnya */
const payablesVsLedger: Check = async () => {
  const pays = await prisma.payable.findMany({ select: { id: true, number: true, kind: true, amount: true, paid: true, coaAccountId: true } });
  const items: IssueItem[] = [];
  for (const p of pays) if (p.paid > p.amount || p.paid < BigInt(0)) items.push({ label: p.number, detail: `terbayar ${idr(Number(p.paid))} dari ${idr(Number(p.amount))}`, href: "/akuntansi/piutang-utang?tab=utang" });
  const accs = await balances([COA.UTANG_USAHA, COA.UTANG_PINJAMAN]);
  const custom = new Set(pays.map((p) => p.coaAccountId).filter((x): x is string => !!x));
  for (const a of accs) {
    const docs = pays.filter((p) => (p.coaAccountId ? p.coaAccountId === a.id : (p.kind === "PINJAMAN" ? COA.UTANG_PINJAMAN : COA.UTANG_USAHA) === a.code));
    const rest = docs.reduce((s, p) => s + Number(p.amount - p.paid), 0);
    if (-a.net !== rest) items.push({ label: `${a.code} ${a.name}`, detail: `saldo akun ${idr(-a.net)} · sisa dokumen ${idr(rest)} · selisih ${idr(-a.net - rest)}`, href: "/akuntansi/piutang-utang?tab=utang" });
  }
  for (const id of custom) {
    const [a] = await prisma.coaAccount.findMany({ where: { id }, select: { code: true, name: true } });
    const [b] = await balances([a.code]);
    const rest = pays.filter((p) => p.coaAccountId === id).reduce((s, p) => s + Number(p.amount - p.paid), 0);
    if (a.code !== COA.UTANG_USAHA && a.code !== COA.UTANG_PINJAMAN && -b.net !== rest) items.push({ label: `${a.code} ${a.name}`, detail: `saldo akun ${idr(-b.net)} · sisa dokumen ${idr(rest)}`, href: "/akuntansi/piutang-utang?tab=utang" });
  }
  return issue("hutang-vs-akun", "UANG", "SEDANG", "Daftar hutang/pinjaman ≠ saldo akun hutang", "Ada hutang yang dicatat lewat jurnal manual tanpa dokumen (tidak bisa dicicil/diingatkan), atau dokumen yang terbayar tidak wajar.", items);
};

const receivablesVsLedger: Check = async () => {
  const recs = await prisma.receivable.findMany({ select: { number: true, amount: true, paid: true } });
  const items: IssueItem[] = recs.filter((r) => r.paid > r.amount || r.paid < BigInt(0)).map((r) => ({ label: r.number, detail: `terbayar ${idr(Number(r.paid))} dari ${idr(Number(r.amount))}`, href: "/akuntansi/piutang-utang" }));
  const [a] = await balances([COA.PIUTANG]);
  const rest = recs.reduce((s, r) => s + Number(r.amount - r.paid), 0);
  if (a && a.net !== rest) items.push({ label: `${a.code} ${a.name}`, detail: `saldo akun ${idr(a.net)} · sisa dokumen ${idr(rest)} · selisih ${idr(a.net - rest)}`, href: "/akuntansi/piutang-utang" });
  return issue("piutang-vs-akun", "UANG", "SEDANG", "Daftar piutang ≠ saldo akun Piutang Usaha", "Ada piutang yang dicatat lewat jurnal manual tanpa dokumen, atau pelunasan yang tidak mengurangi dokumennya.", items);
};

const prepaidVsLedger: Check = async () => {
  const [a] = await balances([COA.UANG_MUKA_PEMBELIAN]);
  // Pembelian biasa (bukan pesanan) tidak memakai uang muka: paidNow-nya bukan uang muka, jadi hanya pesanan yang dihitung
  const orders = await prisma.purchase.findMany({ where: { cancelledAt: null, OR: [{ delivery: { in: ["MENUNGGU", "SEBAGIAN", "DITUTUP"] } }, { prepaidUsed: { gt: 0 } }, { deliveries: { some: {} } }] }, select: { paidNow: true, prepaidUsed: true } });
  const rest = orders.reduce((s, p) => s + Number(p.paidNow - p.prepaidUsed), 0);
  return issue("uang-muka", "UANG", "SEDANG", "Saldo Uang Muka Pembelian ≠ sisa uang muka pesanan", "Uang muka pesanan yang sudah datang/ditutup harus berpindah ke persediaan atau piutang refund.",
    a && a.net !== rest ? [{ label: `${a.code} ${a.name}`, detail: `saldo akun ${idr(a.net)} · sisa uang muka pesanan ${idr(rest)}`, href: "/stok/pembelian" }] : []);
};

const purchaseIssues: Check = async (c) => {
  const late = await prisma.purchase.findMany({ where: { cancelledAt: null, delivery: { in: ["MENUNGGU", "SEBAGIAN"] }, date: { lt: daysAgo(c, STALE.delivery) } }, select: { number: true, vendor: true, date: true, delivery: true } });
  return issue("pesanan-lama", "UANG", "INFO", `Pesanan belum datang lebih dari ${STALE.delivery} hari`, "Terima barangnya, atau Tutup pesanan bila tidak akan datang (uang muka jadi piutang refund).",
    late.map((p) => ({ label: p.number, detail: `${p.vendor} · ${dateStr(p.date)} · ${p.delivery === "SEBAGIAN" ? "datang sebagian" : "menunggu"}`, href: "/stok/pembelian" })));
};

const cancelledDocsNotReversed: Check = async () => {
  const [pur, sal, set, adv] = await Promise.all([
    prisma.purchase.findMany({ where: { cancelledAt: { not: null }, journalId: { not: null } }, select: { number: true, journalId: true } }),
    prisma.sale.findMany({ where: { cancelledAt: { not: null }, journalId: { not: null } }, select: { number: true, journalId: true } }),
    prisma.boronganSettlement.findMany({ where: { cancelledAt: { not: null }, journalId: { not: null } }, select: { number: true, journalId: true } }),
    prisma.cashAdvance.findMany({ where: { cancelledAt: { not: null }, journalId: { not: null } }, select: { number: true, journalId: true } }),
  ]);
  const all = [...pur.map((x) => ({ ...x, kind: "Pembelian", href: "/stok/pembelian" })), ...sal.map((x) => ({ ...x, kind: "Penjualan", href: "/penjualan" })), ...set.map((x) => ({ ...x, kind: "Upah borongan", href: "/borongan" })), ...adv.map((x) => ({ ...x, kind: "Kasbon", href: "/gaji/kasbon" }))];
  const rev = await reversedIds(all.map((x) => x.journalId!));
  return issue("dokumen-batal-belum-dibalik", "UANG", "KRITIS", "Dokumen dibatalkan tetapi jurnalnya belum dibalik", "Uang/stok dokumen ini masih terhitung walau sudah dibatalkan.",
    all.filter((x) => !rev.has(x.journalId!)).map((x) => ({ label: `${x.kind} ${x.number}`, href: x.href })));
};

const salesPaid: Check = async () => {
  const rows = await prisma.sale.findMany({ where: { cancelledAt: null }, select: { id: true, number: true, total: true, paid: true } });
  return issue("penjualan-bayar", "UANG", "KRITIS", "Penjualan terbayar melebihi tagihan / minus", "Pembayaran tercatat lebih dari total nota.",
    rows.filter((r) => r.paid > r.total || r.paid < BigInt(0)).map((r) => ({ label: r.number, detail: `${idr(Number(r.paid))} dari ${idr(Number(r.total))}`, href: `/penjualan/${r.id}` })));
};

const advances: Check = async () => {
  const rows = await prisma.cashAdvance.findMany({ where: { cancelledAt: null }, select: { number: true, amount: true, repaid: true, employee: { select: { name: true, wageType: true } } } });
  const items: IssueItem[] = rows.filter((a) => a.repaid > a.amount || a.repaid < BigInt(0)).map((a) => ({ label: a.number, detail: `${a.employee.name}: dicicil ${idr(Number(a.repaid))} dari ${idr(Number(a.amount))}`, href: "/gaji/kasbon" }));
  const [acc] = await balances([COA.PIUTANG_KARYAWAN]);
  const rest = rows.reduce((s, a) => s + Number(a.amount - a.repaid), 0);
  if (acc && acc.net !== rest) items.push({ label: `${acc.code} ${acc.name}`, detail: `saldo akun ${idr(acc.net)} · sisa kasbon ${idr(rest)} · selisih ${idr(acc.net - rest)}`, href: "/gaji/kasbon" });
  return issue("kasbon", "UANG", "SEDANG", "Kasbon tidak wajar / sisa kasbon ≠ saldo Piutang Karyawan", "Kasbon dicicil melebihi nominal, atau piutang karyawan dicatat lewat jurnal manual.", items);
};

const reserveFunds: Check = async () => {
  const funds = await prisma.reserveFund.findMany({ select: { id: true, name: true } });
  const sums = await prisma.reserveEntry.groupBy({ by: ["fundId", "type"], _sum: { amount: true } });
  const noJournal = await prisma.reserveEntry.count({ where: { journalId: null } });
  const items: IssueItem[] = [];
  for (const f of funds) {
    const g = (t: string) => Number(sums.find((s) => s.fundId === f.id && s.type === t)?._sum.amount ?? 0);
    if (g("SISIH") - g("TARIK") < 0) items.push({ label: f.name, detail: `saldo dana ${idr(g("SISIH") - g("TARIK"))} (minus)`, href: "/finance/sisihan" });
  }
  if (noJournal) items.push({ label: `${noJournal} catatan sisihan tanpa jurnal`, detail: "uangnya tidak tercatat pindah rekening", href: "/finance/sisihan" });
  return issue("sisihan", "UANG", "SEDANG", "Dana sisihan tidak wajar", "Saldo dana sisihan tidak boleh minus dan setiap sisihan harus punya jurnal.", items);
};

const depreciationGaps: Check = async () => {
  const [assets, closed] = await Promise.all([
    prisma.fixedAsset.findMany({ where: { active: true }, select: { id: true, name: true, acquiredAt: true, usefulLifeMonths: true } }),
    prisma.accountingPeriod.findMany({ where: { status: "CLOSED" }, select: { year: true, month: true } }),
  ]);
  const items: IssueItem[] = [];
  for (const a of assets) {
    const keys = new Set((await prisma.journal.findMany({ where: { source: "PENYUSUTAN", sourceId: { startsWith: `${a.id}:` } }, select: { sourceId: true } })).map((j) => j.sourceId!.split(":")[1]));
    if (keys.size >= a.usefulLifeMonths) continue;
    const acq = dateStr(new Date(a.acquiredAt.getTime() + 7 * 3600e3)).slice(0, 7);
    const miss = closed.filter((p) => `${p.year}-${String(p.month).padStart(2, "0")}` >= acq && !keys.has(`${p.year}-${p.month}`));
    if (miss.length) items.push({ label: a.name, detail: `penyusutan belum dibukukan untuk ${miss.map((p) => `${p.month}/${p.year}`).join(", ")}`, href: "/akuntansi/aset" });
  }
  return issue("penyusutan", "UANG", "INFO", "Aset tetap belum disusutkan di bulan yang sudah ditutup", "Penyusutan dibukukan saat tutup buku; aset yang dicatat sesudah bulannya ditutup tidak ikut. Buka-tutup ulang bulan itu atau catat penyusutan susulan.", items);
};

// =============================== BARANG ===============================

const inventoryVsLedger: Check = async () => {
  const v = await inventoryValuation();
  const accs = await balances([COA.PERSEDIAAN_BAHAN, COA.PERSEDIAAN_BDP, COA.PERSEDIAAN_JADI]);
  const map: [string, number][] = [[COA.PERSEDIAAN_BAHAN, v.byType.BAHAN_BAKU], [COA.PERSEDIAAN_BDP, v.byType.BARANG_DALAM_PROSES], [COA.PERSEDIAAN_JADI, v.byType.BARANG_JADI]];
  const items: IssueItem[] = [];
  for (const [code, stock] of map) {
    const a = accs.find((x) => x.code === code);
    if (a && Math.abs(a.net - stock) > INV_TOLERANCE) items.push({ label: `${a.code} ${a.name}`, detail: `nilai stok ${idr(stock)} · saldo akun ${idr(a.net)} · selisih ${idr(a.net - stock)}`, href: "/stok/kartu" });
  }
  return issue("persediaan-vs-akun", "BARANG", "SEDANG", "Nilai stok ≠ saldo akun persediaan", "Nilai stok (jumlah × harga rata-rata) harus sama dengan neraca. Selisih biasanya karena stok minus, harga rata-rata berubah setelah barang keluar, atau mutasi tanpa jurnal.", items);
};

const negative: Check = async () => {
  const rows = await negativeStock();
  return issue("stok-minus", "BARANG", "SEDANG", "Stok minus", "Barang keluar/terpakai lebih banyak dari yang tercatat masuk: ada pembelian/hasil kerja yang belum dicatat, atau hitungan salah.",
    rows.map((r) => ({ label: r.item.name, detail: `${r.location.name}: ${r.qty.toLocaleString("id-ID")} ${r.item.unit}`, href: `/stok/kartu?item=${r.itemId}` })));
};

const movementsWithoutRef: Check = async (c) => {
  const n = await prisma.stockMovement.count({ where: { ref: null, date: { gte: daysAgo(c, 30) } } });
  return issue("mutasi-tanpa-ref", "BARANG", "INFO", "Mutasi stok manual tanpa nomor referensi (30 hari)", "Mutasi manual tanpa ref sulit ditelusuri ke dokumennya; isi kolom Ref (nomor nota/dokumen) saat mencatat mutasi.",
    n ? [{ label: `${n} mutasi`, href: "/stok/mutasi" }] : []);
};

const unlinkedReceipts: Check = async (c) => {
  const rows = await prisma.shiftReceipt.findMany({ where: { purchaseId: null, receivedAt: { lt: daysAgo(c, STALE.receipt) } }, include: { item: { select: { name: true, unit: true } } }, orderBy: { receivedAt: "asc" } });
  return issue("barang-masuk-belum-pembelian", "BARANG", "SEDANG", `Barang masuk laporan shift belum dicatat di Pembelian (> ${STALE.receipt} hari)`, "Barangnya sudah ada di gudang tetapi stok sistem, harga, dan hutang/uangnya belum tercatat.",
    rows.map((r) => ({ label: r.number, detail: `${r.item.name} ${Number(r.qty).toLocaleString("id-ID")} ${r.item.unit}${r.supplierName ? ` · ${r.supplierName}` : ""}`, href: "/stok/pembelian" })));
};

const handovers: Check = async (c) => {
  const rows = await prisma.boronganHandover.findMany({ where: { status: "DIKIRIM", date: { lt: daysAgo(c, STALE.handover) } }, include: { point: { select: { name: true } } } });
  return issue("serah-terima-menggantung", "BARANG", "SEDANG", `Serah terima borongan belum diterima (> ${STALE.handover} hari)`, "Barangnya tercatat di lokasi driver: terima di titik/gudang atau batalkan.",
    rows.map((h) => ({ label: h.number, detail: `${h.kind === "KIRIM" ? "kirim ke" : "kembali dari"} ${h.point.name} · ${dateStr(h.date)}`, href: "/borongan" })));
};

const stockRequests: Check = async (c) => {
  const rows = await prisma.stockRequest.findMany({ where: { status: { in: ["DIAJUKAN", "DISETUJUI"] }, createdAt: { lt: daysAgo(c, STALE.request) } }, include: { item: { select: { name: true } } } });
  return issue("permintaan-stok-lama", "BARANG", "INFO", `Permintaan stok terbuka lebih dari ${STALE.request} hari`, "Penuhi (beli/transfer) atau tolak agar daftar order tidak menumpuk.",
    rows.map((r) => ({ label: r.item.name, detail: `${Number(r.qty).toLocaleString("id-ID")} · ${r.status.toLowerCase()} · ${dateStr(r.createdAt)}`, href: "/stok/permintaan" })));
};

const unpaidBorongan: Check = async (c) => {
  const rows = await prisma.boronganResult.groupBy({ by: ["pointId"], where: { settlementId: null, date: { lt: dateOnly(addDays(c.today, -STALE.borongan)) } }, _sum: { qty: true }, _count: true });
  const points = await prisma.boronganPoint.findMany({ where: { id: { in: rows.map((r) => r.pointId) } }, select: { id: true, name: true } });
  return issue("upah-borongan-lama", "BARANG", "INFO", `Setoran borongan belum dibayar lebih dari ${STALE.borongan} hari`, "Upah pekerja/koordinator/driver belum dilunasi.",
    rows.map((r) => ({ label: points.find((p) => p.id === r.pointId)?.name ?? r.pointId, detail: `${r._count} setoran · ${r._sum.qty ?? 0} pcs`, href: "/borongan" })));
};

// =========================== ABSENSI & GAJI ===========================

const unvalidatedAttendance: Check = async (c) => {
  const rows = await prisma.attendance.groupBy({ by: ["employeeId"], where: { validated: false, status: { in: ["HADIR", "TERLAMBAT"] }, date: { lt: dateOnly(addDays(c.today, -STALE.attendance)) } }, _count: true });
  const emps = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, name: true } });
  return issue("absen-belum-validasi", "ABSENSI_GAJI", "SEDANG", `Absen hadir belum divalidasi (> ${STALE.attendance} hari)`, "Absen yang belum divalidasi dihitung TIDAK masuk di slip gaji (bisa terpotong bolos) dan menahan persetujuan gaji.",
    rows.map((r) => ({ label: emps.find((e) => e.id === r.employeeId)?.name ?? r.employeeId, detail: `${r._count} hari`, href: "/absensi" })));
};

/** Hari kerja tanpa catatan absensi apa pun (7 hari terakhir), lebih dari jatah libur */
const missingAttendance: Check = async (c) => {
  const goLive = (await prisma.setting.findUnique({ where: { key: "go_live_date" } }))?.value ?? "2000-01-01";
  const quota = Number((await prisma.setting.findUnique({ where: { key: "weekly_off_quota" } }))?.value) || 1;
  const from = [addDays(c.today, -7), goLive].sort().at(-1)!;
  const to = addDays(c.today, -1);
  if (from > to) return null;
  const emps = await prisma.employee.findMany({ where: { status: "AKTIF", wageType: { not: "BORONGAN" } }, select: { id: true, name: true, joinDate: true, resignDate: true } });
  const att = await prisma.attendance.findMany({ where: { date: { gte: dateOnly(from), lte: dateOnly(to) } }, select: { employeeId: true, date: true } });
  const items: IssueItem[] = [];
  for (const e of emps) {
    const start = [from, e.joinDate ? dateStr(e.joinDate) : from].sort().at(-1)!;
    let days = 0;
    for (let d = start; d <= to; d = addDays(d, 1)) days++;
    if (days <= 0) continue;
    const have = new Set(att.filter((a) => a.employeeId === e.id).map((a) => dateStr(a.date))).size;
    const missing = days - have;
    if (missing > Math.ceil((quota * days) / 7)) items.push({ label: e.name, detail: `${missing} dari ${days} hari tanpa catatan absen (${start} – ${to})`, href: "/absensi" });
  }
  return issue("hari-tanpa-absen", "ABSENSI_GAJI", "INFO", "Hari kerja tanpa status absensi (7 hari terakhir)", "Hari tanpa catatan dihitung tidak masuk (lebih dari jatah libur = bolos). Isi Libur/Izin/Sakit bila memang tidak masuk.", items);
};

const missingPayroll: Check = async (c) => {
  const offset = Number((await prisma.setting.findUnique({ where: { key: "payday_offset_days" } }))?.value) || 7;
  const goLive = (await prisma.setting.findUnique({ where: { key: "go_live_date" } }))?.value ?? null;
  const emps = await prisma.employee.findMany({ where: { wageType: "BULANAN" }, select: { id: true, name: true, joinDate: true, resignDate: true, status: true } });
  const items: IssueItem[] = [];
  for (const e of emps) {
    if (!e.joinDate) { if (e.status !== "NONAKTIF") items.push({ label: e.name, detail: "tanggal masuk kosong: slip bulanan tidak bisa dibuat", href: "/karyawan" }); continue; }
    const cyc = lastCompletedCycle(dateStr(e.joinDate), addDays(c.today, -1), offset);
    if (!cyc || (goLive && cyc.end < goLive)) continue;
    if (e.resignDate && dateStr(e.resignDate) < cyc.start) continue;
    const slip = await prisma.payslip.findFirst({ where: { employeeId: e.id, period: { kind: "BULANAN", startDate: dateOnly(cyc.start), endDate: dateOnly(cyc.end) } } });
    if (!slip) items.push({ label: e.name, detail: `siklus ${cyc.start} – ${cyc.end} belum punya slip`, href: "/gaji" });
  }
  return issue("siklus-tanpa-slip", "ABSENSI_GAJI", "KRITIS", "Siklus gaji selesai tanpa slip", "Slip bulanan dibuat otomatis 06.00 saat siklus selesai. Tidak ada slip = gaji tidak terhitung/terbayar.", items);
};

const payrollAccruals: Check = async (c) => {
  const periods = await prisma.payrollPeriod.findMany({ where: { status: { in: ["DISETUJUI", "DIBAYAR"] } }, include: { payslips: { select: { total: true, advanceDeduction: true } } } });
  const accr = await prisma.journal.findMany({ where: { source: "PAYROLL_AKRUAL" }, select: { id: true, sourceId: true } });
  const rev = await reversedIds(accr.map((j) => j.id));
  const active = new Set(accr.filter((j) => !rev.has(j.id)).map((j) => j.sourceId));
  const items: IssueItem[] = [];
  for (const p of periods) {
    const gross = p.payslips.reduce((s, x) => s + Number(x.total + x.advanceDeduction), 0);
    if (gross <= 0) continue;
    if (p.status === "DISETUJUI" && !active.has(p.id)) items.push({ label: p.code, detail: "disetujui tanpa jurnal Hutang Gaji", href: `/gaji/${p.id}` });
    if (p.status === "DIBAYAR" && !p.journalId) items.push({ label: p.code, detail: "dibayar tanpa jurnal pembayaran", href: `/gaji/${p.id}` });
    if (p.status === "DISETUJUI" && p.payDate && dateStr(p.payDate) < addDays(c.today, -3)) items.push({ label: p.code, detail: `tanggal gajian ${dateStr(p.payDate)} lewat, belum dibayar`, href: `/gaji/${p.id}` });
  }
  const draftLate = await prisma.payrollPeriod.findMany({ where: { status: "DRAFT", payDate: { lt: dateOnly(c.today) } }, select: { id: true, code: true, payDate: true } });
  for (const p of draftLate) items.push({ label: p.code, detail: `masih Draft, gajian ${dateStr(p.payDate!)}`, href: `/gaji/${p.id}` });
  // Hutang Gaji = jumlah periode Disetujui (akrual aktif) yang belum dibayar
  const [acc] = await balances([COA.UTANG_GAJI]);
  const owed = periods.filter((p) => p.status === "DISETUJUI" && active.has(p.id)).reduce((s, p) => s + p.payslips.reduce((a, x) => a + Number(x.total + x.advanceDeduction), 0), 0);
  if (acc && -acc.net !== owed) items.push({ label: `${acc.code} ${acc.name}`, detail: `saldo ${idr(-acc.net)} · gaji disetujui belum dibayar ${idr(owed)} · selisih ${idr(-acc.net - owed)}`, href: "/gaji" });
  return issue("gaji-status", "ABSENSI_GAJI", "SEDANG", "Status gaji tidak lengkap", "Setiap slip disetujui harus punya jurnal Hutang Gaji, dan dibayar sampai lunas pada tanggal gajian.", items);
};

/** Satu karyawan punya dua slip bulanan untuk hari yang sama (dibayar dua kali) */
const doublePay: Check = async () => {
  const slips = await prisma.payslip.findMany({ where: { period: { kind: { in: ["BULANAN", "PERIODE"] } } }, select: { employeeId: true, employee: { select: { name: true } }, period: { select: { id: true, code: true, startDate: true, endDate: true, kind: true } } } });
  const items: IssueItem[] = [];
  const by = new Map<string, typeof slips>();
  for (const s of slips) by.set(s.employeeId, [...(by.get(s.employeeId) ?? []), s]);
  for (const list of by.values()) {
    for (let i = 0; i < list.length; i++)
      for (let k = i + 1; k < list.length; k++) {
        const a = list[i].period, b = list[k].period;
        if (a.kind === b.kind && a.startDate <= b.endDate && b.startDate <= a.endDate) items.push({ label: list[i].employee.name, detail: `${a.code} & ${b.code} tumpang tindih`, href: `/gaji/${a.id}` });
      }
  }
  return issue("gaji-dobel", "ABSENSI_GAJI", "KRITIS", "Slip gaji tumpang tindih (bisa dibayar dua kali)", "Satu karyawan punya dua slip untuk hari yang sama. Batalkan salah satunya.", items);
};

// =========================== KARYAWAN ===========================

const accessAfterResign: Check = async (c) => {
  const rows = await prisma.user.findMany({ where: { active: true, employee: { OR: [{ status: "NONAKTIF" }, { resignDate: { lte: dateOnly(c.today) } }] } }, select: { username: true, employee: { select: { name: true, resignDate: true, status: true } } } });
  const late = await prisma.employee.findMany({ where: { status: { not: "NONAKTIF" }, resignDate: { lte: dateOnly(c.today) } }, select: { name: true, resignDate: true } });
  return issue("akses-setelah-resign", "KARYAWAN", "KRITIS", "Karyawan resign/nonaktif masih punya akses", "Akun login karyawan yang sudah keluar harus dimatikan.", [
    ...rows.map((u) => ({ label: u.employee!.name, detail: `akun ${u.username} masih aktif${u.employee!.resignDate ? ` (resign ${dateStr(u.employee!.resignDate)})` : ""}`, href: "/karyawan" })),
    ...late.map((e) => ({ label: e.name, detail: `resign ${dateStr(e.resignDate!)} tetapi status belum Nonaktif`, href: "/karyawan" })),
  ]);
};

const pendingRegistrations: Check = async (c) => {
  const rows = await prisma.employeeRegistration.findMany({ where: { status: "MENUNGGU", createdAt: { lt: daysAgo(c, STALE.registration) } }, select: { number: true, fullName: true, createdAt: true } });
  return issue("pendaftaran-menunggu", "KARYAWAN", "INFO", `Pendaftaran karyawan menunggu lebih dari ${STALE.registration} hari`, "Setujui (jadi karyawan + akun) atau tolak.",
    rows.map((r) => ({ label: r.number, detail: `${r.fullName} · ${dateStr(r.createdAt)}`, href: "/karyawan/pendaftaran" })));
};

export const CHECKS: Check[] = [
  unbalancedJournals, duplicateJournals, bookedWithoutJournal, cancelledNotReversed, cancelledDocsNotReversed, bankNegative, transitBalance, salesPaid,
  payablesVsLedger, receivablesVsLedger, prepaidVsLedger, advances, reserveFunds, mirrorOfReversed, staleDrafts, staleWdProcess, purchaseIssues, depreciationGaps,
  inventoryVsLedger, negative, unlinkedReceipts, handovers, stockRequests, unpaidBorongan, movementsWithoutRef,
  missingPayroll, doublePay, payrollAccruals, unvalidatedAttendance, missingAttendance,
  accessAfterResign, pendingRegistrations,
];

const ORDER: Record<Level, number> = { KRITIS: 0, SEDANG: 1, INFO: 2 };

/** Jalankan semua pemeriksaan. Pemeriksaan yang gagal dilaporkan sebagai masalah tersendiri (tidak menghentikan yang lain). */
export async function runConsistency(now: Date = new Date()) {
  const ctx: Ctx = { now, today: todayStr(now) };
  const out: Issue[] = [];
  for (const [i, check] of CHECKS.entries()) {
    try {
      const r = await check(ctx);
      if (r) out.push(r);
    } catch (e) {
      out.push({ key: `galat-${i}`, area: "UANG", level: "INFO", title: `Pemeriksaan ${check.name || i} gagal dijalankan`, hint: "Laporkan ke pengembang.", items: [{ label: e instanceof Error ? e.message.slice(0, 200) : String(e) }] });
    }
  }
  out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  return { at: now, checks: CHECKS.length, issues: out };
}

/** Ringkasan teks Telegram (null bila tidak ada masalah Kritis/Sedang) */
export function consistencyText(r: Awaited<ReturnType<typeof runConsistency>>, esc: (s: string) => string, url: string): string | null {
  const main = r.issues.filter((i) => i.level !== "INFO");
  if (!main.length) return null;
  return [
    `<b>🔎 Cek konsistensi harian</b>`,
    `${main.filter((i) => i.level === "KRITIS").length} kritis · ${main.filter((i) => i.level === "SEDANG").length} sedang`,
    "",
    ...main.slice(0, 12).map((i) => `${i.level === "KRITIS" ? "🔴" : "🟠"} ${esc(i.title)} (${i.items.length})`),
    "",
    `Rincian: ${url}/akuntansi/konsistensi`,
  ].join("\n");
}
