/*
 * Audit saldo rekening (HANYA MEMBACA, tidak mengubah data apa pun).
 *
 *   npm run audit:saldo                          -> semua rekening aktif, mulai 2026-11-01
 *   npm run audit:saldo -- --dari=2026-11-01     -> tanggal mulai lain
 *   npm run audit:saldo -- --asli=5984:1802900,0006:3100009,shopeepay:800725
 *                                                -> bandingkan dengan saldo asli (cocokkan potongan kode/nama rekening)
 *
 * Isi laporan per rekening:
 *   - saldo buku sebelum tanggal mulai (= saldo awal di aplikasi)
 *   - semua baris jurnal di akun COA rekening tsb, urut tanggal, dengan saldo berjalan,
 *     sumber (FINANCE/SISIHAN/SALDO_AWAL/WITHDRAW_PENJUALAN/...), nomor transaksi & kapan diinput
 *   - tanda bahaya: transaksi bertanggal ≤ tanggal saldo awal tapi diinput SETELAH saldo awal diatur,
 *     jurnal ganda, transaksi dibukukan tanpa jurnal, transaksi dibatalkan tanpa jurnal balik, dll.
 * Laporan juga disimpan ke file audit-saldo-<tanggal>.txt di folder aplikasi.
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { activeDuplicateJournals } from "../src/lib/auditChecks";

const prisma = new PrismaClient();
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const from = arg("dari") ?? "2026-11-01";
const start = new Date(`${from}T00:00:00+07:00`);
const actualArg = (arg("asli") ?? "").split(",").filter(Boolean).map((p) => {
  const [k, v] = p.split(":");
  return { key: k.toLowerCase(), value: Number(v.replace(/\D/g, "")) };
});

const out: string[] = [];
const log = (s = "") => {
  out.push(s);
  console.log(s);
};
const idr = (n: number) => (n < 0 ? "-" : "") + "Rp" + Math.abs(n).toLocaleString("id-ID");
const wib = (d: Date) => d.toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }).slice(0, 16);
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const lpad = (s: string, n: number) => s.padStart(n);

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  log(`AUDIT SALDO REKENING · database ${db} · mulai ${from} · dibuat ${wib(new Date())} WIB`);
  log("Hanya membaca data, tidak ada yang diubah.\n");

  const banks = await prisma.bankAccount.findMany({ include: { coaAccount: true }, orderBy: { code: "asc" } });
  const txs = await prisma.financeTransaction.findMany({ select: { id: true, number: true, journalId: true, status: true, direction: true, amount: true, date: true, accountId: true, toAccountId: true, deletedAt: true, createdAt: true, note: true, counterparty: true, fingerprint: true } });
  const txByJournal = new Map(txs.filter((t) => t.journalId).map((t) => [t.journalId!, t]));
  const txById = new Map(txs.map((t) => [t.id, t]));

  // 1. Pemetaan rekening ↔ COA
  log("== 1. REKENING & AKUN COA ==");
  const coaUse = new Map<string, string[]>();
  for (const b of banks) coaUse.set(b.coaAccountId, [...(coaUse.get(b.coaAccountId) ?? []), b.name]);
  for (const b of banks) {
    const shared = (coaUse.get(b.coaAccountId) ?? []).length > 1;
    log(`  ${pad(b.code, 16)} ${pad(b.name, 26)} COA ${b.coaAccount.code} ${b.coaAccount.name}${b.active ? "" : " [NONAKTIF]"}${b.marketplace ? " [saldo penjual]" : ""}${b.coaAccount.isCash ? "" : " [COA bukan kas!]"}${shared ? "  ⚠ COA DIPAKAI >1 REKENING" : ""}`);
  }
  const cashCoa = await prisma.coaAccount.findMany({ where: { isCash: true } });
  for (const c of cashCoa.filter((c) => !coaUse.has(c.id))) {
    const s = await prisma.journalLine.aggregate({ where: { accountId: c.id }, _sum: { debit: true, credit: true } });
    const bal = Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
    if (bal) log(`  ⚠ Akun kas ${c.code} ${c.name} tidak terhubung ke rekening mana pun, saldonya ${idr(bal)}`);
  }

  // 2. Penyesuaian saldo awal
  log("\n== 2. JURNAL SALDO AWAL / PENYESUAIAN SALDO ==");
  const opening = await prisma.journal.findMany({ where: { source: "SALDO_AWAL", lines: { some: { accountId: { in: banks.map((b) => b.coaAccountId) } } } }, include: { lines: { include: { account: true } } }, orderBy: { createdAt: "asc" } });
  if (!opening.length) log("  (tidak ada)");
  for (const j of opening) {
    log(`  ${j.number} tgl ${wib(j.date)} · diinput ${wib(j.createdAt)} oleh ${j.createdBy} · ${j.description}`);
    for (const l of j.lines.filter((l) => coaUse.has(l.accountId))) log(`      ${pad(l.account.name, 26)} ${l.debit ? "+" + idr(Number(l.debit)) : "-" + idr(Number(l.credit))}  ${l.memo ?? ""}`);
  }

  // 3. Mutasi per rekening
  log("\n== 3. MUTASI PER REKENING ==");
  const summary: string[] = [];
  for (const b of banks.filter((b) => b.active)) {
    const before = await prisma.journalLine.aggregate({ where: { accountId: b.coaAccountId, journal: { date: { lt: start } } }, _sum: { debit: true, credit: true } });
    const open = Number(before._sum.debit ?? 0) - Number(before._sum.credit ?? 0);
    const lines = await prisma.journalLine.findMany({ where: { accountId: b.coaAccountId, journal: { date: { gte: start } } }, include: { journal: true }, orderBy: [{ journal: { date: "asc" } }, { journal: { createdAt: "asc" } }] });
    const lastOpening = opening.filter((j) => j.lines.some((l) => l.accountId === b.coaAccountId)).at(-1);
    // Atur saldo memakai saldo buku sampai AKHIR hari yang dipilih: transaksi s/d hari itu yang sudah ada saat itu ikut "terserap"
    const cutoff = lastOpening ? new Date(new Date(`${wib(lastOpening.date).slice(0, 10)}T00:00:00+07:00`).getTime() + 86400000) : null;
    log(`\n### ${b.name} (COA ${b.coaAccount.code})`);
    log(`Saldo buku sebelum ${from}: ${idr(open)}`);
    log(`${pad("Tanggal", 16)} ${pad("Jurnal", 15)} ${pad("Sumber", 18)} ${pad("Transaksi", 16)} ${lpad("Masuk", 13)} ${lpad("Keluar", 13)} ${lpad("Saldo", 14)}  Diinput           Keterangan`);
    let bal = open;
    let inSum = 0;
    let outSum = 0;
    const bySource = new Map<string, number>();
    for (const l of lines) {
      const dr = Number(l.debit);
      const cr = Number(l.credit);
      bal += dr - cr;
      inSum += dr;
      outSum += cr;
      const j = l.journal;
      bySource.set(j.source, (bySource.get(j.source) ?? 0) + dr - cr);
      const t = txByJournal.get(j.id) ?? (j.sourceId ? txById.get(j.sourceId) : undefined);
      const flags: string[] = [];
      if (j.reversalOfId) flags.push("PEMBALIK");
      if (t && t.status !== "DIBUKUKAN") flags.push(`trx ${t.status}`);
      if (lastOpening && cutoff && j.id !== lastOpening.id && j.date < cutoff) {
        flags.push(j.createdAt > lastOpening.createdAt ? "⚠ TGL ≤ HARI SALDO AWAL, DIINPUT SESUDAH SALDO DIATUR (terhitung 2x?)" : "terserap saldo awal (diinput sebelum saldo diatur)");
      }
      const desc = (t ? [t.counterparty, t.note].filter(Boolean).join(" · ") : "") || j.description;
      log(`${pad(wib(j.date), 16)} ${pad(j.number, 15)} ${pad(j.source, 18)} ${pad(t?.number ?? "", 16)} ${lpad(dr ? idr(dr) : "", 13)} ${lpad(cr ? idr(cr) : "", 13)} ${lpad(idr(bal), 14)}  ${wib(j.createdAt)}  ${desc.replace(/\s+/g, " ").slice(0, 70)}${flags.length ? "  [" + flags.join("; ") + "]" : ""}`);
    }
    log(`Total masuk ${idr(inSum)} · keluar ${idr(outSum)} · SALDO BUKU AKHIR ${idr(bal)}`);
    log(`Per sumber: ${[...bySource].map(([s, v]) => `${s} ${idr(v)}`).join(" · ") || "-"}`);
    const real = actualArg.find((a) => b.code.toLowerCase().includes(a.key) || b.name.toLowerCase().replace(/\s/g, "").includes(a.key));
    summary.push(`  ${pad(b.name, 26)} buku ${lpad(idr(bal), 14)}${real ? `   asli ${lpad(idr(real.value), 14)}   selisih (buku-asli) ${idr(bal - real.value)}` : ""}`);
  }

  // 4. Pemeriksaan transaksi
  log("\n== 4. PEMERIKSAAN TRANSAKSI ==");
  const live = txs.filter((t) => !t.deletedAt && t.date >= start);
  const noJournal = live.filter((t) => t.status === "DIBUKUKAN" && !t.journalId);
  log(`Dibukukan tanpa jurnal (tidak memengaruhi saldo!): ${noJournal.length}`);
  for (const t of noJournal) log(`  ${t.number} ${wib(t.date)} ${t.direction} ${idr(Number(t.amount))} ${t.note ?? ""}`);
  const pending = live.filter((t) => ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"].includes(t.status));
  log(`Belum dibukukan (draft / perlu ditinjau / menunggu konfirmasi): ${pending.length}`);
  for (const t of pending) log(`  ${t.number} ${wib(t.date)} ${t.status} ${t.direction} ${idr(Number(t.amount))} ${t.note ?? ""}`);
  const cancelled = txs.filter((t) => t.status === "DIBATALKAN" && t.journalId);
  let unrev = 0;
  for (const t of cancelled) {
    const rev = await prisma.journal.findFirst({ where: { reversalOfId: t.journalId! } });
    if (!rev) {
      unrev++;
      log(`  ⚠ ${t.number} dibatalkan tapi jurnalnya belum dibalik`);
    }
  }
  log(`Dibatalkan tanpa jurnal balik: ${unrev}`);
  const groups = new Map<string, typeof live>();
  for (const t of live.filter((t) => t.status === "DIBUKUKAN")) {
    const k = `${t.direction}|${t.amount}|${t.accountId}|${t.toAccountId}|${wib(t.date).slice(0, 10)}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const dups = [...groups.values()].filter((g) => g.length > 1);
  log(`Kemungkinan dobel (arah, nominal, rekening & tanggal sama): ${dups.length} kelompok`);
  for (const g of dups) log(`  ${g.map((t) => t.number).join(", ")} · ${g[0].direction} ${idr(Number(g[0].amount))} ${wib(g[0].date).slice(0, 10)} · ${g.map((t) => t.note ?? t.counterparty ?? "").join(" | ").slice(0, 80)}`);
  // Jurnal yang sudah dibalik (ganti toko, ubah kategori, batal & catat ulang) tidak dihitung; hanya sumber "satu jurnal"
  // per dokumen, ditambah pemasukan penjualan withdraw yang tercatat lebih dari sekali
  const multiJ = await activeDuplicateJournals(prisma, start);
  log(`Jurnal ganda yang masih aktif untuk sumber yang sama: ${multiJ.length}`);
  for (const m of multiJ) log(`  ⚠ ${m.kind === "PENJUALAN_WD" ? "Pemasukan penjualan withdraw dobel" : m.source} ${txById.get(m.sourceId)?.number ?? m.sourceId}: ${m.numbers.join(", ")}`);

  log("\n== 5. RINGKASAN ==");
  for (const s of summary) log(s);

  const file = `audit-saldo-${new Date().toISOString().slice(0, 10)}.txt`;
  writeFileSync(file, out.join("\n") + "\n");
  console.log(`\nLaporan disimpan: ${process.cwd()}/${file}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
