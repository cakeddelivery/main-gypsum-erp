/*
 * Koreksi sumber dana aset tetap lama (audit 10 Nov 2026). Aman diulang.
 *
 *   npm run koreksi:aset-sumber-dana                                  -> PRATINJAU saja (tidak menyimpan)
 *   npm run koreksi:aset-sumber-dana -- --jalankan                    -> menyimpan (WAJIB npm run backup dulu)
 *   npm run koreksi:aset-sumber-dana -- --jurnal=JU-202605-0002,JU-202606-0001   -> hanya jurnal perolehan ini
 *
 * Masalah: aset yang dibeli SEBELUM go-live (Setting go_live_date) didaftarkan di Akuntansi → Aset tetap dengan
 * "Sumber dana" bawaan = rekening bank pertama, sehingga saldo rekening berkurang padahal uangnya keluar sebelum
 * memakai aplikasi (sudah tercermin di saldo awal). Yang benar: kredit 3-9000 Ekuitas Saldo Awal.
 *
 * Per aset (tidak ada yang dihapus):
 *   1. jurnal perolehan lama dibalik (tanggal asli bila periodenya terbuka, kalau tidak hari ini);
 *      baris tertautnya di menu Transaksi ikut Dibatalkan;
 *   2. perolehan dibukukan ulang: Dr akun aset / Cr Ekuitas Saldo Awal, tanggal sama (sumber ASET);
 *   3. FixedAsset.journalId menunjuk jurnal baru; aset bernama "sewa" diberi umur 12 bulan & nilai sisa 0;
 *   4. penyusutan bulan-bulan yang terlewat (bulan perolehan s/d bulan lalu) dibukukan per bulan: di akhir bulannya
 *      bila periodenya terbuka, atau hari ini ("susulan") bila sudah ditutup. Kuncinya sama dengan tutup buku
 *      (<idAset>:<tahun>-<bulan>), jadi tutup buku berikutnya tidak membukukan dobel.
 */
import { prisma } from "../src/lib/db";
import { assertPeriodOpen, COA, monthlyDepreciation, postJournal, reverseJournal, type LineInput } from "../src/lib/accounting";
import { jakartaDateTime, jakartaParts, monthRange } from "../src/lib/time";

const idr = (n: number) => (n < 0 ? "-" : "") + "Rp" + Math.abs(Math.round(n)).toLocaleString("id-ID");
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
export const fixSourceId = (assetId: string) => `koreksi-aset:${assetId}`;

export type Hasil = "TIDAK_ADA" | "PRATINJAU" | "DIKOREKSI";

export async function koreksiAsetSumberDana(
  apply: boolean,
  opts: { journals?: string[]; now?: Date; log?: (s: string) => void } = {},
): Promise<{ hasil: Hasil; assets: string[]; bankDelta: Record<string, number>; depreciation: number }> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? new Date();
  const set = (await prisma.setting.findUnique({ where: { key: "go_live_date" } }))?.value;
  const goLive = set && /^\d{4}-\d{2}-\d{2}$/.test(set) ? set : "2026-10-29";
  const goLiveAt = jakartaDateTime(goLive, "00:00");
  const banks = await prisma.bankAccount.findMany();
  const bankOf = (coaId: string) => banks.find((b) => b.coaAccountId === coaId);
  const isOpen = async (d: Date) => assertPeriodOpen(prisma, d).then(() => true, () => false);

  const assets = await prisma.fixedAsset.findMany({ where: { acquiredAt: { lt: goLiveAt }, journalId: { not: null } }, orderBy: { acquiredAt: "asc" } });
  type Plan = { asset: (typeof assets)[number]; journal: Awaited<ReturnType<typeof loadJournal>>; date: Date; lines: LineInput[]; life: number; residual: number; deps: { y: number; m: number; date: Date; amount: number; late: boolean }[] };
  const loadJournal = (id: string) => prisma.journal.findUniqueOrThrow({ where: { id }, include: { lines: { include: { account: true } } } });
  const plans: Plan[] = [];
  const bankDelta: Record<string, number> = {};
  const cur = jakartaParts(now);

  for (const a of assets) {
    const j = await loadJournal(a.journalId!);
    if (opts.journals?.length && !opts.journals.includes(j.number)) continue;
    const cashCredit = j.lines.filter((l) => l.account.isCash && Number(l.credit) > 0);
    if (!cashCredit.length) continue; // sudah benar (saldo awal / hutang) atau sudah dikoreksi
    if (await prisma.journal.findFirst({ where: { reversalOfId: j.id } })) throw new Error(`${j.number} (${a.name}) sudah pernah dibalik tetapi aset masih menunjuk jurnal itu. Hentikan, kabari Claude.`);
    const date = (await isOpen(j.date)) ? j.date : now;
    const lines: LineInput[] = j.lines.map((l) =>
      l.account.isCash && Number(l.credit) > 0
        ? { accountCode: COA.EKUITAS_SALDO_AWAL, credit: Number(l.credit), memo: `Aset lama sebelum go-live (${a.name})` }
        : { accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo ?? undefined },
    );
    for (const l of cashCredit) {
      const name = bankOf(l.accountId)?.name ?? l.account.name;
      bankDelta[name] = (bankDelta[name] ?? 0) + Number(l.credit);
    }
    const sewa = /sewa/i.test(a.name);
    const life = sewa ? 12 : a.usefulLifeMonths;
    const residual = sewa ? 0 : Number(a.residual);
    // Penyusutan yang terlewat: bulan perolehan s/d bulan lalu (bulan berjalan diurus tutup buku)
    const deps: Plan["deps"] = [];
    let posted = await prisma.journal.count({ where: { source: "PENYUSUTAN", sourceId: { startsWith: `${a.id}:` } } });
    const amount = monthlyDepreciation(Number(a.cost), residual, life);
    const p = jakartaParts(a.acquiredAt);
    for (let y = p.year, m = p.month; y < cur.year || (y === cur.year && m < cur.month); m === 12 ? ((m = 1), y++) : m++) {
      if (posted >= life || amount <= 0) break;
      if (await prisma.journal.findFirst({ where: { source: "PENYUSUTAN", sourceId: `${a.id}:${y}-${m}` } })) continue;
      const end = new Date(monthRange(y, m).end.getTime() - 1000);
      const open = await isOpen(end);
      deps.push({ y, m, date: open ? end : now, amount, late: !open });
      posted++;
    }
    plans.push({ asset: a, journal: j, date, lines, life, residual, deps });
  }

  if (!plans.length) {
    const done = await prisma.journal.count({ where: { source: "ASET", sourceId: { startsWith: "koreksi-aset:" } } });
    log(done ? `= Sudah dikoreksi (${done} aset). Tidak ada yang diubah.` : "Tidak ada aset lama yang dibayar dari rekening. Tidak ada yang diubah.");
    return { hasil: "TIDAK_ADA", assets: [], bankDelta, depreciation: 0 };
  }

  const bal = async (coaId: string) => {
    const s = await prisma.journalLine.aggregate({ where: { accountId: coaId }, _sum: { debit: true, credit: true } });
    return Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0);
  };
  log(`Go-live: ${goLive}. Aset lama yang dibayar dari rekening:`);
  let depTotal = 0;
  for (const pl of plans) {
    const a = pl.asset;
    log(`\n• ${a.name} · perolehan ${ym(jakartaParts(a.acquiredAt).year, jakartaParts(a.acquiredAt).month)} · ${idr(Number(a.cost))}`);
    log(`  jurnal lama ${pl.journal.number}: ${pl.journal.lines.map((l) => `${l.account.code} ${Number(l.debit) ? "D" : "K"} ${idr(Number(l.debit) || Number(l.credit))}`).join(", ")}`);
    log(`  → dibalik & dibukukan ulang tgl ${pl.date.toISOString().slice(0, 10)}${pl.date === pl.journal.date ? "" : " (periode asli tertutup, pakai hari ini)"}: kredit ${COA.EKUITAS_SALDO_AWAL} Ekuitas Saldo Awal`);
    if (pl.life !== a.usefulLifeMonths || pl.residual !== Number(a.residual)) log(`  → umur ${a.usefulLifeMonths} → ${pl.life} bulan, nilai sisa ${idr(Number(a.residual))} → ${idr(pl.residual)}`);
    const sum = pl.deps.reduce((s, x) => s + x.amount, 0);
    depTotal += sum;
    log(`  → penyusutan ${idr(monthlyDepreciation(Number(a.cost), pl.residual, pl.life))}/bulan; susulan ${pl.deps.length} bulan = ${idr(sum)}${pl.deps.length ? ": " + pl.deps.map((x) => `${ym(x.y, x.m)}${x.late ? " (dibukukan hari ini, periode tertutup)" : ""}`).join(", ") : ""}`);
  }
  log("\nSaldo rekening (semua waktu)  sekarang → sesudah:");
  for (const [name, delta] of Object.entries(bankDelta)) {
    const b = banks.find((x) => x.name === name);
    const now0 = b ? await bal(b.coaAccountId) : 0;
    log(`  ${name}: ${idr(now0)} → ${idr(now0 + delta)} (+${idr(delta)})`);
  }
  log("Laba rugi bulan perolehan tidak berubah oleh pemindahan sumber dana; yang menambah beban hanya penyusutan susulan di atas.");
  if (!apply) return { hasil: "PRATINJAU", assets: plans.map((p) => p.asset.name), bankDelta, depreciation: depTotal };

  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" } });
  const actor = { id: owner?.id ?? "skrip", name: "skrip koreksi-aset-sumber-dana" };
  await prisma.$transaction(
    async (tx) => {
      for (const pl of plans) {
        const a = pl.asset;
        await reverseJournal(tx, pl.journal.id, pl.date, actor, `aset lama ${a.name}: sumber dana seharusnya Ekuitas Saldo Awal, bukan rekening`);
        const j = await postJournal(tx, { date: pl.date, storeId: pl.journal.storeId, description: `Perolehan aset ${a.name} (aset lama, saldo awal)`, source: "ASET", sourceId: fixSourceId(a.id), actor, lines: pl.lines });
        await tx.fixedAsset.update({ where: { id: a.id }, data: { journalId: j.id, usefulLifeMonths: pl.life, residual: BigInt(pl.residual) } });
        for (const d of pl.deps) {
          await postJournal(tx, {
            date: d.date,
            storeId: a.storeId,
            description: `Penyusutan ${a.name} ${String(d.m).padStart(2, "0")}/${d.y}${d.late ? " (susulan)" : ""}`,
            source: "PENYUSUTAN",
            sourceId: `${a.id}:${d.y}-${d.m}`,
            actor,
            lines: [
              { accountCode: COA.BEBAN_PENYUSUTAN, debit: d.amount },
              { accountCode: COA.AKUM_PENYUSUTAN, credit: d.amount },
            ],
          });
        }
      }
    },
    { timeout: 60000 },
  );
  log("\nTersimpan.");
  for (const [name] of Object.entries(bankDelta)) {
    const b = banks.find((x) => x.name === name);
    if (b) log(`  ${name} sekarang ${idr(await bal(b.coaAccountId))}`);
  }
  return { hasil: "DIKOREKSI", assets: plans.map((p) => p.asset.name), bankDelta, depreciation: depTotal };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/koreksi-aset-sumber-dana.ts")) {
  const apply = process.argv.includes("--jalankan");
  const journals = process.argv.find((a) => a.startsWith("--jurnal="))?.slice(9).split(",").map((s) => s.trim()).filter(Boolean);
  const db = new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1);
  console.log(`Database: ${db}  ·  mode: ${apply ? "JALANKAN" : "pratinjau"}\n`);
  koreksiAsetSumberDana(apply, { journals })
    .then((r) => {
      if (r.hasil === "PRATINJAU") console.log("\nIni baru PRATINJAU. Untuk menyimpan: npm run backup  lalu jalankan lagi dengan -- --jalankan");
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
