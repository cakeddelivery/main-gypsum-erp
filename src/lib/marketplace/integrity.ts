import { prisma } from "../db";
import { n } from "../money";
import { COA } from "../accounting";
import { WITHDRAW_INCOME_SOURCE } from "../finance";
import { sumFees } from "./feeMap";
import { feeOverrides } from "./potongan";
import { loadAllocation } from "./saldo";
import { marketplaceBanks } from "./bank";
import { dayEnd, dayStart } from "./report";
import { monthBounds } from "./dashboard";
import { platformOf, CHANNEL_LABEL } from "./rules";
import { resolveSkuKeys } from "./sku";

/**
 * Cek integritas data marketplace (HANYA BACA). Setiap pemeriksaan: ok / gagal + penjelasan + contoh baris.
 * Tujuan: tidak ada data dobel/tidak valid; angka bisa dipertanggungjawabkan terhadap file asli dan keuangan.
 */
export type Check = { key: string; label: string; ok: boolean; detail: string; items?: string[] };
export type Group = { storeId: string; store: string; channel: string; checks: Check[] };
const idr = (v: number) => `Rp ${Math.round(v).toLocaleString("id-ID")}`;
const TOL = 1; // toleransi pembulatan Rp 1

export async function integrityCheck(f: { month: string; storeId?: string }) {
  const { from, to } = monthBounds(f.month);
  const rel = { gte: dayStart(from), lt: dayEnd(to) };
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true, code: true } });
  const banks = await marketplaceBanks();
  const overrides = await feeOverrides();
  const groups: Group[] = [];
  for (const s of stores.filter((x) => !f.storeId || x.id === f.storeId)) {
    for (const ch of ["SHP", "TTS"]) {
      const platform = platformOf(ch);
      const [nOrders, nIncomes] = await Promise.all([prisma.marketplaceOrder.count({ where: { storeId: s.id, channel: ch, orderedAt: rel } }), prisma.marketplaceIncomeEvent.count({ where: { income: { storeId: s.id, channel: ch }, releasedAt: rel } })]);
      if (!nOrders && !nIncomes) continue;
      const checks: Check[] = [];

      // a. Σ cair per file = total ringkasan file
      const imports = await prisma.marketplaceImport.findMany({ where: { storeId: s.id, channel: ch, kind: "INCOME", undoneAt: null, OR: [{ periodFrom: rel }, { periodFrom: null, createdAt: rel }] }, select: { fileName: true, stats: true } });
      const withSummary = imports.filter((i) => (i.stats as { summaryTotal?: number | null } | null)?.summaryTotal != null);
      const bad = withSummary.filter((i) => Math.abs(((i.stats as { fileTotal?: number }).fileTotal ?? 0) - ((i.stats as { summaryTotal: number }).summaryTotal)) > TOL);
      checks.push({ key: "a", label: "Σ cair per file = total ringkasan file", ok: bad.length === 0, detail: withSummary.length ? (bad.length ? `${bad.length} dari ${withSummary.length} file tidak cocok` : `${withSummary.length} file cocok dengan ringkasan`) : "Belum ada file dengan total ringkasan terbaca (unggah ulang file penghasilan agar dibandingkan)", items: bad.map((i) => { const st = i.stats as { fileTotal: number; summaryTotal: number }; return `${i.fileName}: baris ${idr(st.fileTotal)} vs ringkasan ${idr(st.summaryTotal)}`; }) });

      // b. per pesanan: pendapatan + Σ potongan (counted) = cair
      const incomes = await prisma.marketplaceIncome.findMany({ where: { storeId: s.id, channel: ch, kind: "ORDER", events: { some: { releasedAt: rel } } }, select: { refNo: true, released: true, productAmt: true, feeDetail: true } });
      const mism: string[] = [];
      let sumDiff = 0;
      for (const i of incomes) {
        const counted = sumFees(platform, [(i.feeDetail ?? {}) as Record<string, number>], overrides).counted;
        const diff = n(i.released) - (n(i.productAmt) + counted);
        if (Math.abs(diff) > TOL) {
          mism.push(`${i.refNo}: selisih ${idr(diff)}`);
          sumDiff += diff;
        }
      }
      checks.push({ key: "b", label: "Per pesanan: pendapatan + potongan = cair", ok: mism.length === 0, detail: mism.length ? `${mism.length} dari ${incomes.length} pesanan tidak cocok (Σ selisih ${idr(sumDiff)}); cek kolom biaya yang belum dipetakan` : `${incomes.length} pesanan cocok`, items: mism.slice(0, 20) });

      // c. duplikat: pesanan sama di toko lain; baris kembar persis; ref withdraw ganda
      const dupOrders = await prisma.$queryRaw<{ orderNo: string; n: bigint }[]>`SELECT "orderNo", COUNT(DISTINCT "storeId") AS n FROM "MarketplaceOrder" WHERE "channel" = ${ch} GROUP BY "orderNo" HAVING COUNT(DISTINCT "storeId") > 1 LIMIT 20`;
      const twin = await prisma.marketplaceIncomeEvent.count({ where: { income: { storeId: s.id, channel: ch }, eventKey: { contains: "#" } } });
      const dupWd = await prisma.$queryRaw<{ refId: string }[]>`SELECT "refId" FROM "MarketplaceWithdrawal" WHERE "channel" = ${ch} GROUP BY "refId" HAVING COUNT(DISTINCT "storeId") > 1 LIMIT 20`;
      checks.push({ key: "c", label: "Tidak ada duplikat (pesanan di dua toko, ref withdraw ganda)", ok: dupOrders.length === 0 && dupWd.length === 0, detail: dupOrders.length || dupWd.length ? `${dupOrders.length} pesanan ada di lebih dari satu toko (salah pilih toko saat impor?), ${dupWd.length} ref withdraw ganda` : `bersih${twin ? ` · ${twin} baris penyelesaian kembar persis (sah bila memang dua baris sama di file)` : ""}`, items: [...dupOrders.map((d) => `pesanan ${d.orderNo} di ${Number(d.n)} toko`), ...dupWd.map((d) => `ref withdraw ${d.refId} di lebih dari satu toko`)] });

      // d. jumlah per batch di DB = jumlah di file
      const batches = await prisma.marketplaceImport.findMany({ where: { storeId: s.id, channel: ch, undoneAt: null, OR: [{ periodFrom: rel }, { periodFrom: null, createdAt: rel }] }, select: { id: true, fileName: true, kind: true, stats: true } });
      const dBad: string[] = [];
      for (const b of batches) {
        const st = (b.stats ?? {}) as { baru?: number; diperbarui?: number };
        if (b.kind === "ORDER") {
          const c = await prisma.marketplaceOrder.count({ where: { importId: b.id } });
          if (c !== (st.baru ?? 0)) dBad.push(`${b.fileName}: ${c} pesanan di DB vs ${st.baru ?? 0} dibuat batch ini`);
        } else {
          const c = await prisma.marketplaceIncomeEvent.count({ where: { importId: b.id } });
          if (c !== (st.baru ?? 0) + (st.diperbarui ?? 0)) dBad.push(`${b.fileName}: ${c} baris penyelesaian di DB vs ${(st.baru ?? 0) + (st.diperbarui ?? 0)} dari file`);
        }
      }
      const noLines = await prisma.marketplaceOrder.count({ where: { storeId: s.id, channel: ch, orderedAt: rel, lines: { none: {} } } });
      checks.push({ key: "d", label: "Jumlah di DB = jumlah di file impor (per batch)", ok: dBad.length === 0 && noLines === 0, detail: dBad.length || noLines ? `${dBad.length} batch tidak cocok, ${noLines} pesanan tanpa baris produk` : `${batches.length} batch cocok`, items: dBad });

      // e. SKU belum dipetakan & nilai Rp 0
      const lines = await prisma.marketplaceOrderLine.findMany({ where: { order: { storeId: s.id, channel: ch, orderedAt: rel, status: { not: "BATAL" } } }, select: { skuKey: true, sku: true }, distinct: ["skuKey"] });
      const res = await resolveSkuKeys(lines.map((l) => l.skuKey));
      const unmapped = lines.filter((l) => !res.has(l.skuKey));
      const zero = await prisma.marketplaceOrder.findMany({ where: { storeId: s.id, channel: ch, orderedAt: rel, status: { not: "BATAL" }, total: 0n }, select: { orderNo: true }, take: 20 });
      checks.push({ key: "e", label: "SKU terpetakan & nilai pesanan terisi", ok: unmapped.length === 0 && zero.length === 0, detail: `${unmapped.length} SKU belum dipetakan, ${zero.length} pesanan bernilai Rp 0 (tidak batal)`, items: [...unmapped.slice(0, 10).map((u) => `SKU ${u.sku ?? u.skuKey}`), ...zero.map((z) => `pesanan ${z.orderNo} bernilai Rp 0`)] });

      // f. saldo ≥ 0 (FIFO) & kecocokan withdraw ERP ↔ file
      const a = await loadAllocation(s, ch, stores.length, banks);
      const tdf = a.pairs.filter((p) => p.status === "TIDAK_DI_FILE").length;
      checks.push({ key: "f", label: "Saldo ≥ 0 & withdraw cocok antara ERP dan file", ok: a.fifo.over === 0 && a.notInErp.length === 0 && tdf === 0, detail: `saldo berjalan ${idr(a.fifo.balance)}${a.fifo.over ? ` · withdraw melebihi cair ${idr(a.fifo.over)}` : ""} · ${a.notInErp.length} penarikan di file belum tercatat di ERP · ${tdf} withdraw ERP tanpa padanan di file`, items: [...a.notInErp.slice(0, 10).map((p) => `file: ${p.refId} ${idr(p.fileAmount ?? 0)}`), ...a.pairs.filter((p) => p.status === "TIDAK_DI_FILE").slice(0, 10).map((p) => `ERP: ${p.refId} ${idr(p.erpAmount ?? 0)}`)] });
      groups.push({ storeId: s.id, store: s.name, channel: ch, checks });
    }
  }

  // g. omzet marketplace vs pendapatan yang dibukukan di Akuntansi (dari withdraw): berdampingan, TIDAK dijumlahkan
  const orders = await prisma.marketplaceOrder.aggregate({ where: { ...(f.storeId ? { storeId: f.storeId } : {}), orderedAt: rel, status: { not: "BATAL" } }, _sum: { total: true }, _count: true });
  const account = await prisma.coaAccount.findUnique({ where: { code: COA.PENJUALAN }, select: { id: true } });
  const booked = account
    ? await prisma.journalLine.aggregate({ where: { accountId: account.id, journal: { source: WITHDRAW_INCOME_SOURCE, date: rel, reversalOfId: null, ...(f.storeId ? { storeId: f.storeId } : {}) } }, _sum: { credit: true } })
    : null;
  const accounting = { omzet: n(orders._sum.total), orders: orders._count, booked: n(booked?._sum.credit), note: "Angka marketplace = data operasional dari file; tidak masuk jurnal. Pendapatan akuntansi diakui saat withdraw, sehingga bulannya bisa berbeda dari omzet pesanan. Kedua angka ditampilkan berdampingan, tidak dijumlahkan." };
  const all = groups.flatMap((g) => g.checks);
  return { month: f.month, groups, accounting, failed: all.filter((c) => !c.ok).length, total: all.length };
}

export const channelLabel = (c: string) => CHANNEL_LABEL[c] ?? c;
