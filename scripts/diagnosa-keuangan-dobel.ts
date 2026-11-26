/*
 * DIAGNOSA temuan ganda Keuangan (HANYA MEMBACA). Mencetak detail lengkap per pasangan agar owner bisa memutuskan
 * mana yang benar-benar dobel dan mana yang sah. Pasangan dipilih dengan aturan yang sama seperti audit-duplikat-keuangan.ts.
 *
 *   npx tsx scripts/diagnosa-keuangan-dobel.ts            -> semua bagian (maks 30 pasangan per bagian)
 *   npx tsx scripts/diagnosa-keuangan-dobel.ts --semua    -> tanpa batas
 *   npx tsx scripts/diagnosa-keuangan-dobel.ts --trx=TRX-202611-0133,TRX-202611-0134   -> hanya transaksi tsb (dan kembarannya)
 *
 * Kolom "Penilaian" hanya saran otomatis, keputusan tetap di tangan owner.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ALL = process.argv.includes("--semua");
const ONLY = process.argv.find((a) => a.startsWith("--trx="))?.slice(6).split(",").filter(Boolean);
const LIMIT = ALL ? 100000 : 30;
const idr = (n: unknown) => "Rp" + Number(n).toLocaleString("id-ID");
const wib = (d: Date | null | undefined) => (d ? new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 19).replace("T", " ") : "-");
const h = (t: string) => console.log(`\n==== ${t} ====`);

async function tx(number: string) {
  const t = await prisma.financeTransaction.findUniqueOrThrow({
    where: { number },
    include: { store: true, approvals: { orderBy: { at: "asc" } }, reserveEntries: { include: { fund: true } } },
  } as never) as never as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const [account, toAccount, category] = await Promise.all([
    t.accountId ? prisma.bankAccount.findUnique({ where: { id: t.accountId } }) : null,
    t.toAccountId ? prisma.bankAccount.findUnique({ where: { id: t.toAccountId } }) : null,
    t.categoryId ? prisma.txCategory.findUnique({ where: { id: t.categoryId } }) : null,
  ]);
  Object.assign(t, { account, toAccount, category });
  const j = t.journalId ? await prisma.journal.findUnique({ where: { id: t.journalId }, include: { lines: { include: { account: true } } } }) : null;
  const rev = j ? await prisma.journal.findFirst({ where: { reversalOfId: j.id }, select: { number: true } }) : null;
  return { t, j, rev };
}

async function show(label: string, number: string) {
  const { t, j, rev } = await tx(number);
  console.log(`  ${label} ${t.number} · ${t.status} · ${t.source}${t.origin ? ` · asal ${t.origin}` : ""}`);
  console.log(`     tanggal ${wib(t.date)} WIB · dibuat ${wib(t.createdAt)} oleh ${t.createdBy} · ${idr(t.amount)} · toko ${t.store?.code ?? "-"}`);
  console.log(`     ${t.direction}: ${t.account?.name ?? "-"}${t.toAccount ? ` → ${t.toAccount.name}` : ""}${t.category ? ` · kategori ${t.category.name}` : ""}`);
  console.log(`     catatan: ${t.note ?? "-"} · pihak: ${t.counterparty ?? "-"} · ref WD: ${t.withdrawRef ?? "-"} · telegram msg: ${t.telegramMessageId ?? "-"} · idempotensi: ${t.idempotencyKey ?? "-"}`);
  console.log(`     duplicateOf: ${t.duplicateOfId ?? "-"} · dupAck: ${(t.dupAckIds ?? []).length ? t.dupAckIds.join(",") : "-"} · bukti: ${t.proofPath ? "ada" : "tidak"}`);
  console.log(`     jurnal: ${j ? `${j.number}${rev ? ` (sudah dibalik: ${rev.number})` : ""} — ${j.lines.map((l: any) => `${l.account.code} ${Number(l.debit) ? "D" + Number(l.debit) : "K" + Number(l.credit)}`).join(", ")}` : "-"}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (t.reserveEntries?.length) console.log(`     dana sisihan tertaut: ${t.reserveEntries.map((e: any) => `${e.fund.name} (${e.type} ${idr(e.amount)} ${e.date.toISOString().slice(0, 10)})`).join("; ")}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  console.log(`     riwayat: ${t.approvals.map((a: any) => `${a.action}@${wib(a.at)} ${a.actorName}`).join(" → ")}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  return t;
}

function judge(a: Record<string, any>, b: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const fa = new Set((a.reserveEntries ?? []).map((e: any) => e.fundId)); // eslint-disable-line @typescript-eslint/no-explicit-any
  const fb = new Set((b.reserveEntries ?? []).map((e: any) => e.fundId)); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (fa.size && fb.size && ![...fa].some((x) => fb.has(x))) return "KEMUNGKINAN SAH: tertaut ke dana sisihan BERBEDA (dua dana, nominal harian sama)";
  if (a.telegramMessageId && b.telegramMessageId && a.telegramMessageId !== b.telegramMessageId) return "PERLU DICEK: dua pesan Telegram berbeda (bisa dua kiriman sungguhan, bisa kirim ulang)";
  if (a.proofPath && b.proofPath && a.proofPath !== b.proofPath) return "PERLU DICEK: bukti berbeda";
  if (a.source !== b.source) return `KEMUNGKINAN DOBEL: sumber berbeda (${a.source} vs ${b.source}), mis. dicatat bot lalu dicatat lagi manual`;
  return "KEMUNGKINAN DOBEL: nominal, rekening, catatan sama dalam hitungan menit tanpa tanda pembeda";
}

async function pairs(title: string, rows: { a: string; b: string }[]) {
  h(`${title} — ${rows.length} pasangan`);
  for (const [i, r] of rows.slice(0, LIMIT).entries()) {
    if (ONLY && !ONLY.includes(r.a) && !ONLY.includes(r.b)) continue;
    console.log(`\n#${i + 1}`);
    const a = await show("A", r.a);
    const b = await show("B", r.b);
    console.log(`  ▶ Penilaian: ${judge(a, b)}`);
    console.log(`  ▶ Bila dobel, batalkan SATU (biasanya yang terbaru, ${b.number}): npx tsx scripts/batalkan-transaksi-dobel.ts --nomor=${b.number} [--jalankan]`);
  }
}

async function main() {
  console.log(`Database: ${new URL(process.env.DATABASE_URL ?? "postgresql://x/x").pathname.slice(1)} · BACA-SAJA`);

  await pairs("A. TRANSFER KEMBAR (rekening, nominal, catatan sama, <3 menit)", await prisma.$queryRaw<{ a: string; b: string }[]>`
    SELECT a.number a, b.number b FROM "FinanceTransaction" a JOIN "FinanceTransaction" b ON b.id>a.id AND b.direction=a.direction AND b."accountId"=a."accountId" AND b."toAccountId" IS NOT DISTINCT FROM a."toAccountId" AND b.amount=a.amount
      AND b.note IS NOT DISTINCT FROM a.note AND b.counterparty IS NOT DISTINCT FROM a.counterparty AND ABS(EXTRACT(EPOCH FROM (b.date-a.date)))<180
    WHERE a.direction='TRANSFER' AND a.status NOT IN ('DITOLAK','DIBATALKAN') AND b.status NOT IN ('DITOLAK','DIBATALKAN') AND a."deletedAt" IS NULL AND b."deletedAt" IS NULL
      AND NOT (a.id = ANY(b."dupAckIds") OR b.id = ANY(a."dupAckIds")) ORDER BY a.number`);

  await pairs("B. TRANSAKSI DIBUKUKAN DOBEL (sidik jari, catatan, pembuat sama, <3 menit)", await prisma.$queryRaw<{ a: string; b: string }[]>`
    SELECT a.number a, b.number b FROM "FinanceTransaction" a JOIN "FinanceTransaction" b ON b.id>a.id AND b.fingerprint=a.fingerprint AND b.note IS NOT DISTINCT FROM a.note AND b."createdBy"=a."createdBy"
      AND ABS(EXTRACT(EPOCH FROM (b."createdAt"-a."createdAt")))<180
    WHERE a.direction<>'TRANSFER' AND a.status='DIBUKUKAN' AND b.status='DIBUKUKAN' AND a."deletedAt" IS NULL AND b."deletedAt" IS NULL
      AND NOT (a.id = ANY(b."dupAckIds") OR b.id = ANY(a."dupAckIds")) ORDER BY a.number`);

  h("C. SISIHAN HARIAN GANDA (dana & tanggal sama)");
  const sis = await prisma.$queryRaw<{ fundId: string; d: string; n: number }[]>`SELECT "fundId", date::text d, COUNT(*)::int n FROM "ReserveEntry" WHERE type='SISIH' GROUP BY "fundId", date HAVING COUNT(*)>1 ORDER BY date`;
  console.log(sis.length ? "" : "  tidak ada");
  for (const r of sis.slice(0, LIMIT)) {
    const es = await prisma.reserveEntry.findMany({ where: { fundId: r.fundId, type: "SISIH", date: new Date(`${r.d.slice(0, 10)}T00:00:00Z`) }, include: { fund: true }, orderBy: { createdAt: "asc" } });
    console.log(`  ${es[0]?.fund.name} ${r.d.slice(0, 10)} ×${r.n}`);
    for (const e of es) console.log(`     ${e.id} ${idr(e.amount)} dibuat ${wib(e.createdAt)} oleh ${e.createdBy} jurnal ${e.journalId ?? "-"} transaksi ${e.transactionId ?? "-"}`);
  }

  h("D. PENARIKAN MARKETPLACE KEMBAR (nominal>0, waktu sama, refId beda)");
  const wd = await prisma.$queryRaw<{ storeId: string; channel: string; txType: string; amount: bigint; requestedAt: Date; doneAt: Date | null; n: number }[]>`
    SELECT "storeId", channel, "txType", amount, "requestedAt", "doneAt", COUNT(*)::int n FROM "MarketplaceWithdrawal" WHERE "requestedAt" IS NOT NULL AND amount>0 AND "txType" ILIKE 'withdraw%'
    GROUP BY "storeId", channel, "txType", amount, "requestedAt", "doneAt" HAVING COUNT(*)>1`;
  console.log(wd.length ? "" : "  tidak ada");
  for (const r of wd.slice(0, LIMIT)) {
    const rows = await prisma.marketplaceWithdrawal.findMany({ where: { storeId: r.storeId, channel: r.channel, txType: r.txType, amount: r.amount, requestedAt: r.requestedAt }, include: { } as never });
    console.log(`  ${r.channel} ${idr(r.amount)} diminta ${wib(r.requestedAt)} ×${r.n}`);
    for (const w of rows) {
      const imp = await prisma.marketplaceImport.findUnique({ where: { id: w.importId }, select: { fileName: true, createdAt: true, createdBy: true, undoneAt: true } });
      console.log(`     refId ${w.refId} · status ${w.status ?? "-"} · selesai ${wib(w.doneAt)} · file "${imp?.fileName}" diunggah ${wib(imp?.createdAt)} oleh ${imp?.createdBy}${imp?.undoneAt ? " (SUDAH DIBATALKAN)" : ""}`);
    }
  }

  h("E. EVENT PENGHASILAN KEMBAR LINTAS IMPOR (isi sama, impor beda, kunci beda)");
  const ev = await prisma.$queryRaw<{ a: string; b: string }[]>`
    SELECT a.id a, b.id b FROM "MarketplaceIncomeEvent" a JOIN "MarketplaceIncomeEvent" b ON b."incomeId"=a."incomeId" AND b.id>a.id AND b."releasedAt" IS NOT DISTINCT FROM a."releasedAt"
      AND b.released=a.released AND b."productAmt"=a."productAmt" AND b."refundAmt"=a."refundAmt" AND b.fees=a.fees AND b."importId"<>a."importId"
      AND split_part(b."eventKey",'#',1)<>split_part(a."eventKey",'#',1) ORDER BY a."releasedAt" DESC`;
  console.log(ev.length ? "" : "  tidak ada");
  for (const r of ev.slice(0, LIMIT)) {
    for (const id of [r.a, r.b]) {
      const e = await prisma.marketplaceIncomeEvent.findUniqueOrThrow({ where: { id }, include: { income: true } });
      const imp = await prisma.marketplaceImport.findUnique({ where: { id: e.importId }, select: { fileName: true, createdAt: true, undoneAt: true } });
      console.log(`  ${e.income.channel} ${e.income.kind} ref ${e.income.refNo} · cair ${idr(e.released)} (produk ${idr(e.productAmt)}, refund ${idr(e.refundAmt)}, fee ${idr(e.fees)}) ${wib(e.releasedAt)} · kunci ${e.eventKey} · file "${imp?.fileName}" ${wib(imp?.createdAt)}${imp?.undoneAt ? " (DIBATALKAN)" : ""}`);
    }
    console.log("  ▶ Bila dua file memuat baris yang sama dengan format tanggal/angka berbeda, ini dobel nyata: batalkan batch impor yang lebih baru lewat menu Penjualan › Marketplace › Impor › Batalkan.\n");
  }
  console.log("\nSelesai. Skrip ini tidak mengubah data.");
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
