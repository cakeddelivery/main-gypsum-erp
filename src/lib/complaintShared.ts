import type { ComplaintStatus } from "@prisma/client";

/** Konstanta komplain yang dipakai juga di browser (tanpa akses database) */
export const ISSUE_TYPES = [
  { key: "PECAH", label: "Pecah / rusak sebagian" },
  { key: "KURANG_QTY", label: "Jumlah kurang" },
  { key: "KELENGKAPAN", label: "Kelengkapan kurang" },
  { key: "SALAH_KIRIM", label: "Salah kirim / varian salah" },
  { key: "LAINNYA", label: "Lainnya" },
] as const;
export const issueLabel = (k: string) => ISSUE_TYPES.find((i) => i.key === k)?.label ?? k;
export const SOLUTIONS = [
  { key: "REFUND", label: "Refund" },
  { key: "KIRIM_GANTI", label: "Kirim ganti" },
] as const;
export const solutionLabel = (k: string) => SOLUTIONS.find((i) => i.key === k)?.label ?? k;

export const COMPLAINT_STATUS: Record<ComplaintStatus, { label: string; tone: "gray" | "blue" | "amber" | "green" | "red" }> = {
  DIAJUKAN: { label: "Diajukan", tone: "blue" },
  MENUNGGU_OWNER: { label: "Menunggu Owner", tone: "amber" },
  DISETUJUI: { label: "Disetujui", tone: "amber" },
  DIBAYAR: { label: "Dibayar", tone: "green" },
  DIKIRIM: { label: "Pengganti dikirim", tone: "green" },
  SELESAI: { label: "Selesai", tone: "green" },
  DITOLAK: { label: "Ditolak", tone: "red" },
};
export const complaintStatusOf = (c: { status: ComplaintStatus; cancelledAt?: Date | null }) => (c.cancelledAt ? { label: "Dibatalkan", tone: "gray" as const } : COMPLAINT_STATUS[c.status]);

