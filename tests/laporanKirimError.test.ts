import { describe, expect, it } from "vitest";
import { friendly } from "@/lib/action";
import { missingStockCounts } from "@/lib/shiftResultCount";

describe("Pesan error kirim laporan shift", () => {
  it("stok akhir belum diisi (daftar panjang >200 huruf) tampil lengkap, bukan 'Terjadi kesalahan' generik", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, name: `Giftbox Karakter Panjang ${i}` }));
    const msg = missingStockCounts([], items, {})!;
    expect(msg.length).toBeGreaterThan(200);
    expect(friendly(new Error(msg))).toBe(msg);
    expect(msg).toMatch(/Stok akhir belum diisi/);
  });
  it("pesan internal (Prisma/stack) tetap disamarkan", () => {
    expect(friendly(new Error("Invalid `prisma.shiftReport.update()` invocation: " + "x".repeat(50)))).toBe("Terjadi kesalahan. Silakan coba lagi.");
    expect(friendly(new Error("x".repeat(700)))).toBe("Terjadi kesalahan. Silakan coba lagi.");
    expect(friendly(new Error("Lampirkan foto dulu: a, b"))).toBe("Lampirkan foto dulu: a, b");
  });
});

import { prisma } from "@/lib/db";
import { FLOW_SETTING, postShiftWork } from "@/lib/shiftReportFlow";
import { applyResultCount } from "@/lib/shiftResultCount";
import { dateOnly, jakartaDateTime } from "@/lib/time";

describe("Posting laporan Packing/Giftbox saat stok kurang atau hasil kosong tidak melempar error", () => {
  it("Packing hasil produk jadi dengan stok 0, Giftbox hasil kosong: terposting, stok boleh minus (ditandai), tanpa exception", async () => {
    const prev = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value ?? null;
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    try {
      const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
      const actor = { id: u.id, name: u.name };
      const s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
      const year = 2900 + Math.floor(Math.random() * 90);
      const date = `${year}-11-28`;
      const pck = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
      const gft = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "GIFTBOX" } });
      const r1 = await prisma.shiftReport.create({ data: { date: dateOnly(date), shiftId: s1, divisionId: pck.id, createdBy: "uji", work: { satuan: { hewan: 777, cowok: 625, transportasi: 644, cewek: 618 } } } });
      const r2 = await prisma.shiftReport.create({ data: { date: dateOnly(date), shiftId: s1, divisionId: gft.id, createdBy: "uji", work: {} } });
      const at = jakartaDateTime(date, "20:00");
      await expect(postShiftWork(r1.id, actor, at)).resolves.toBeTruthy();
      await expect(applyResultCount(r1.id, actor, at)).resolves.toBeTruthy();
      await expect(postShiftWork(r2.id, actor, at)).resolves.toBeTruthy();
      await expect(applyResultCount(r2.id, actor, at)).resolves.toBeTruthy();
    } finally {
      await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: prev ?? "false" }, update: { value: prev ?? "false" } });
    }
  });
});

import { parseResultCount } from "@/lib/shiftResultCount";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";

describe("Stok akhir: bawaan stok sistem / 0, kosong tidak gagal", () => {
  it("kolom kosong dilewati (tidak error, tidak dihitung); koma desimal terbaca; titik = ribuan", () => {
    expect(parseResultCount(["a", "b", "c"], (k) => ({ "rc.a": "", "rc.b": "12,5", "rc.c": "1.200" })[k] ?? null)).toEqual({ b: 12.5, c: 1200 });
  });
  it("nilai bawaan = stok sistem → tidak ada penyesuaian LPS; 0 untuk barang bernilai → penyesuaian ke 0", async () => {
    const prev = (await prisma.setting.findUnique({ where: { key: FLOW_SETTING } }))?.value ?? null;
    await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: "true" }, update: { value: "true" } });
    try {
      const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
      const actor = { id: u.id, name: u.name };
      const s1 = (await prisma.shift.findUniqueOrThrow({ where: { code: "S1" } })).id;
      const year = 3000 + Math.floor(Math.random() * 90);
      const date = `${year}-05-05`;
      const locs = await locationSettings(prisma);
      const pck = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
      const tag = `HF${Date.now().toString(36)}`;
      const item = await prisma.item.create({ data: { sku: `${tag}`, name: `Jadi ${tag}`, type: "BARANG_JADI", unit: "pcs", divisionId: pck.id } as never });
      await prisma.$transaction((tx) => recordMovement(tx, { type: "PENERIMAAN", itemId: item.id, qty: 40, toLocationId: locs.finished!, unitCost: 100, date: jakartaDateTime(date, "06:00") }, actor));
      const at = jakartaDateTime(date, "20:00");
      const mk = (counts: Record<string, number>) => prisma.shiftReport.create({ data: { date: dateOnly(date), shiftId: s1, divisionId: pck.id, createdBy: "uji", work: { _hasil: counts } } });
      const same = await mk({ [item.id]: 40 }); // bawaan = stok sistem
      expect((await applyResultCount(same.id, actor, at)).adjusted).toBe(0);
      expect(await qtyAt(prisma, item.id, locs.finished!, at)).toBe(40);
      await prisma.shiftReport.delete({ where: { id: same.id } });
      const zero = await mk({ [item.id]: 0 }); // 0 (mis. bawaan produk jadi) → stok sistem jadi 0
      expect((await applyResultCount(zero.id, actor, at)).adjusted).toBeGreaterThan(0);
      expect(await qtyAt(prisma, item.id, locs.finished!, at)).toBe(0);
    } finally {
      await prisma.setting.upsert({ where: { key: FLOW_SETTING }, create: { key: FLOW_SETTING, value: prev ?? "false" }, update: { value: prev ?? "false" } });
    }
  });
});
