import { describe, expect, it } from "vitest";
import { canSeeDivision, reportDivision } from "@/lib/reportScope";

describe("Laporan shift: karyawan hanya divisinya sendiri", () => {
  it("pengelola melihat semua divisi", () => {
    for (const role of ["OWNER", "ADMIN", "ADMIN_PRODUKSI", "SUPERVISOR", "FINANCE"] as const) {
      expect(reportDivision({ role, divisionId: "d1", employeeId: "e1" })).toBeNull();
      expect(canSeeDivision({ role, divisionId: "d1" }, "d2")).toBe(true);
    }
  });
  it("kapten & operator hanya divisinya; tanpa divisi tidak melihat apa pun", () => {
    expect(reportDivision({ role: "KAPTEN_DIVISI", divisionId: "d1" })).toBe("d1");
    expect(canSeeDivision({ role: "OPERATOR", divisionId: "d1" }, "d2")).toBe(false);
    expect(canSeeDivision({ role: "OPERATOR", divisionId: "d1" }, "d1")).toBe(true);
    expect(reportDivision({ role: "OPERATOR", divisionId: null })).toBe("-");
  });
  it("akun lain yang tertaut ke data karyawan ikut dibatasi", () => {
    expect(reportDivision({ role: "PIC_CONTENT", divisionId: "d3", employeeId: "e9" })).toBe("d3");
    expect(reportDivision({ role: "PIC_CONTENT", divisionId: null, employeeId: null })).toBeNull();
  });
});

import { effectivePermissions } from "@/lib/rbac";
describe("Anggota tidak input hasil produksi sendiri", () => {
  it("bawaan Operator & Kapten tanpa production.create; override Owner tetap berlaku", () => {
    expect(effectivePermissions("OPERATOR", []).has("production.create")).toBe(false);
    expect(effectivePermissions("KAPTEN_DIVISI", []).has("production.create")).toBe(false);
    expect(effectivePermissions("SUPERVISOR", []).has("production.create")).toBe(true);
    expect(effectivePermissions("OPERATOR", [{ role: "OPERATOR", permission: "production.create", allowed: true }] as never).has("production.create")).toBe(true);
  });
});

describe("Divisi anggota mengikuti data karyawannya", () => {
  it("divisi karyawan menang atas kolom divisi akun yang tertinggal", () => {
    const delta = { role: "OPERATOR" as const, divisionId: "asm", employeeId: "e1", employee: { divisionId: "pck" } };
    expect(reportDivision(delta)).toBe("pck");
    expect(canSeeDivision(delta, "asm")).toBe(false);
    expect(canSeeDivision(delta, "pck")).toBe(true);
    expect(reportDivision({ role: "KAPTEN_DIVISI" as const, divisionId: "ctk", employee: null })).toBe("ctk");
  });
});
