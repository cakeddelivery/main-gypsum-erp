"use server";
import { action, str } from "@/lib/action";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { CUTOVER_SETTING } from "@/lib/shiftReportFlow";

/** Owner menetapkan / mengundurkan tanggal mulai stok terpadu (cut-over) */
export const simpanTanggalMulai = action(
  "settings.manage",
  async (fd, user) => {
    const date = str(fd, "date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Tanggal tidak valid");
    const prev = (await prisma.setting.findUnique({ where: { key: CUTOVER_SETTING } }))?.value ?? null;
    await prisma.setting.upsert({ where: { key: CUTOVER_SETTING }, create: { key: CUTOVER_SETTING, value: date }, update: { value: date } });
    await audit(user, "CUTOVER_TANGGAL", "Setting", CUTOVER_SETTING, { sebelum: prev, sesudah: date });
    return `Tanggal mulai stok terpadu: ${date}`;
  },
  ["/stok/cutover"],
);
