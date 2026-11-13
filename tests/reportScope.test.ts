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
