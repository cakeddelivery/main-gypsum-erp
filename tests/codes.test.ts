import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { abbreviate, autoCode } from "@/lib/codes";

describe("Kode otomatis", () => {
  it("singkatan nama mengikuti pola kode yang sudah ada", () => {
    expect(abbreviate("Divisi Cetak")).toBe("CTK");
    expect(abbreviate("Produksi")).toBe("PRD");
    expect(abbreviate("Packing")).toBe("PCK");
    expect(abbreviate("Giftbox")).toBe("GFT");
    expect(abbreviate("Assembling")).toBe("ASM");
    expect(abbreviate("Gudang Bahan Baku")).toBe("GBB");
    expect(abbreviate("QC & Packing")).toBe("QCP");
    expect(abbreviate("Main Gypsum", 2)).toBe("MG");
    expect(abbreviate("Dunia Lukis", 2)).toBe("DL");
  });

  it("karyawan memakai awalan divisi, kode terpakai dilewati", async () => {
    const div = await prisma.division.findUniqueOrThrow({ where: { code: "CTK" } });
    const a = await autoCode.employee(prisma, div.id);
    expect(a).toMatch(/^CTK-\d{3}$/);
    await prisma.employee.create({ data: { code: a, name: "Tes Kode", divisionId: div.id, position: "Tes" } });
    const b = await autoCode.employee(prisma, div.id);
    expect(b).not.toBe(a);
    expect(b).toMatch(/^CTK-\d{3}$/);
  });

  it("COA ikut digit tipe, divisi/shift/rekening/supplier unik", async () => {
    expect(await autoCode.coa(prisma, "BEBAN")).toBe("6-2000");
    expect(await autoCode.coa(prisma, "HPP")).toBe("5-1200");
    expect(await autoCode.division(prisma, "Divisi Cetak Baru")).toBe("CTB");
    expect(await autoCode.division(prisma, "Cetak")).toBe("CTK2");
    expect(await autoCode.shift(prisma)).toBe("S3");
    expect(await autoCode.bank(prisma, "Seabank")).toBe("SEABANK2");
    expect(await autoCode.supplier(prisma)).toMatch(/^SUP-\d{3}$/);
    expect(await autoCode.pieceTask(prisma)).toMatch(/^BRG-\d{3}$/);
    expect(await autoCode.payrollPeriod(prisma, new Date("2026-11-02T00:00:00+07:00"))).toBe("GJ-20261102");
  });
});
