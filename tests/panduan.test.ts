import { describe, expect, it } from "vitest";
import { GUIDES, GUIDE_LIST, allowedGuides, guideForTemplate, richParts } from "@/lib/panduan";
import { REPORT_TEMPLATES } from "@/lib/shiftReport";

describe("Lembar Panduan", () => {
  it("setiap format laporan punya satu panduan divisi, plus Supervisor, Finance, Owner", () => {
    expect(REPORT_TEMPLATES.map((t) => guideForTemplate(t))).toEqual(["produksi", "cetak", "giftbox", "packing", "assembling"]);
    expect(GUIDE_LIST.map((g) => g.id)).toEqual(["cetak", "produksi", "giftbox", "packing", "assembling", "supervisor", "finance", "owner"]);
    expect(guideForTemplate(null)).toBeNull();
  });

  it("izin: anggota hanya divisinya, Supervisor role + divisi, Finance role-nya, Owner semua", () => {
    expect(allowedGuides("OPERATOR", "GIFTBOX")).toEqual(["giftbox"]);
    expect(allowedGuides("KAPTEN_DIVISI", "PACKING")).toEqual(["packing"]);
    expect(allowedGuides("OPERATOR", null)).toEqual([]);
    expect(allowedGuides("SUPERVISOR", null)[0]).toBe("supervisor");
    expect(allowedGuides("SUPERVISOR", null)).not.toContain("owner");
    expect(allowedGuides("FINANCE", "GIFTBOX")).toEqual(["finance"]);
    expect(allowedGuides("OWNER", null)).toHaveLength(8);
  });

  it("tahap form sesuai aplikasi; Penerimaan borongan: Giftbox, Assembling (Cat Plastik), Packing (patung)", () => {
    const flow = (id: keyof typeof GUIDES) => GUIDES[id].phases.find((p) => p.flow)?.flow;
    expect(flow("giftbox")).toEqual(["Hasil kerja", "Checklist", "Stok jadi", "Stok akhir", "Catatan & kirim"]);
    expect(flow("assembling")?.[0]).toBe("Checklist");
    const receives = GUIDE_LIST.filter((g) => g.phases.some((p) => p.items.some((t) => t.includes("«Terima setoran borongan»") && t.startsWith("Hasil borongan datang")))).map((g) => g.id);
    expect(receives.sort()).toEqual(["assembling", "giftbox", "packing"]);
  });

  it("penanda teks: «tombol» dan **tebal**", () => {
    expect(richParts("Tekan «Masuk» lalu **cek**.")).toEqual([
      { t: "txt", v: "Tekan " }, { t: "btn", v: "Masuk" }, { t: "txt", v: " lalu " }, { t: "b", v: "cek" }, { t: "txt", v: "." },
    ]);
  });
});
