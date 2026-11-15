import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { assertReturnItems, divisionReturGrant, returnItemOptions, returnItemScope } from "@/lib/returnScope";
import { loadUser } from "@/lib/auth";
import { returnSetting } from "@/lib/returns";

describe("Retur untuk divisi Giftbox & Packing", () => {
  it("hanya anggota Giftbox/Packing yang mendapat izin retur (bukan divisi lain)", () => {
    expect(divisionReturGrant("OPERATOR", "PACKING")).toBe(true);
    expect(divisionReturGrant("KAPTEN_DIVISI", "GIFTBOX")).toBe(true);
    expect(divisionReturGrant("OPERATOR", "ASSEMBLING")).toBe(false);
    expect(divisionReturGrant("OPERATOR", null)).toBe(false);
    expect(divisionReturGrant("FINANCE", "PACKING")).toBe(false);
  });

  it("anggota Packing: izin retur tanpa refund; produk hanya barang jadi Packing; Supervisor/Owner semua", async () => {
    const packing = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "PACKING" } });
    const giftbox = await prisma.division.findFirstOrThrow({ where: { reportTemplate: "GIFTBOX" } });
    const mk = (name: string, divisionId: string) => prisma.item.create({ data: { sku: `TES-RTR-${name}`, name: `Tes retur ${name}`, type: "BARANG_JADI", unit: "pcs", divisionId } });
    const pk = await mk("PK", packing.id);
    const gb = await mk("GB", giftbox.id);
    const op = await prisma.user.findUniqueOrThrow({ where: { username: "operator" } });
    const before = op.divisionId;
    await prisma.user.update({ where: { id: op.id }, data: { divisionId: packing.id } });
    const emp = op.employeeId ? await prisma.employee.findUnique({ where: { id: op.employeeId } }) : null;
    if (emp) await prisma.employee.update({ where: { id: emp.id }, data: { divisionId: packing.id } });
    try {
      const u = (await loadUser(op.id, op.sessionVersion))!;
      expect(u.can("retur.manage")).toBe(true);
      expect(u.can("refund.request")).toBe(false);
      const scope = (await returnItemScope(u))!;
      expect(scope).toContain(pk.id);
      expect(scope).not.toContain(gb.id);
      expect((await returnItemOptions(u)).some((i) => i.id === gb.id)).toBe(false);
      await expect(assertReturnItems(u, [pk.id, null])).resolves.toBeUndefined();
      await expect(assertReturnItems(u, [gb.id])).rejects.toThrow(/di luar produk jadi divisi/);
      // Pengelola tidak dibatasi
      expect(await returnItemScope({ role: "SUPERVISOR", divisionId: null })).toBeNull();
      expect(await returnItemScope({ role: "OWNER", divisionId: null })).toBeNull();
    } finally {
      await prisma.user.update({ where: { id: op.id }, data: { divisionId: before } });
      if (emp) await prisma.employee.update({ where: { id: emp.id }, data: { divisionId: emp.divisionId } });
      await prisma.item.deleteMany({ where: { id: { in: [pk.id, gb.id] } } });
    }
  });

  it("durasi maksimal video unboxing bawaan 10 menit", async () => {
    await prisma.setting.deleteMany({ where: { key: "retur_video_maks_menit" } });
    expect(await returnSetting("videoMaxMinutes")).toBe(10);
  });
});
