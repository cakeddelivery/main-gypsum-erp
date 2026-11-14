import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE_LIST } from "@/lib/panduan";
import { SHOTS_DIR, guideShots } from "@/lib/panduanAccess";

describe("Gambar layar panduan", () => {
  const used = [...new Set(GUIDE_LIST.flatMap((g) => g.phases.map((p) => p.shot).filter((s): s is string => !!s)))];

  it("semua gambar layar yang dirujuk panduan ada di public/panduan/shots dan ikut repo", () => {
    expect(used.length).toBeGreaterThan(0);
    for (const s of used) {
      const f = path.join(SHOTS_DIR, `${s}.png`);
      expect(fs.existsSync(f), `${s}.png tidak ada`).toBe(true);
      expect(fs.statSync(f).size).toBeGreaterThan(1000);
    }
  });

  it("ditanam sebagai data URI PNG (tidak bergantung pada penyajian file statis)", () => {
    const shots = guideShots();
    for (const s of used) {
      expect(shots[s]?.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
    }
  });
});
