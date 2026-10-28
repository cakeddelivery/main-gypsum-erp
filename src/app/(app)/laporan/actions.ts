"use server";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { action, str, optStr } from "@/lib/action";
import { audit } from "@/lib/audit";
import { dateOnly, fmtDay } from "@/lib/time";
import { assertPerm, ForbiddenError } from "@/lib/auth";
import { sendTelegram, telegramConfigured, esc } from "@/lib/telegram";
import { STAGE_LABEL } from "@/lib/stock";

const DEFAULT_CHECKLIST = ["Area kerja bersih & rapi", "Peralatan/cetakan dicek", "Bahan cukup untuk shift berikutnya", "Hasil sudah dihitung ulang", "Reject dipisahkan & dicatat"];

export async function openReport(fd: FormData) {
  const user = await assertPerm("report.create");
  const date = str(fd, "date");
  const shiftId = str(fd, "shiftId");
  const divisionId = str(fd, "divisionId");
  if (user.role === "KAPTEN_DIVISI" && user.divisionId && divisionId !== user.divisionId) throw new ForbiddenError();
  const setting = await prisma.setting.findUnique({ where: { key: "report_checklist" } });
  const items = setting ? setting.value.split("\n").map((s) => s.trim()).filter(Boolean) : DEFAULT_CHECKLIST;
  const r = await prisma.shiftReport.upsert({
    where: { date_shiftId_divisionId: { date: dateOnly(date), shiftId, divisionId } },
    create: { date: dateOnly(date), shiftId, divisionId, createdBy: user.name, checklist: items.map((label) => ({ label, done: false })) },
    update: {},
  });
  redirect(`/laporan/${r.id}`);
}

async function guardReport(id: string, user: Awaited<ReturnType<typeof assertPerm>>) {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id } });
  if (user.role === "KAPTEN_DIVISI" && user.divisionId && r.divisionId !== user.divisionId) throw new ForbiddenError();
  return r;
}

export const saveReport = action(
  "report.create",
  async (fd, user) => {
    const id = str(fd, "id");
    const r = await guardReport(id, user);
    const items = (r.checklist as { label: string; done: boolean }[]).map((c, i) => ({ label: c.label, done: fd.get(`check_${i}`) === "on" }));
    await prisma.shiftReport.update({
      where: { id },
      data: { checklist: items, complaints: optStr(fd, "complaints"), followUp: optStr(fd, "followUp"), followUpStatus: str(fd, "followUpStatus") || "BELUM", status: r.status === "TERKIRIM" ? "DIREVISI" : r.status },
    });
    await audit(user, "LAPORAN_DIUBAH", "ShiftReport", id);
    return "Laporan tersimpan";
  },
  ["/laporan"],
);

export const sendReport = action(
  "report.create",
  async (fd, user) => {
    const id = str(fd, "id");
    await guardReport(id, user);
    const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id }, include: { shift: true, division: true } });
    const entries = await prisma.productionEntry.groupBy({ by: ["stage"], where: { date: r.date, shiftId: r.shiftId, divisionId: r.divisionId }, _sum: { qtyGood: true, qtyReject: true } });
    const text = [
      `<b>Laporan ${esc(r.division.name)} · ${esc(r.shift.name)}</b>`,
      fmtDay(r.date),
      ...entries.map((e) => `• ${STAGE_LABEL[e.stage]}: ${e._sum.qtyGood ?? 0} pcs (reject ${e._sum.qtyReject ?? 0})`),
      r.complaints ? `\nKeluhan: ${esc(r.complaints)}` : "",
      r.followUp ? `Tindak lanjut: ${esc(r.followUp)} [${r.followUpStatus}]` : "",
      `\nDikirim oleh ${esc(user.name)}`,
    ].filter(Boolean).join("\n");
    // Kirim ke penerima laporan via Telegram bila dikonfigurasi; selalu tercatat di riwayat pengiriman
    let status = "TERKIRIM";
    let error: string | null = null;
    let channel = "SISTEM";
    if (telegramConfigured()) {
      channel = "TELEGRAM";
      const recipients = await prisma.telegramIdentity.findMany({ where: { active: true, receiveRecap: true, chatId: { not: null } } });
      const results = await Promise.all(recipients.map((x) => sendTelegram(x.chatId!, text, { type: "LAPORAN_SHIFT" })));
      const failed = results.filter((x) => !x.ok);
      if (recipients.length === 0) { status = "GAGAL"; error = "Belum ada penerima laporan di Telegram"; }
      else if (failed.length) { status = failed.length === results.length ? "GAGAL" : "SEBAGIAN"; error = failed.map((f) => f.error).join("; "); }
    }
    await prisma.$transaction([
      prisma.reportSend.create({ data: { reportId: id, sentBy: user.name, channel, status, error } }),
      prisma.shiftReport.update({ where: { id }, data: { status: status === "GAGAL" ? r.status : "TERKIRIM" } }),
    ]);
    await audit(user, "LAPORAN_DIKIRIM", "ShiftReport", id, { status, channel });
    if (status === "GAGAL") throw new Error(`Pengiriman gagal: ${error}`);
    return status === "SEBAGIAN" ? "Terkirim sebagian, cek riwayat" : "Laporan terkirim";
  },
  ["/laporan", "/"],
);
