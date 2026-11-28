import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import { ReportSheet } from "@/app/(app)/laporan/[id]/ReportSheet";
import type { ResultRow } from "@/lib/shiftResultCount";
import type { ChecklistEntry } from "@/lib/shiftReport";

const lh = { name: "Main Gypsum", tagline: "Perlengkapan", address: "Alamat contoh", phone: "0800-0000", city: "Kota", email: "", website: "" } as never;
const rr = (n: number, counted: number, system: number): ResultRow => ({ itemId: `i${n}`, name: `Giftbox contoh ${n}`, unit: "box", counted, system, diff: counted - system, big: Math.abs(counted - system) > 20 });
const rows: ResultRow[] = [rr(1, 12, 12), rr(2, 5, 9), ...Array.from({ length: 41 }, (_, i) => rr(i + 3, 0, 0)), rr(50, 0, 3)];
const checklist: ChecklistEntry[] = Array.from({ length: 7 }, (_, i) => ({ label: `Tugas penutupan ${i + 1}`, done: i < 6 })) as never;

const sheet = () => renderToStaticMarkup(
  <ReportSheet
    id="x" date="2026-11-28" division="Giftbox" shift="Shift 1" pic="PIC Contoh" template={null} work={{}} checklist={checklist}
    stock={[{ itemId: "a", name: "Lem contoh", unit: "kg", limit: 10, qty: 4 }, { itemId: "b", name: "Cat contoh", unit: "kg", limit: 5, qty: 20 }]}
    complaints={null} followUp={null} followUpStatus="" legacyLines={["Hasil contoh: 120 box"]} resultRows={rows} lh={lh}
  />,
);

describe("JPG Laporan Penutup Shift", () => {
  it("lebar ekspor 1080; stok akhir hanya yang bernilai/berselisih + rangkuman item 0; kartu 2 kolom; checklist 2 kolom", () => {
    const html = sheet();
    expect(html).toContain('data-export-width="1080"');
    expect(html).toContain("report-doc");
    // tabel Barang | Fisik | Sistem | Selisih
    expect(html).toMatch(/Barang<\/th><th[^>]*>Fisik<\/th><th[^>]*>Sistem<\/th><th[^>]*>Selisih/);
    expect(html).toContain("Giftbox contoh 1<"); // ada stok
    expect(html).toContain("Giftbox contoh 2<"); // selisih
    expect(html).toContain("Giftbox contoh 50<"); // sistem ada tapi fisik 0 → selisih
    expect(html).not.toContain("Giftbox contoh 20<"); // 0 & sesuai sistem → dirangkum
    expect(html).toContain("41 item lain: 0, sesuai sistem");
    expect(html.match(/✓ sesuai sistem/g)).toBeNull();
    // bahan di bawah limit ditandai merah + order ringkas
    expect(html).toContain("⚠ Lem contoh");
    expect(html).toContain("Lem contoh — 4/10 kg"); // satu bahan per baris, grid 2 kolom
    expect(html).not.toContain("Lem contoh (4/10 kg)");
    expect(html).toContain("grid-cols-2");
    if (process.env.JPG_HTML_OUT) fs.writeFileSync(process.env.JPG_HTML_OUT, html);
  });
});
