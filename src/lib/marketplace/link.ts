import { prisma } from "../db";
import { platformOf } from "./rules";

/** Tautan pesanan marketplace ↔ Retur/Komplain ERP (resi atau no. pesanan sama). Tanpa FK; hanya penanda & pengisian data yang kosong. */

const up = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, "");
const chunk = <T>(a: T[], n = 2000) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

/** Tautkan retur & komplain lama ke pesanan yang belum bertaut. HANYA mengisi tautan di tabel marketplace; data retur/komplain tidak diubah. */
export async function linkOrdersToReturns(orderIds?: string[]) {
  const orders = await prisma.marketplaceOrder.findMany({ where: { ...(orderIds ? { id: { in: orderIds } } : {}), OR: [{ returnCaseId: null }, { complaintId: null }], AND: [{ OR: [{ trackingNo: { not: null } }, { orderNo: { not: "" } }] }] }, select: { id: true, orderNo: true, trackingNo: true, returnCaseId: true, complaintId: true } });
  if (!orders.length) return 0;
  const [rets, comps] = await Promise.all([
    prisma.returnCase.findMany({ where: { cancelledAt: null }, select: { id: true, trackingNo: true, orderNo: true } }),
    prisma.complaint.findMany({ where: { cancelledAt: null }, select: { id: true, trackingNo: true, orderNo: true } }),
  ]);
  const idx = (rows: { id: string; trackingNo: string | null; orderNo: string | null }[]) => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.trackingNo) m.set(`T${up(r.trackingNo)}`, r.id);
      if (r.orderNo) m.set(`O${up(r.orderNo)}`, r.id);
    }
    return m;
  };
  const ri = idx(rets), ci = idx(comps);
  let n = 0;
  for (const part of chunk(orders)) {
    for (const o of part) {
      const rid = o.returnCaseId ? null : ri.get(`O${up(o.orderNo)}`) ?? (o.trackingNo ? ri.get(`T${up(o.trackingNo)}`) : undefined);
      const cid = o.complaintId ? null : ci.get(`O${up(o.orderNo)}`) ?? (o.trackingNo ? ci.get(`T${up(o.trackingNo)}`) : undefined);
      if (rid || cid) {
        await prisma.marketplaceOrder.update({ where: { id: o.id }, data: { ...(rid ? { returnCaseId: rid } : {}), ...(cid ? { complaintId: cid } : {}) } });
        n++;
      }
    }
  }
  return n;
}

/**
 * Dipanggil saat retur/komplain baru dibuat: cari pesanan marketplace dengan resi/no. pesanan sama, tautkan, dan isi
 * kota/provinsi/kanal/toko pada retur HANYA bila masih kosong. Gagal diam-diam (tidak boleh menghalangi pencatatan retur).
 */
export async function autoLinkReturn(kind: "RETUR" | "KOMPLAIN", id: string) {
  try {
    const rec = kind === "RETUR" ? await prisma.returnCase.findUnique({ where: { id } }) : await prisma.complaint.findUnique({ where: { id } });
    if (!rec) return null;
    const tracking = up(rec.trackingNo), orderNo = up(rec.orderNo);
    if (!tracking && !orderNo) return null;
    const order = await prisma.marketplaceOrder.findFirst({ where: { OR: [...(orderNo ? [{ orderNo }] : []), ...(tracking ? [{ trackingNo: tracking }] : [])] }, orderBy: { orderedAt: "desc" } });
    if (!order) return null;
    await prisma.marketplaceOrder.update({ where: { id: order.id }, data: kind === "RETUR" ? { returnCaseId: id } : { complaintId: id } });
    const fill = {
      ...(rec.city ? {} : order.city ? { city: order.city } : {}),
      ...(rec.province ? {} : order.province ? { province: order.province } : {}),
      ...(rec.marketplace ? {} : { marketplace: platformOf(order.channel) }),
      ...(rec.orderNo ? {} : { orderNo: order.orderNo }),
    };
    if (kind === "RETUR") {
      const r = rec as { storeId: string | null };
      await prisma.returnCase.update({ where: { id }, data: { ...fill, ...(r.storeId ? {} : { storeId: order.storeId }) } });
    } else await prisma.complaint.update({ where: { id }, data: fill });
    return order.id;
  } catch {
    return null;
  }
}
