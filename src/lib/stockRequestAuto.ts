import { prisma } from "./db";
import { audit } from "./audit";
import { needsOrder, type StockCountRow } from "./shiftReport";
import { fmtDay } from "./time";

type Actor = { id: string; name: string };

/** Jumlah saran permintaan: kekurangan sampai batas + jumlah order biasa (minimal 1 satuan) */
export function suggestedQty(stock: number, limit: number, orderQty: number) {
  const q = Math.max(0, limit - stock) + Math.max(0, orderQty);
  return q > 0 ? Math.round(q * 1000) / 1000 : 1;
}

/**
 * Permintaan stok otomatis dari stock opname laporan shift: tiap bahan dengan stok akhir ≤ limit dibuatkan permintaan,
 * kecuali bahan itu masih punya permintaan terbuka (Diajukan/Disetujui) agar tidak dobel.
 */
export async function autoRequestsFromReport(reportId: string, actor: Actor) {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id: reportId }, include: { division: true, shift: true } });
  const low = (r.stockCount as StockCountRow[]).filter(needsOrder);
  if (!low.length) return { created: 0 };
  const items = await prisma.item.findMany({ where: { id: { in: low.map((x) => x.itemId) }, active: true } });
  const open = new Set((await prisma.stockRequest.findMany({ where: { itemId: { in: items.map((i) => i.id) }, status: { in: ["DIAJUKAN", "DISETUJUI"] } }, select: { itemId: true } })).map((x) => x.itemId));
  let created = 0;
  for (const row of low) {
    const it = items.find((i) => i.id === row.itemId);
    if (!it || open.has(it.id)) continue;
    const qty = suggestedQty(row.qty!, row.limit, Number(it.orderQty));
    const note = `Otomatis: stok akhir ${r.shift.name} ${fmtDay(r.date)} = ${row.qty} ${it.unit}, limit ${row.limit}`;
    const req = await prisma.stockRequest.create({ data: { itemId: it.id, divisionId: r.divisionId, qty, note, requestedBy: `Sistem (laporan ${r.division.name})`, auto: true, reportId } });
    await audit(actor, "PERMINTAAN_STOK_OTOMATIS", "StockRequest", req.id, { item: it.name, qty, stok: row.qty, limit: row.limit, reportId });
    open.add(it.id);
    created++;
  }
  return { created };
}
