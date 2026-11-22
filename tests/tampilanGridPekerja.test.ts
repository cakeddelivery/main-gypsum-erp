import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BagiForm, LaporForm, TerimaJenisForm } from "../src/app/(app)/borongan/KirimanForms";
import type { ShipmentView } from "@/lib/boronganFlow";

const V = ["Cowok", "Cewek", "Hewan", "Transport"];
const tasks = V.map((v, i) => ({ id: `t${i}`, name: `Assembling ${v}`, short: v, qty: 1000, divisionId: null }));
const view = {
  id: "s1", number: "KRM-221126-02", points: [{ id: "p1", name: "BMR", coordinator: true }, { id: "p2", name: "MASTRIP", coordinator: false }], tasks, cells: [], pickups: [],
  resultAtReceipt: true, crosscheck: tasks.map((t) => ({ pointId: "p1", taskId: t.id, reported: 0, received: null })),
} as unknown as ShipmentView;
const workers = [
  { id: "w1", name: "Icuk", pointId: "p1", taskIds: [] },
  { id: "w3", name: "Rika", pointId: "p1", taskIds: ["tidak-ada"] },
  { id: "w4", name: "Rini", pointId: "p2", taskIds: ["t0", "t2"] },
];
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("Form kiriman borongan: grid pekerja rapi", () => {
  const html = renderToStaticMarkup(createElement(BagiForm, { view, workers }));
  it("Pembagian: judul kolom jenis sekali per titik, tiap pekerja satu baris, kolom seragam", () => {
    expect(count(html, /<table[^>]*table-fixed/g)).toBe(3); // 2 titik + ringkasan
    for (const v of V) expect(count(html, new RegExp(`<th[^>]*>${v}</th>`, "g"))).toBeGreaterThanOrEqual(2); // header per titik
    expect(count(html, /<th[^>]*>Pekerja<\/th>/g)).toBe(2);
    expect(count(html, /width:60px/g)).toBeGreaterThanOrEqual(8); // kolom jenis 60px (4 × 2 titik)
    expect(count(html, /name="a:p1:w1:t\d"/g)).toBe(4); // Icuk: 4 isian
    expect(html).toContain('title="Icuk"'); // tooltip nama
  });
  it("pekerja tanpa jenis yang cocok diberi keterangan (bukan baris kosong); sebagian jenis → sel kosong bergaris", () => {
    expect(html).toMatch(/Rika[\s\S]{0,300}tidak menerima tugas ini/);
    expect(count(html, /name="a:p1:w3:/g)).toBe(0);
    expect(count(html, /name="a:p2:w4:t\d"/g)).toBe(2); // Rini hanya Cowok & Hewan
  });
  it("ringkasan bawah: kolom angka rata kanan (Dibagi / Kiriman / Sisa)", () => {
    expect(html).toMatch(/<th[^>]*text-right[^>]*>Dibagi<\/th>/);
    expect(html).toMatch(/<th[^>]*text-right[^>]*>Sisa<\/th>/);
    expect(count(html, /<td[^>]*py-0\.5 text-right/g)).toBeGreaterThanOrEqual(12); // 4 jenis × 3 angka
  });
  it("Lapor hasil & Terima per warna memakai tabel kolom 60px yang sama", () => {
    const lapor = renderToStaticMarkup(createElement(LaporForm, { view, pointId: "p1", workers }));
    expect(lapor).toMatch(/Rika[\s\S]{0,200}tidak menerima tugas ini/);
    expect(count(lapor, /width:60px/g)).toBeGreaterThanOrEqual(4);
    const terima = renderToStaticMarkup(createElement(TerimaJenisForm, { view, pointId: "p1" }));
    expect(count(terima, /name="c:t\d"/g)).toBe(4);
    expect(count(terima, /width:60px/g)).toBe(4);
  });
});
