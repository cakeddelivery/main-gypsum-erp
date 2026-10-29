import { describe, expect, it } from "vitest";
import { bottomNavFor, PRIORITY_NAV } from "@/lib/nav";
import { DEFAULT_MATRIX, ROLES, type Permission } from "@/lib/rbac";
import { contrast, PALETTES, SURFACE, themeVars } from "@/lib/themePalette";

const canFor = (perms: Permission[]) => (p: Permission) => perms.includes(p);
const hex = (rgb: string) => "#" + rgb.split(" ").map((n) => Number(n).toString(16).padStart(2, "0")).join("");

describe("Navigasi bawah per role", () => {
  it("setiap role mendapat menu prioritasnya (maks. 5) yang memang diizinkan", () => {
    for (const role of ROLES) {
      const items = bottomNavFor(role, canFor(DEFAULT_MATRIX[role]));
      expect(items.length).toBeLessThanOrEqual(5);
      expect(items.map((i) => i.href)).toEqual(PRIORITY_NAV[role].slice(0, 5));
    }
  });
  it("menu yang dicabut lewat override diganti menu lain yang diizinkan", () => {
    const perms = DEFAULT_MATRIX.OPERATOR.filter((p) => p !== "report.view");
    const items = bottomNavFor("OPERATOR", canFor([...perms, "stock.view"]));
    expect(items.map((i) => i.href)).toEqual(["/", "/produksi", "/absensi", "/gaji", "/stok"]);
  });
});

describe("Kontras warna teks (WCAG AA)", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`mode ${mode}: teks shade 400–950 ≥ 4.5:1 di atas kartu & tint`, () => {
      const v = themeVars(mode);
      const card = mode === "light" ? SURFACE.light.card : SURFACE.dark.card;
      for (const name of Object.keys(PALETTES)) {
        for (const s of ["400", "500", "600", "700", "800", "900", "950"]) {
          const tx = hex(v[`--tx-${name}-${s}`]);
          expect(contrast(tx, card), `${mode} text-${name}-${s}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(tx, hex(v[`--bg-${name}-50`])), `${mode} text-${name}-${s} di bg-${name}-50`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
