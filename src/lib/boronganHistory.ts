import { prisma } from "./db";

const LABEL: Record<string, string> = {
  KIRIMAN_BORONGAN: "Kiriman dibuat",
  KIRIMAN_DIUBAH: "Kiriman diubah",
  KIRIMAN_JUMLAH_DIUBAH: "Jumlah kiriman diubah",
  KIRIMAN_BORONGAN_DIBATALKAN: "Kiriman dibatalkan",
  BORONGAN_TUTUP_ADMINISTRATIF: "Ditutup administratif",
  PEMBAGIAN_BORONGAN: "Pembagian ke pekerja",
  LAPORAN_HASIL_BORONGAN: "Laporan hasil koordinator",
  AMBIL_SETORAN_BORONGAN: "Setoran diambil",
  AMBIL_SETORAN_DIBATALKAN: "Pengambilan dibatalkan",
  AMBIL_SETORAN_DIBALIK_OWNER: "Pengambilan dibalik (Owner)",
  TERIMA_SETORAN_BORONGAN: "Setoran diterima divisi",
  TERIMA_HASIL_PER_JENIS: "Hasil per jenis diterima",
  TERIMA_HASIL_DIKOREKSI: "Penerimaan hasil dikoreksi",
  SETORAN_BORONGAN_DIKOREKSI: "Setoran dikoreksi",
  UPAH_DITAHAN_DILEPAS: "Tahanan upah dilepas",
};
const FIELD: Record<string, string> = { tanggal: "Tanggal", catatan: "Catatan", jumlah: "Jumlah", titik: "Titik", caraKirim: "Cara kirim", driver: "Driver", bahan: "Bahan" };

const val = (v: unknown): string => {
  if (v == null || v === "") return "—";
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} ${val(x)}`).join(", ");
  return typeof v === "number" ? v.toLocaleString("id-ID") : String(v);
};

export type HistoryRow = { at: string; by: string; label: string; text: string };

/** Ringkas isi audit satu kejadian; `detail` = false (koordinator/driver): hanya alasan, tanpa nilai lama→baru */
function summary(action: string, data: unknown, detail: boolean): string {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const why = typeof d.alasan === "string" && d.alasan ? `Alasan: ${d.alasan}` : "";
  if (!detail) return why;
  const parts: string[] = [];
  if (action === "KIRIMAN_DIUBAH" && d.perubahan && typeof d.perubahan === "object") {
    for (const [k, c] of Object.entries(d.perubahan as Record<string, { lama: unknown; baru: unknown }>)) parts.push(`${FIELD[k] ?? k}: ${val(c.lama)} → ${val(c.baru)}`);
  } else if (action === "KIRIMAN_JUMLAH_DIUBAH") parts.push(`Jumlah: ${val(d.sebelum)} → ${val(d.sesudah)}`);
  else if (action === "TERIMA_HASIL_DIKOREKSI") parts.push(`Diterima: ${val(d.sebelum)} → ${val(d.sesudah)}`);
  else if (action === "TERIMA_HASIL_PER_JENIS" && d.diterima) parts.push(`Diterima: ${val(d.diterima)}`);
  else if (typeof d.total === "number") parts.push(`${val(d.total)} pcs`);
  if (why) parts.push(why);
  return parts.join(" · ").slice(0, 400);
}

/** Riwayat perubahan satu kiriman (audit ringkas): kiriman itu sendiri + pengambilan/penerimaannya */
export async function shipmentHistory(shipmentId: string, pickupIds: string[], detail: boolean, limit = 40): Promise<HistoryRow[]> {
  const rows = await prisma.auditLog.findMany({
    where: { action: { in: Object.keys(LABEL) }, OR: [{ entity: "BoronganShipment", entityId: shipmentId }, ...(pickupIds.length ? [{ entity: "BoronganPickup", entityId: { in: pickupIds } }] : [])] },
    orderBy: { at: "desc" },
    take: limit,
  });
  return rows.map((r) => ({ at: r.at.toISOString(), by: r.actorName ?? "Sistem", label: LABEL[r.action] ?? r.action, text: summary(r.action, r.data, detail) }));
}
