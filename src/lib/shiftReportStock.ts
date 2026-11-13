import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { dateOnly, fmtDay, todayStr } from "./time";
import { locationSettings, qtyAt, recordMovement } from "./stock";
import { expectedReportCount, needsOrder, shiftEndAt, type StockCountRow } from "./shiftReport";
import { pendingReceipts, receiptsUntil } from "./shiftReceipt";

type Actor = { id: string; name: string };

export type StockApplyResult = { adjusted: number; skipped?: string };

/**
 * Stock opname dari laporan shift: stok sistem bahan baku (lokasi gudang bahan) disesuaikan ke hasil hitung fisik.
 * - Dihitung dan dicatat PER JAM SELESAI SHIFT (tanggal laporan + jam selesai), bukan saat tombol Kirim ditekan.
 *   Pembelian/mutasi sesudah shift tidak ikut "terhapus" walaupun laporan dikirim terlambat.
 * - Hanya stok di gudang bahan yang dibandingkan (bahan yang sedang di titik borongan/driver tidak ikut).
 * - Bila sudah ada laporan LEBIH BARU untuk divisi yang sama yang stoknya sudah diterapkan, laporan ini tidak mengubah stok
 *   (hitungan baru lebih benar; hitungan lama tidak boleh menimpanya).
 * - Revisi laporan yang sudah diterapkan hanya menerapkan selisih hitungan baru vs hitungan yang dulu diterapkan.
 * Stok berkurang = pemakaian bahan → akun HPP "Pemakaian Bahan Baku"; revisi ikut akun itu. Stok bertambah di hitungan
 * pertama tetap selisih persediaan.
 * Barang masuk (ShiftReceipt) yang belum ditautkan ke Pembelian dianggap sudah ada di stok sistem, jadi tidak terhitung
 * pemakaian dan tidak dobel saat Pembelian dicatat. Barang masuk yang ditambahkan sesudah laporan dikirim ikut diperhitungkan
 * di revisi (daftar barang masuk yang sudah dihitung disimpan di snapshot `rcpt`).
 */
export async function applyShiftStockCount(reportId: string, actor: Actor, now: Date = new Date()): Promise<StockApplyResult> {
  const report = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { shift: true } });
  const rows = (report.stockCount as StockCountRow[] | null) ?? [];
  const { raw } = await locationSettings(prisma);
  if (!raw) return { adjusted: 0, skipped: "Lokasi gudang bahan baku belum diatur" };
  const prev = report.stockApplied ? (report.stockAppliedCount as StockCountRow[] | null) : null;
  // Laporan lama yang sudah diterapkan tanpa catatan hitungan: jangan timpa stok terkini
  if (report.stockApplied && !prev) return { adjusted: 0 };
  const newer = await prisma.shiftReport.findFirst({
    where: {
      id: { not: report.id },
      divisionId: report.divisionId,
      stockApplied: true,
      OR: [{ date: { gt: report.date } }, { date: report.date, shift: { code: { gt: report.shift.code } } }],
    },
    include: { shift: true },
    orderBy: [{ date: "desc" }],
  });
  if (newer) return { adjusted: 0, skipped: `Stok tidak diubah: sudah ada laporan lebih baru (${fmtDay(newer.date)} · ${newer.shift.name})` };

  const at = shiftEndAt(report.date, report.shift, now);
  let n = 0;
  await prisma.$transaction(async (tx) => {
    // Kunci laporan lalu baca ulang hitungan yang sudah diterapkan: dua kali Kirim bersamaan tidak boleh
    // memotong stok dua kali (permintaan kedua melihat hitungan pertama dan hanya menerapkan selisihnya, yaitu 0)
    await tx.$queryRaw`SELECT id FROM "ShiftReport" WHERE id = ${report.id} FOR UPDATE`;
    const fresh = await tx.shiftReport.findUniqueOrThrow({ where: { id: report.id }, select: { stockApplied: true, stockAppliedCount: true } });
    if (fresh.stockApplied && !fresh.stockAppliedCount) return;
    const prev = fresh.stockApplied ? (fresh.stockAppliedCount as StockCountRow[] | null) : null;
    const applied = new Map((prev ?? []).map((p) => [p.itemId, p]));
    const counted = rows.filter((r) => r.qty != null).map((r) => r.itemId);
    const pending = await pendingReceipts(tx, counted, at);
    const allReceipts = await receiptsUntil(tx, counted, at);
    const rcpt = new Map<string, string[]>();
    for (const row of rows) {
      if (row.qty == null) continue;
      const before = applied.get(row.itemId);
      let base: number;
      if (before?.qty != null) {
        // Revisi: hanya selisih hitungan + barang masuk yang dicatat sesudah hitungan lama diterapkan
        const known = new Set(before.rcpt ?? []);
        const extra = allReceipts.filter((x) => x.itemId === row.itemId && !known.has(x.id));
        base = before.qty + extra.reduce((a, x) => a + Number(x.qty), 0);
        rcpt.set(row.itemId, [...known, ...extra.map((x) => x.id)]);
      } else {
        const p = pending.filter((x) => x.itemId === row.itemId).reduce((a, x) => a + Number(x.qty), 0);
        base = (await qtyAt(tx, row.itemId, raw, at)) + p;
        rcpt.set(row.itemId, allReceipts.filter((x) => x.itemId === row.itemId).map((x) => x.id));
      }
      const diff = Math.round((row.qty - base) * 1000) / 1000;
      if (diff === 0) continue;
      await recordMovement(
        tx,
        {
          type: "PENYESUAIAN",
          itemId: row.itemId,
          qty: Math.abs(diff),
          fromLocationId: raw,
          increase: diff > 0,
          usage: diff < 0 || before?.qty != null,
          allowNegative: true,
          ref: `LAP:${report.id}`,
          note: before?.qty != null ? "Revisi stock opname laporan shift" : "Stock opname laporan shift",
          date: at,
        },
        actor,
      );
      n++;
    }
    const snapshot = [
      ...(prev ?? []).filter((p) => !rows.some((r) => r.itemId === p.itemId && r.qty != null)),
      ...rows.filter((r) => r.qty != null).map((r) => ({ ...r, rcpt: rcpt.get(r.itemId) ?? [] })),
    ];
    await tx.shiftReport.update({ where: { id: report.id }, data: { stockApplied: true, stockAppliedCount: snapshot as unknown as Prisma.InputJsonValue } });
  }, { timeout: 30000 });
  return { adjusted: n };
}

/** Laporan shift tanggal `date` yang belum terkirim (termasuk yang belum dibuat sama sekali) */
export async function unsentReportCount(date: string, divisionId?: string | null): Promise<number> {
  const [shifts, divisions] = await Promise.all([
    prisma.shift.count({ where: { active: true } }),
    prisma.division.findMany({ where: { active: true, reportTemplate: { not: null }, ...(divisionId ? { id: divisionId } : {}) }, select: { id: true, shiftCount: true } }),
  ]);
  if (!divisions.length) return 0;
  const sent = await prisma.shiftReport.count({ where: { date: dateOnly(date), status: { in: ["TERKIRIM", "DIREVISI"] }, divisionId: { in: divisions.map((d) => d.id) } } });
  return Math.max(0, expectedReportCount(divisions, shifts) - sent);
}

export type OrderRow = { itemId: string; name: string; unit: string; limit: number; qty: number; reportId: string; date: Date; shift: string; url?: string | null };

/** Bahan baku per divisi yang perlu diorder: hitungan stok akhir shift terakhir tiap bahan ≤ limit */
export async function materialOrderList(divisionId?: string | null) {
  const divisions = await prisma.division.findMany({
    where: { active: true, items: { some: { active: true } }, ...(divisionId ? { id: divisionId } : {}) },
    orderBy: { code: "asc" },
    include: { items: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
  });
  // Laporan terbaru dulu: hitungan pertama yang ditemukan per bahan = hitungan terakhir
  const reports = await prisma.shiftReport.findMany({
    where: { divisionId: { in: divisions.map((d) => d.id) } },
    orderBy: [{ date: "desc" }, { shift: { code: "desc" } }, { createdAt: "desc" }],
    take: 200,
    select: { id: true, date: true, stockCount: true, shift: { select: { name: true } } },
  });
  const last = new Map<string, { qty: number; reportId: string; date: Date; shift: string }>();
  for (const r of reports) for (const s of r.stockCount as StockCountRow[]) if (s.qty != null && !last.has(s.itemId)) last.set(s.itemId, { qty: s.qty, reportId: r.id, date: r.date, shift: r.shift.name });
  return divisions.map((d) => {
    const rows = d.items.map((i) => ({ item: i, limit: Number(i.minStock), count: last.get(i.id) }));
    const order: OrderRow[] = rows
      .filter((r) => r.count && needsOrder({ qty: r.count.qty, limit: r.limit }))
      .map((r) => ({ itemId: r.item.id, name: r.item.name, unit: r.item.unit, limit: r.limit, url: r.item.buyMode === "ONLINE" ? r.item.productUrl : null, ...r.count! }));
    return { division: d, order, uncounted: rows.filter((r) => !r.count).map((r) => r.item) };
  });
}

/** Teks pengingat order bahan baku (null bila tidak ada yang perlu diorder) */
export function materialOrderText(groups: { division: { name: string }; order: OrderRow[] }[], esc: (s: string) => string): string | null {
  const g = groups.filter((x) => x.order.length);
  if (!g.length) return null;
  const fmt = (v: number) => v.toLocaleString("id-ID");
  const total = g.reduce((a, x) => a + x.order.length, 0);
  return [
    `<b>⚠️ Order bahan baku (${total})</b>`,
    "Stok akhir shift terakhir ≤ limit:",
    ...g.flatMap((x) => [``, `<b>${esc(x.division.name)}</b>`, ...x.order.map((o) => `• ${esc(o.name)}: stok ${fmt(o.qty)} · limit ${fmt(o.limit)} ${esc(o.unit)}${o.url ? `\n  🛒 <a href="${esc(o.url)}">Order online</a>` : ""}`)]),
  ].join("\n");
}

/** Pengingat order bahan baku 19.00 WIB ke Owner & Admin yang tertaut Telegram (hanya bila ada) */
export async function sendMaterialOrderReminder(now: Date = new Date()) {
  const { esc, sendTelegram, telegramConfigured } = await import("./telegram");
  const text = materialOrderText(await materialOrderList(), esc);
  if (!text) return { sent: 0, skipped: "tidak ada bahan yang perlu diorder" };
  const recipients = await prisma.telegramIdentity.findMany({ where: { active: true, chatId: { not: null }, user: { active: true, role: { in: ["OWNER", "ADMIN"] } } } });
  if (!telegramConfigured() || !recipients.length) {
    await prisma.notificationLog.create({ data: { channel: "TELEGRAM", type: "ORDER_BAHAN", target: todayStr(now), status: "GAGAL", payload: text.slice(0, 2000), error: !telegramConfigured() ? "TELEGRAM_BOT_TOKEN belum diatur" : "Owner/Admin belum tertaut Telegram" } });
    return { sent: 0, failed: recipients.length };
  }
  let sent = 0;
  for (const r of recipients) if ((await sendTelegram(r.chatId!, text, { type: "ORDER_BAHAN" })).ok) sent++;
  return { sent, failed: recipients.length - sent };
}
