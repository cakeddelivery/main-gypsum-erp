import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { DEFAULT_MATRIX, SENSITIVE, applyMenuChoice, effectivePermissions, sensitiveGrants } from "@/lib/rbac";
import { financeRecapRecipients } from "@/lib/jobs";

describe("Izin sensitif untuk role lapangan", () => {
  it("bawaan role lapangan tidak memuat izin keuangan", () => {
    for (const r of ["OPERATOR", "KAPTEN_DIVISI", "SUPERVISOR", "KOORDINATOR", "PIC_CONTENT"] as const) {
      expect(DEFAULT_MATRIX[r].filter((p) => SENSITIVE.includes(p))).toEqual([]);
    }
  });

  it("memberi dashboard.finance ke Operator terdeteksi; ke Finance tidak dipersoalkan", () => {
    const op = effectivePermissions("OPERATOR", []);
    const opAfter = effectivePermissions("OPERATOR", [{ role: "OPERATOR", permission: "dashboard.finance", allowed: true }]);
    expect(sensitiveGrants("OPERATOR", op, opAfter)).toEqual(["dashboard.finance"]);
    expect(sensitiveGrants("OPERATOR", opAfter, opAfter)).toEqual([]); // sudah punya sebelumnya: tidak diperingatkan ulang
    const fin = effectivePermissions("FINANCE", []);
    expect(sensitiveGrants("FINANCE", new Set(), fin)).toEqual([]);
  });

  it("menyalakan menu Transaksi untuk Kapten = izin sensitif (perlu konfirmasi)", () => {
    const cur = effectivePermissions("KAPTEN_DIVISI", []);
    const enabled = new Set(["dashboard", "production", "report", "attendance", "stock", "employee", "payroll", "finance"]);
    expect(sensitiveGrants("KAPTEN_DIVISI", cur, applyMenuChoice("KAPTEN_DIVISI", cur, enabled))).toContain("finance.view");
  });
});

describe("Rekap harian keuangan (bot 07.00)", () => {
  it("hanya ke akun yang punya izin dashboard.finance, walau 'terima rekap' dicentang", async () => {
    const op = await prisma.user.findUniqueOrThrow({ where: { username: "operator" } });
    const own = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    await prisma.telegramIdentity.create({ data: { telegramUserId: "990000001", chatId: "990000001", userId: op.id, receiveRecap: true, active: true } });
    await prisma.telegramIdentity.create({ data: { telegramUserId: "990000002", chatId: "990000002", userId: own.id, receiveRecap: true, active: true } });
    const ids = (await financeRecapRecipients()).map((x) => x.telegramUserId);
    expect(ids).toContain("990000002");
    expect(ids).not.toContain("990000001");
    // Owner sengaja memberi Operator izin keuangan → ikut menerima
    await prisma.rolePermission.create({ data: { role: "OPERATOR", permission: "dashboard.finance", allowed: true } });
    expect((await financeRecapRecipients()).map((x) => x.telegramUserId)).toContain("990000001");
    await prisma.rolePermission.deleteMany({ where: { role: "OPERATOR", permission: "dashboard.finance" } });
  });
});
