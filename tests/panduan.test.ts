import { describe, expect, it } from "vitest";
import { GUIDE_LIST, guideForTemplate, reportSteps, GUIDES } from "@/lib/panduan";
import { REPORT_TEMPLATES } from "@/lib/shiftReport";

describe("Lembar Panduan divisi", () => {
  it("setiap format laporan punya satu panduan", () => {
    expect(REPORT_TEMPLATES.map((t) => guideForTemplate(t))).toEqual(["produksi", "cetak", "giftbox", "packing", "assembling"]);
    expect(GUIDE_LIST).toHaveLength(REPORT_TEMPLATES.length);
    expect(guideForTemplate(null)).toBeNull();
  });
  it("tahap form sesuai aplikasi: Assembling tanpa Hasil kerja; penerima borongan hanya Giftbox & Assembling", () => {
    expect(reportSteps(GUIDES.giftbox)).toEqual(["Hasil kerja", "Checklist", "Stok jadi", "Stok akhir", "Catatan & kirim"]);
    expect(reportSteps(GUIDES.assembling)[0]).toBe("Checklist");
    expect(GUIDE_LIST.filter((g) => g.terima).map((g) => g.kind).sort()).toEqual(["assembling", "giftbox"]);
  });
});
