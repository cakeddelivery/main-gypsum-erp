"use server";
import { action, str } from "@/lib/action";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { runStockAlerts } from "@/lib/stockAlerts";

/** Tandai peringatan sudah dijelaskan (catatan wajib) atau sudah dilihat */
export const jelaskanAnomali = action(
  ["production.target"],
  async (fd, user) => {
    const id = str(fd, "id");
    const note = String(fd.get("note") ?? "").trim();
    const status = str(fd, "status") === "DILIHAT" ? "DILIHAT" : "DIJELASKAN";
    if (status === "DIJELASKAN" && note.length < 3) throw new Error("Tulis penjelasannya");
    await prisma.stockAnomaly.update({ where: { id }, data: { status, note: note || null, noteBy: user.name } });
    await audit(user, "ANOMALI_STOK_" + status, "StockAnomaly", id, { catatan: note || undefined });
    return status === "DIJELASKAN" ? "Penjelasan tersimpan" : "Ditandai sudah dilihat";
  },
  ["/laporan/kebocoran"],
);

export const periksaSekarang = action(
  ["production.target"],
  async () => {
    const r = await runStockAlerts();
    return `Pemeriksaan selesai: ${r.found} temuan (${r.created} baru)`;
  },
  ["/laporan/kebocoran"],
);
