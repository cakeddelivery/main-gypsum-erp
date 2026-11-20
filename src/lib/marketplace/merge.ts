import type { ParsedOrder } from "./parse";
import { mapStatus, type RawStatus } from "./rules";

/**
 * Aturan impor harian (periode file bertumpang tindih): pesanan yang sudah ada TIDAK dibuat ulang, hanya diperbarui
 * maju (kirim → selesai, resi baru, batal, retur). Status tidak pernah mundur karena file lama.
 * Murni (tanpa database) agar mudah dites.
 */
const STATUS_RANK: Record<RawStatus, number> = { PIUTANG: 0, RETUR: 1, BATAL: 2 };

/** Tahap pengiriman dari teks status platform: 1 diproses, 2 dikirim, 3 selesai/diterima */
export function shipRank(raw: string | null | undefined) {
  const s = (raw ?? "").toLowerCase();
  if (/selesai|diterima|completed|delivered|terkirim/.test(s)) return 3;
  if (/dikirim|transit|shipped|dalam perjalanan|pengiriman/.test(s)) return 2;
  return 1;
}

export type ExistingOrder = {
  status: string;
  rawStatus: string | null;
  rawSubstatus: string | null;
  rawReturn: string | null;
  cancelReason: string | null;
  trackingNo: string | null;
  shipOption: string | null;
  courier: string | null;
  paymentMethod: string | null;
  city: string | null;
  province: string | null;
  creatorHandle: string | null;
  affiliate: boolean;
  completedAt: Date | null;
  paidAt: Date | null;
  total: bigint;
  subtotal: bigint;
  discount: bigint;
  shippingPaid: bigint;
  refundAmount: bigint;
  returnQty: number;
  needsCheck: string | null;
  hasIncome: boolean;
  lines: { sku: string | null; variation: string | null; qty: number; amount: bigint; returnQty: number }[];
};

export type OrderPlan = {
  /** Kolom yang diubah (kosong = tidak ada perubahan) */
  data: Record<string, unknown>;
  replaceLines: boolean;
  /** Label perubahan untuk pratinjau & riwayat, mis. "Dikirim → Selesai", "resi baru", "Batal" */
  changes: string[];
  status: RawStatus;
};

const lineSig = (l: { sku: string | null; variation: string | null; qty: number; amount: bigint | number; returnQty: number }) => `${l.sku ?? ""}|${l.variation ?? ""}|${l.qty}|${Number(l.amount)}|${l.returnQty}`;

export function planOrderUpdate(ex: ExistingOrder, inc: ParsedOrder, channel: string): OrderPlan {
  const incStatus = mapStatus(channel, inc);
  const curStatus = ex.status as RawStatus;
  const data: Record<string, unknown> = {};
  const changes: string[] = [];
  // Batal bersifat final; status tidak pernah turun
  const stale = STATUS_RANK[incStatus] < STATUS_RANK[curStatus];
  const status: RawStatus = stale ? curStatus : incStatus;
  if (!stale) {
    if (status !== curStatus) {
      data.status = status;
      changes.push(status === "BATAL" ? "Batal" : status === "RETUR" ? "Retur" : `${curStatus} → ${status}`);
      if (ex.hasIncome && status !== "PIUTANG") {
        data.needsCheck = status === "BATAL" ? "BATAL_SETELAH_CAIR" : "RETUR_SETELAH_CAIR";
        changes.push("perlu dicek (sudah cair)");
      }
    }
    // Teks status platform: maju saja (Dikirim → Selesai), tidak mundur karena file lama
    const advance = status !== "PIUTANG" || shipRank(inc.rawStatus) >= shipRank(ex.rawStatus);
    if (advance && inc.rawStatus && inc.rawStatus !== ex.rawStatus) {
      data.rawStatus = inc.rawStatus;
      changes.push(`${ex.rawStatus ?? "-"} → ${inc.rawStatus}`);
    }
    if (inc.rawSubstatus && inc.rawSubstatus !== ex.rawSubstatus) data.rawSubstatus = inc.rawSubstatus;
    if (inc.rawReturn && inc.rawReturn !== ex.rawReturn) data.rawReturn = inc.rawReturn;
    if (inc.cancelReason && inc.cancelReason !== ex.cancelReason) data.cancelReason = inc.cancelReason;
    if (inc.completedAt && !ex.completedAt) data.completedAt = inc.completedAt;
    const money = [["total", inc.total, ex.total], ["subtotal", inc.subtotal, ex.subtotal], ["discount", inc.discount, ex.discount], ["shippingPaid", inc.shippingPaid, ex.shippingPaid], ["refundAmount", inc.refundAmount, ex.refundAmount]] as const;
    for (const [k, v, cur] of money) if (v && BigInt(Math.round(v)) !== cur) data[k] = BigInt(Math.round(v));
    if (data.total !== undefined) changes.push("nilai berubah");
    if (inc.returnQty > ex.returnQty) data.returnQty = inc.returnQty;
  }
  // Resi & wilayah: hanya mengisi/mengoreksi, tidak pernah dikosongkan
  if (inc.trackingNo && inc.trackingNo !== ex.trackingNo) {
    data.trackingNo = inc.trackingNo;
    changes.push(ex.trackingNo ? "resi diubah" : "resi baru");
  }
  for (const k of ["shipOption", "courier", "paymentMethod", "city", "province", "creatorHandle"] as const) if (inc[k] && !ex[k]) data[k] = inc[k];
  if (inc.paidAt && !ex.paidAt) data.paidAt = inc.paidAt;
  if (inc.affiliate && !ex.affiliate) data.affiliate = true;
  let replaceLines = false;
  if (!stale && inc.lines.length) {
    const a = ex.lines.map(lineSig).sort().join("#");
    const b = inc.lines.map(lineSig).sort().join("#");
    if (a !== b) {
      // returnQty yang hanya naik dianggap perubahan retur; selain itu isi produk berubah
      replaceLines = true;
      changes.push("isi pesanan berubah");
    }
  }
  return { data, replaceLines, changes, status };
}
