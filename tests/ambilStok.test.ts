import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sent: { text: string; buttons?: { text: string; callback_data: string }[][] }[] = [];
vi.mock("@/lib/telegram", async (orig) => {
  const real = await orig<typeof import("@/lib/telegram")>();
  return {
    ...real,
    sendTelegram: vi.fn(async (_c: string, text: string, o: { buttons?: { text: string; callback_data: string }[][] } = {}) => (sent.push({ text, buttons: o.buttons }), { ok: true })),
    editTelegram: vi.fn(async (_c: string, _m: number, text: string, buttons?: { text: string; callback_data: string }[][]) => (sent.push({ text, buttons }), { ok: true })),
    answerCallback: vi.fn(async () => ({ ok: true })),
    chatAction: vi.fn(async () => ({ ok: true })),
  };
});

import { prisma } from "@/lib/db";
import { handleTelegramUpdate } from "@/lib/bot";
import { effectivePermissions } from "@/lib/rbac";
import { StockError, locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { FLOW_SETTING, flowItem, postShiftWork } from "@/lib/shiftReportFlow";
import { ambilHistory, ambilRecapLines, ambilStok, cancelAmbil, divisionLocationId, kembalikanStok } from "@/lib/ambilStok";
import { dateOnly, jakartaDateTime } from "@/lib/time";

const actor = { id: "system", name: "Tes" };
const year = 2100 + Math.floor(Math.random() * 800);
let wip: string, cewek: string, s1: string, prevFlag: string | null;

beforeAll(async () => {
  wip = (await locationSettings(prisma)).wip!;
  cewek = await prisma.$transaction((tx) => flowItem(tx, { kind: "kering", key: "Cewek" }));
  s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
  prevFlag = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value ?? null;
  await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: cewek, qty: 500, toLocationId: wip, unitCost: 300, ref: `TES:AMB${year}` }, actor));
});

describe("Ambil stok patung kering", () => {
  it("transfer Oven → lokasi divisi: harga rata-rata ikut, tanpa jurnal; ditolak bila melebihi stok Oven; izin stock.take", async () => {
    const o0 = await qtyAt(prisma, cewek, wip);
    const avg0 = Number((await prisma.item.findUniqueOrThrow({ where: { id: cewek } })).avgCost);
    const j0 = await prisma.journal.count();
    const r = await ambilStok({ itemId: cewek, qty: 40, division: "GIFTBOX" }, actor);
    const loc = (await divisionLocationId(prisma, "GIFTBOX"))!;
    expect(loc).toBeTruthy();
    expect(r.ref).toMatch(/^AMBIL:AMB-/);
    expect(await qtyAt(prisma, cewek, wip)).toBe(o0 - 40);
    expect(await qtyAt(prisma, cewek, loc)).toBeGreaterThanOrEqual(40);
    expect(Number((await prisma.item.findUniqueOrThrow({ where: { id: cewek } })).avgCost)).toBe(avg0);
    expect(await prisma.journal.count()).toBe(j0); // bukan laba rugi
    await expect(ambilStok({ itemId: cewek, qty: 1_000_000, division: "GIFTBOX" }, actor)).rejects.toBeInstanceOf(StockError);
    await expect(ambilStok({ itemId: cewek, qty: 0, division: "GIFTBOX" }, actor)).rejects.toBeInstanceOf(StockError);
    for (const role of ["OPERATOR", "KAPTEN_DIVISI", "SUPERVISOR", "ADMIN", "ADMIN_PRODUKSI", "OWNER"] as const) expect(effectivePermissions(role, []).has("stock.take")).toBe(true);
    expect(effectivePermissions("DRIVER", []).has("stock.take")).toBe(false);
    expect((await ambilHistory(10)).some((h) => h.number === r.number && !h.cancelled)).toBe(true);

    // kembalikan sisa ke Oven, lalu batal sekali
    const b = await kembalikanStok({ itemId: cewek, qty: 5, division: "GIFTBOX" }, actor);
    expect(await qtyAt(prisma, cewek, wip)).toBe(o0 - 35);
    await expect(cancelAmbil(b.number, "", actor)).rejects.toThrow(/Alasan/);
    await cancelAmbil(b.number, "salah", actor);
    expect(await qtyAt(prisma, cewek, wip)).toBe(o0 - 40);
    await expect(cancelAmbil(b.number, "lagi", actor)).rejects.toThrow(/sudah dibatalkan/);
    await cancelAmbil(r.number, "bersih", actor);
    expect(await qtyAt(prisma, cewek, wip)).toBe(o0);
  });

  it("laporan shift Giftbox memakai stok divisi dulu, sisanya dari Oven; rekap awal + ambil − pakai = akhir", async () => {
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    try {
      const date = `${year}-03-05`;
      const gft = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "GIFTBOX" } });
      await ambilStok({ itemId: cewek, qty: 30, division: "GIFTBOX", date: jakartaDateTime(date, "06:00") }, actor);
      const loc = (await divisionLocationId(prisma, "GIFTBOX"))!;
      const d0 = await qtyAt(prisma, cewek, loc), o0 = await qtyAt(prisma, cewek, wip);
      // 2 giftbox CEW = 10 patung kering Cewek: semuanya dari stok divisi
      const rep = await prisma.shiftReport.create({ data: { date: dateOnly(date), shiftId: s1, divisionId: gft.id, createdBy: "uji", work: { giftbox: { CEW: 2 } } } });
      await postShiftWork(rep.id, actor, jakartaDateTime(date, "20:00"));
      expect(await qtyAt(prisma, cewek, loc)).toBe(d0 - 10);
      expect(await qtyAt(prisma, cewek, wip)).toBe(o0);
      const lines = await ambilRecapLines(rep.id);
      expect(lines.join("\n")).toMatch(/AWAL|STOK PATUNG KERING DIVISI/);
      expect(lines.join("\n")).toMatch(/− 10 = /); // stok awal + ambil − kembali − pakai = akhir
      // 12 giftbox = 60 patung: sisa stok divisi habis, kekurangannya dari Oven
      const left = await qtyAt(prisma, cewek, loc);
      const rep2 = await prisma.shiftReport.create({ data: { date: dateOnly(`${year}-03-06`), shiftId: s1, divisionId: gft.id, createdBy: "uji", work: { giftbox: { CEW: 12 } } } });
      await postShiftWork(rep2.id, actor, jakartaDateTime(`${year}-03-06`, "20:00"));
      expect(await qtyAt(prisma, cewek, loc)).toBe(0);
      expect(await qtyAt(prisma, cewek, wip)).toBe(o0 - (60 - left));
    } finally {
      await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: prevFlag ?? "false" }, update: { value: prevFlag ?? "false" } });
    }
  });
});

describe("Bot: Ambil stok", () => {
  const TG = 777006;
  const chat = { id: TG };
  const from = { id: TG, first_name: "Owner" };
  let n = Math.floor(Date.now() / 1000) % 1_000_000_000;
  const tap = (data: string) => handleTelegramUpdate({ update_id: n, callback_query: { id: String(n++), from, data, message: { message_id: 1, chat } } } as never);
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    await prisma.telegramIdentity.upsert({ where: { telegramUserId: String(TG) }, create: { telegramUserId: String(TG), userId: u.id, chatId: String(TG) }, update: { active: true } });
  });
  beforeEach(async () => { sent.length = 0; await prisma.botSession.deleteMany({ where: { chatId: String(TG) } }); });

  it("pilih divisi (bila belum ada) → karakter → jumlah (tombol) → tersimpan", async () => {
    await tap("f:start:amb");
    await tap("f:ASSEMBLING");
    expect(sent.at(-1)!.buttons!.flat().map((b) => b.callback_data)).toContain(`f:${cewek}`);
    await tap(`f:${cewek}`);
    const o0 = await qtyAt(prisma, cewek, wip);
    await tap("f:10");
    expect(await qtyAt(prisma, cewek, wip)).toBe(o0 - 10);
    expect(sent.at(-1)!.text).toMatch(/Ambil stok AMB/);
  });

  it('ketik bebas "ambil 7 patung kering cewek" → langsung tombol konfirmasi Ambil 7 (pengguna berdivisi Assembling)', async () => {
    const asm = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "ASSEMBLING" } });
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const old = u.divisionId;
    await prisma.user.update({ where: { id: u.id }, data: { divisionId: asm.id } });
    try {
      await handleTelegramUpdate({ update_id: n, message: { message_id: n++, chat, from, text: "ambil 7 patung kering cewek" } } as never);
      expect(sent.at(-1)!.buttons!.flat().map((b) => b.callback_data)).toContain("f:7");
      const o0 = await qtyAt(prisma, cewek, wip);
      await tap("f:7");
      expect(await qtyAt(prisma, cewek, wip)).toBe(o0 - 7);
    } finally {
      await prisma.user.update({ where: { id: u.id }, data: { divisionId: old } });
    }
  });
});
