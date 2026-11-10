/*
 * Audit menu Akuntansi (HANYA MEMBACA, tidak mengubah data apa pun). Hanya memakai @prisma/client.
 *
 *   npx tsx scripts/audit-akuntansi.ts                         -> periode 1 bulan berjalan s/d hari ini
 *   npx tsx scripts/audit-akuntansi.ts --dari=2026-11-01 --sampai=2026-11-10
 *
 * Isi: rekonsiliasi arus kas (kenapa awal + kenaikan ≠ akhir), jurnal kas sebelum periode, neraca saldo,
 * neraca, laba rugi + HPP, piutang/hutang vs saldo akun, aset tetap vs akun 1-2xxx, persediaan vs akun,
 * COA (akun nonaktif bersaldo, akun kas tanpa rekening), status periode, jurnal sumber lain yang dibalik manual.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const idr = (n: number) => (n < 0 ? "-" : "") + "Rp" + Math.abs(Math.round(n)).toLocaleString("id-ID");
const wib = (d: Date) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const at = (s: string) => new Date(`${s}T00:00:00+07:00`);
const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const FROM = arg("dari") ?? `${today.slice(0, 8)}01`;
const TO = arg("sampai") ?? today;
const START = at(FROM);
const END = new Date(at(TO).getTime() + 86400e3);
const h = (t: string) => console.log(`\n==== ${t} ====`);

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db} · periode ${FROM} s/d ${TO} · BACA-SAJA`);
  const accounts = await prisma.coaAccount.findMany({ orderBy: { code: "asc" } });
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const cashIds = new Set(accounts.filter((a) => a.isCash).map((a) => a.id));

  // ---------- 1. ARUS KAS ----------
  h("1. ARUS KAS");
  const cashSum = async (where: object) => {
    const s = await prisma.journalLine.aggregate({ where: { accountId: { in: [...cashIds] }, journal: where }, _sum: { debit: true, credit: true } });
    return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
  };
  const opening = await cashSum({ date: { lt: START } });
  const closing = await cashSum({ date: { lt: END } });
  console.log(`Akun kas (isCash): ${accounts.filter((a) => a.isCash).map((a) => `${a.code} ${a.name}${a.active ? "" : " [NONAKTIF]"}`).join(", ")}`);
  const js = await prisma.journal.findMany({ where: { date: { gte: START, lt: END } }, include: { lines: true }, orderBy: [{ date: "asc" }, { number: "asc" }] });
  const byId = new Map(js.map((j) => [j.id, j]));
  const all = await prisma.journal.findMany({ select: { id: true, number: true, source: true, date: true } });
  const allById = new Map(all.map((j) => [j.id, j]));
  let counted = 0;
  let saldoAwal = 0;
  let pembalikSaldoAwal = 0;
  let pairs = 0;
  const excluded: string[] = [];
  const revOfSA: string[] = [];
  for (const j of js) {
    const net = j.lines.filter((l) => cashIds.has(l.accountId)).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    if (!net) continue;
    if (j.source === "SALDO_AWAL") {
      saldoAwal += net;
      excluded.push(`  ${wib(j.date)} ${j.number} ${idr(net)} · ${j.description}`);
      continue;
    }
    counted += net;
    const orig = j.reversalOfId ? allById.get(j.reversalOfId) : null;
    if (orig?.source === "SALDO_AWAL") {
      pembalikSaldoAwal += net;
      revOfSA.push(`  ${wib(j.date)} ${j.number} ${idr(net)} · ${j.description} (asli ${orig.number} ${wib(orig.date)})`);
    }
    if (j.reversalOfId && byId.has(j.reversalOfId)) pairs++;
  }
  console.log(`Saldo kas awal (sebelum ${FROM})    : ${idr(opening)}`);
  console.log(`Kenaikan kas versi laporan Arus Kas  : ${idr(counted)}  (tanpa jurnal SALDO_AWAL)`);
  console.log(`Jurnal SALDO_AWAL di periode (dibuang): ${idr(saldoAwal)}`);
  console.log(`Saldo kas akhir (s/d ${TO})         : ${idr(closing)}`);
  console.log(`Cek: awal + kenaikan + SALDO_AWAL = ${idr(opening + counted + saldoAwal)} → ${opening + counted + saldoAwal === closing ? "COCOK dengan akhir" : "TIDAK cocok"}`);
  console.log(`Selisih tampilan sekarang (akhir − awal − kenaikan) = ${idr(closing - opening - counted)}`);
  console.log(`Pembalik dari jurnal SALDO_AWAL yang ikut dihitung sebagai arus kas: ${idr(pembalikSaldoAwal)}`);
  revOfSA.forEach((x) => console.log(x));
  console.log(`Pasangan asli+pembalik sama-sama di periode (tampil 2 baris di Arus Kas): ${pairs}`);
  console.log("Jurnal SALDO_AWAL yang menyentuh kas di periode:");
  excluded.forEach((x) => console.log(x));

  h(`1b. JURNAL KAS SEBELUM ${FROM} (penyebab saldo awal)`);
  const before = await prisma.journal.findMany({ where: { date: { lt: START }, lines: { some: { accountId: { in: [...cashIds] } } } }, include: { lines: true }, orderBy: { date: "asc" } });
  let run = 0;
  for (const j of before) {
    const net = j.lines.filter((l) => cashIds.has(l.accountId)).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    if (!net) continue;
    run += net;
    console.log(`  ${wib(j.date)} ${j.number} [${j.source}] ${idr(net)} → ${idr(run)} · ${j.description.slice(0, 70)} (input ${wib(j.createdAt)})`);
  }

  // ---------- 2. NERACA SALDO & NERACA ----------
  const sums = await prisma.journalLine.groupBy({ by: ["accountId"], where: { journal: { date: { lt: END } } }, _sum: { debit: true, credit: true } });
  const net = new Map(sums.map((s) => [s.accountId, Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0)]));
  h(`2. NERACA SALDO per ${TO}`);
  let td = 0;
  let tc = 0;
  for (const a of accounts) {
    const n = net.get(a.id) ?? 0;
    if (!n) continue;
    if (n > 0) td += n; else tc -= n;
    console.log(`  ${a.code.padEnd(7)} ${a.name.slice(0, 40).padEnd(40)} ${a.type.padEnd(10)} ${(n > 0 ? idr(n) : "").padStart(15)} ${(n < 0 ? idr(-n) : "").padStart(15)}${a.active ? "" : "  [NONAKTIF]"}`);
  }
  console.log(`  TOTAL debit ${idr(td)} · kredit ${idr(tc)} → ${td === tc ? "seimbang" : "TIDAK SEIMBANG"}`);
  const byType = (t: string) => accounts.filter((a) => a.type === t).reduce((s, a) => s + (net.get(a.id) ?? 0), 0);
  const aset = byType("ASET");
  const kew = -byType("KEWAJIBAN");
  const eku = -byType("EKUITAS");
  const laba = -(byType("PENDAPATAN") + byType("HPP") + byType("BEBAN"));
  h("3. NERACA");
  console.log(`  Aset ${idr(aset)} · Kewajiban ${idr(kew)} · Ekuitas ${idr(eku)} · Laba berjalan (semua periode) ${idr(laba)}`);
  console.log(`  Aset − (Kewajiban + Ekuitas + Laba) = ${idr(aset - kew - eku - laba)}`);

  // ---------- 4. LABA RUGI ----------
  h(`4. LABA RUGI ${FROM} s/d ${TO}`);
  const pl = await prisma.journalLine.groupBy({ by: ["accountId"], where: { journal: { date: { gte: START, lt: END } } }, _sum: { debit: true, credit: true } });
  for (const t of ["PENDAPATAN", "HPP", "BEBAN"]) {
    let tot = 0;
    console.log(`  [${t}]`);
    for (const s of pl) {
      const a = acc.get(s.accountId)!;
      if (a.type !== t) continue;
      const v = (Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0)) * (t === "PENDAPATAN" ? -1 : 1);
      if (!v) continue;
      tot += v;
      console.log(`    ${a.code} ${a.name}: ${idr(v)}`);
    }
    console.log(`    total ${idr(tot)}`);
  }
  const sales = await prisma.sale.findMany({ where: { date: { gte: START, lt: END } }, include: { lines: true } }).catch(() => []);
  const saleHpp = sales.filter((s) => !("cancelledAt" in s && s.cancelledAt)).flatMap((s) => s.lines).reduce((x, l) => x + Number(l.qty) * Number(l.unitCost), 0);
  console.log(`  Penjualan offline (menu Penjualan): ${sales.length} nota, HPP tercatat per nota ${idr(saleHpp)}`);
  const fg = await prisma.item.findMany({ where: { type: "BARANG_JADI" } });
  console.log(`  Barang jadi: ${fg.length} item, ${fg.filter((i) => Number(i.avgCost) === 0).length} item harga pokok (avgCost) = 0 → HPP per penjualan Rp0`);
  const sel = await prisma.journal.groupBy({ by: ["source"], where: { date: { gte: START, lt: END }, lines: { some: { account: { code: "6-1800" } } } }, _count: true });
  console.log(`  Jurnal ke 6-1800 (Beban Reject & Selisih) per sumber: ${sel.map((s) => `${s.source}=${s._count}`).join(", ") || "-"}`);

  // ---------- 5. PIUTANG / HUTANG ----------
  h("5. PIUTANG & HUTANG vs SALDO AKUN (semua waktu)");
  const gl = (code: string) => { const a = accounts.find((x) => x.code === code); return a ? net.get(a.id) ?? 0 : 0; };
  const recv = await prisma.receivable.findMany();
  console.log(`  Piutang dokumen sisa ${idr(recv.reduce((s, r) => s + Number(r.amount - r.paid), 0))} vs akun 1-1300 ${idr(gl("1-1300"))}`);
  const pays = await prisma.payable.findMany();
  const defUsaha = accounts.find((a) => a.code === "2-1100")!.id;
  const defPinj = accounts.find((a) => a.code === "2-1400")!.id;
  const docByAcc = new Map<string, number>();
  for (const p of pays) {
    const id = p.coaAccountId ?? (p.kind === "PINJAMAN" ? defPinj : defUsaha);
    docByAcc.set(id, (docByAcc.get(id) ?? 0) + Number(p.amount - p.paid));
  }
  for (const a of accounts.filter((x) => x.type === "KEWAJIBAN")) {
    const doc = docByAcc.get(a.id) ?? 0;
    const g = -(net.get(a.id) ?? 0);
    if (doc || g) console.log(`  ${a.code} ${a.name}: dokumen sisa ${idr(doc)} vs akun ${idr(g)}${doc === g ? "" : `  ← selisih ${idr(g - doc)}`}`);
  }

  // ---------- 6. ASET TETAP ----------
  h("6. ASET TETAP");
  const fa = await prisma.fixedAsset.findMany();
  const faCost = fa.reduce((s, a) => s + Number(a.cost), 0);
  const glFa = accounts.filter((a) => a.code.startsWith("1-2") && a.code !== "1-2900").reduce((s, a) => s + (net.get(a.id) ?? 0), 0);
  console.log(`  ${fa.length} aset di menu Aset, harga ${idr(faCost)} vs saldo akun 1-2xxx ${idr(glFa)} · akumulasi penyusutan ${idr(-gl("1-2900"))}`);

  // ---------- 7. PERSEDIAAN ----------
  h("7. PERSEDIAAN: nilai stok (qty × harga rata-rata) vs akun");
  const items = await prisma.item.findMany();
  const mv = await prisma.stockMovement.groupBy({ by: ["itemId", "fromLocationId", "toLocationId"], _sum: { qty: true } });
  const qty = new Map<string, number>();
  for (const m of mv) {
    const q = Number(m._sum.qty ?? 0);
    const sgn = m.toLocationId && !m.fromLocationId ? 1 : !m.toLocationId && m.fromLocationId ? -1 : 0;
    qty.set(m.itemId, (qty.get(m.itemId) ?? 0) + q * sgn);
  }
  for (const [t, code] of [["BAHAN_BAKU", "1-1401"], ["BARANG_DALAM_PROSES", "1-1402"], ["BARANG_JADI", "1-1403"]] as const) {
    const its = items.filter((i) => i.type === t);
    const v = its.reduce((s, i) => s + Math.round((qty.get(i.id) ?? 0) * Number(i.avgCost)), 0);
    const neg = its.filter((i) => (qty.get(i.id) ?? 0) < -0.0005).length;
    console.log(`  ${t}: stok ${idr(v)} vs akun ${code} ${idr(gl(code))} (selisih ${idr(gl(code) - v)}; ${neg} item stok minus)`);
  }

  // ---------- 8. COA ----------
  h("8. COA");
  for (const a of accounts) {
    const n = net.get(a.id) ?? 0;
    if (!a.active && n) console.log(`  NONAKTIF tapi bersaldo: ${a.code} ${a.name} ${idr(n)}`);
  }
  const banks = await prisma.bankAccount.findMany();
  for (const a of accounts.filter((x) => x.isCash)) {
    const b = banks.filter((x) => x.coaAccountId === a.id);
    if (b.length !== 1) console.log(`  Akun kas ${a.code} ${a.name}: terhubung ke ${b.length} rekening${b.length ? ` (${b.map((x) => x.name).join(", ")})` : ""}`);
  }
  const names = new Map<string, string[]>();
  accounts.forEach((a) => names.set(a.name.toLowerCase(), [...(names.get(a.name.toLowerCase()) ?? []), a.code]));
  for (const [n, c] of names) if (c.length > 1) console.log(`  Nama akun ganda: "${n}" → ${c.join(", ")}`);
  for (const a of accounts) {
    const digit = { ASET: "1", KEWAJIBAN: "2", EKUITAS: "3", PENDAPATAN: "4", HPP: "5", BEBAN: "6" }[a.type];
    if (!a.code.startsWith(`${digit}-`)) console.log(`  Kode tidak cocok tipe: ${a.code} ${a.name} (${a.type})`);
  }

  // ---------- 9. PERIODE ----------
  h("9. STATUS PERIODE");
  for (const p of await prisma.accountingPeriod.findMany({ orderBy: [{ year: "asc" }, { month: "asc" }] })) console.log(`  ${p.year}-${String(p.month).padStart(2, "0")} ${p.status} ${p.closedAt ? wib(p.closedAt) : ""} ${p.closedBy ?? ""}`);
  const first = await prisma.journal.findFirst({ orderBy: { date: "asc" } });
  console.log(`  Jurnal pertama: ${first ? `${first.number} ${wib(first.date)}` : "-"}`);

  // ---------- 10. PEMBALIK MANUAL DARI JURNAL UMUM ----------
  h("10. JURNAL SUMBER LAIN YANG DIBALIK LEWAT TOMBOL 'BALIK' (alasan bukan dari menu sumber)");
  const revs = await prisma.journal.findMany({ where: { reversalOfId: { not: null } } });
  const origs = new Map((await prisma.journal.findMany({ where: { id: { in: revs.map((r) => r.reversalOfId!) } } })).map((o) => [o.id, o]));
  const auto = /^Pembalik JU-[\d-]+: (batal |ubah pencatatan|ganti toko|sinkron|sisihan|Entri produksi dihapus|Setoran borongan dihapus|salah dasar)/;
  for (const r of revs) {
    const o = origs.get(r.reversalOfId!)!;
    if (o.source === "MANUAL" || o.source === "PENYESUAIAN" || auto.test(r.description)) continue;
    console.log(`  ${r.number} ${wib(r.date)} oleh ${r.createdBy}: balik ${o.number} [${o.source} ${o.sourceId ?? ""}] · ${r.description.slice(0, 80)}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
