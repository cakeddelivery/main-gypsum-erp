import { afterAll, describe, expect, it, vi } from "vitest";

const sent: { chat: string; filename: string; caption: string }[] = [];
vi.mock("@/lib/telegram", async (orig) => ({
  ...(await orig<typeof import("@/lib/telegram")>()),
  telegramConfigured: () => true,
  sendTelegramDocument: vi.fn(async (chat: string, _f: Buffer, filename: string, caption: string) => (sent.push({ chat, filename, caption }), { ok: true })),
}));
const render = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff]));
vi.mock("@/lib/render", () => ({ renderDocJpg: (...a: unknown[]) => render(...(a as [])), RenderError: class extends Error {} }));

import { prisma } from "@/lib/db";
import { mainMetric, metricText, recapByDivision, recapLine, type RecapInput } from "@/lib/shiftReport";
import { sendShiftReportJpg } from "@/lib/shiftReportJpg";
import { GROUP_SETTING } from "@/lib/botGroup";
import { dateOnly } from "@/lib/time";

const d = new Date("2027-11-01T00:00:00Z");
const rows: RecapInput[] = [
  { date: d, shift: "Shift 1", division: "Divisi Produksi", template: "PRODUKSI", target: 2400, work: { panen: [{ name: "Oven Besar", v: [300, 300, 700, 300] }, { name: "Oven Kecil", v: [null, null, null, 700] }], cetak: [{ name: "RIKO", v: [1720] }] } },
  { date: d, shift: "Shift 2", division: "Divisi Produksi", template: "PRODUKSI", target: 2400, work: { panen: [{ name: "Oven Besar", v: [200, 800, 100, 100] }, { name: "Oven Kecil", v: [null, 300, null, 500] }], reject: [{ name: "Oven Besar", v: [10, null, null, null] }], cetak: [{ name: "YOGA", v: [1703] }] } },
  { date: d, shift: "Shift 1", division: "Divisi Packing", template: "PACKING", target: null, work: { resi: { shopee: 57, tiktok: 81 }, mix: { p12: 5, p24: 17, p48: 9, p96: 1 }, satuan: { cowok: 22, cewek: 23, transportasi: 200, hewan: 171 } } },
];

describe("Rekap laporan shift", () => {
  it("dijumlah per divisi + capaian target gabungan", () => {
    const r = recapByDivision(rows);
    expect(r).toHaveLength(2);
    const prd = r.find((x) => x.division === "Divisi Produksi")!;
    expect(prd.reports).toBe(2);
    expect(prd.metrics.map(metricText)).toEqual(["Total panen: 4.300 pcs", "Total hasil cetak: 3.423 pcs", "Total reject: 10 pcs"]);
    // (2.300 + 2.000) / (2 × 2.400) = 90%
    expect(prd.target).toMatchObject({ value: 4300, target: 4800, pct: 90, label: "panen" });
    const pck = r.find((x) => x.division === "Divisi Packing")!;
    expect(pck.metrics.map(metricText)).toEqual(["Total resi: 138", "Total patung: 1.412 pcs"]);
    expect(pck.target).toBeNull();
  });
  it("baris harian & angka utama", () => {
    expect(recapLine(rows[0])).toEqual({ text: "Total panen: 2.300 pcs · Total hasil cetak: 1.720 pcs", pct: 96 });
    expect(mainMetric("PACKING", rows[2].work)).toEqual({ label: "patung", unit: "pcs", value: 1412 });
  });
});

describe("JPG laporan shift ke Telegram", () => {
  let prevGroups: string | null = null;
  afterAll(async () => {
    // Jangan bocor ke tes lain (cek saldo, pengingat grup)
    await prisma.telegramIdentity.deleteMany({ where: { telegramUserId: "uji-jpg-1" } });
    if (prevGroups == null) await prisma.setting.deleteMany({ where: { key: GROUP_SETTING } });
    else await prisma.setting.update({ where: { key: GROUP_SETTING }, data: { value: prevGroups } });
  });
  it("dikirim ke penerima rekap + grup terdaftar (tanpa dobel); gagal render dicatat", async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    await prisma.telegramIdentity.deleteMany({ where: { telegramUserId: "uji-jpg-1" } });
    await prisma.telegramIdentity.create({ data: { telegramUserId: "uji-jpg-1", chatId: "111", userId: owner.id, active: true, receiveRecap: true } });
    prevGroups = (await prisma.setting.findUnique({ where: { key: GROUP_SETTING } }))?.value ?? null;
    await prisma.setting.upsert({ where: { key: GROUP_SETTING }, create: { key: GROUP_SETTING, value: "-100200,111" }, update: { value: "-100200,111" } });
    const div = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } });
    const r = await prisma.shiftReport.create({ data: { date: dateOnly("2027-11-02"), shiftId: shift.id, divisionId: div.id, createdBy: "uji" } });
    const res = await sendShiftReportJpg(r.id, owner.id, "Total resi: 138");
    expect(render).toHaveBeenCalledWith(owner.id, `/laporan/${r.id}`, "report-preview");
    const chats = sent.map((x) => x.chat);
    expect(chats).toEqual(expect.arrayContaining(["111", "-100200"]));
    expect(chats.filter((c) => c === "111")).toHaveLength(1);
    expect(res.sent).toBe(chats.length);
    expect(sent[0].filename).toBe(`laporan-${div.code}-S1-2027-11-02.jpg`);
    expect(sent[0].caption).toContain("Total resi: 138");

    render.mockRejectedValueOnce(new Error("Chromium belum terpasang"));
    const fail = await sendShiftReportJpg(r.id, owner.id, "");
    expect(fail.sent).toBe(0);
    expect(await prisma.notificationLog.count({ where: { type: "LAPORAN_SHIFT_JPG", status: "GAGAL", target: r.id } })).toBe(1);
  });
});
