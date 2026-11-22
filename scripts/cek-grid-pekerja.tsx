// @ts-nocheck — alat uji tampilan (playwright terpasang global, tanpa tipe di proyek)
/**
 * Cek tampilan HP form kiriman borongan (Pembagian, Lapor hasil, Penerimaan per warna) di lebar 390 px (juga 360 & 320):
 * label & isian per jenis sejajar antar pekerja, tidak ada gulir samping, baris tanpa isian diberi keterangan.
 * Render statis komponen + CSS Tailwind (tanpa server/login), lalu ukur lewat Playwright.
 *
 *   npx tailwindcss -c tailwind.config.ts -i src/app/globals.css -o /tmp/app.css
 *   CSS=/tmp/app.css [SHOTS=folder] npx tsx scripts/cek-grid-pekerja.tsx
 * Keluar dengan kode 1 bila ada temuan.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import fs from "node:fs";
import type { ShipmentView } from "../src/lib/boronganFlow";

// tsx memakai runtime JSX klasik (Next memakai otomatis): sediakan React global sebelum memuat komponen
(globalThis as unknown as { React: typeof React }).React = React;

const css = fs.readFileSync(process.env.CSS ?? "/tmp/app.css", "utf8");
const V = ["Cowok", "Cewek", "Hewan", "Transport"];
const tasks = V.map((v, i) => ({ id: `t${i}`, name: `Assembling ${v}`, short: v, qty: 1000, divisionId: null }));
const view = {
  id: "s1", number: "KRM-221126-02", points: [{ id: "p1", name: "BMR", coordinator: true }, { id: "p2", name: "MASTRIP", coordinator: false }], tasks,
  cells: [{ pointId: "p1", workerId: "w1", worker: "Icuk", taskId: "t0", dibagi: 300, diambil: 0, good: 0, reject: 0, reported: false, done: false }],
  pickups: [], resultAtReceipt: true, crosscheck: tasks.map((t) => ({ pointId: "p1", taskId: t.id, reported: 0, received: null })),
} as unknown as ShipmentView;
const workers = [
  { id: "w1", name: "Icuk", pointId: "p1", taskIds: [] },
  { id: "w2", name: "Sunny Maharani Putri Wijayanti", pointId: "p1", taskIds: [] },
  { id: "w3", name: "Rika", pointId: "p1", taskIds: ["tidak-ada"] }, // jenis pekerjaan tidak cocok dengan kiriman
  { id: "w4", name: "Rini", pointId: "p2", taskIds: ["t0", "t2"] }, // hanya sebagian jenis
  { id: "w5", name: "Budi", pointId: "p2", taskIds: [] },
];

(async () => {
  const { BagiForm, LaporForm, TerimaJenisForm, UbahJumlahForm } = await import("../src/app/(app)/borongan/KirimanForms");
  const pages: [string, string][] = [
    ["Pembagian", renderToStaticMarkup(<BagiForm view={view} workers={workers} />)],
    ["Lapor hasil", renderToStaticMarkup(<LaporForm view={view} pointId="p1" workers={workers} />)],
    ["Terima per warna", renderToStaticMarkup(<TerimaJenisForm view={view} pointId="p1" />)],
    ["Ubah jumlah kiriman", renderToStaticMarkup(<UbahJumlahForm view={view} />)],
  ];
  const browser = await chromium.launch();
  let bad = 0;
  for (const w of [390, 360, 320]) {
    for (const [title, html] of pages) {
      const page = await browser.newPage({ viewport: { width: w, height: 800 }, deviceScaleFactor: 2 });
      // Meniru popup form: kartu putih dengan gutter 16 px
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="bg-white"><div style="padding:16px" id="m"><div class="space-y-3">${html}</div></div></body></html>`);
      const r = await page.evaluate((limit) => {
        const out: string[] = [];
        const doc = document.documentElement;
        if (doc.scrollWidth > limit + 0.5) out.push(`halaman melebar ${doc.scrollWidth}px > ${limit}px`);
        for (const g of document.querySelectorAll<HTMLElement>("[data-grid=pekerja]")) if (g.scrollWidth > g.clientWidth + 0.5) out.push(`grid menggulir samping (${g.scrollWidth} > ${g.clientWidth})`);
        const inputs = [...document.querySelectorAll<HTMLInputElement>("input[inputmode=numeric]")];
        const widths = new Set(inputs.map((i) => Math.round(i.getBoundingClientRect().width)));
        if (widths.size > 1) out.push(`lebar isian tidak seragam: ${[...widths].join(", ")}px`);
        // Isian satu jenis harus sejajar vertikal antar pekerja (x sama) dalam satu tabel
        for (const t of document.querySelectorAll("table")) {
          const cols = new Map<number, Set<number>>();
          for (const tr of t.querySelectorAll("tbody tr")) {
            const tds = [...tr.children] as HTMLElement[];
            tds.forEach((td, i) => { const inp = td.querySelector("input"); if (inp) (cols.get(i) ?? cols.set(i, new Set()).get(i)!).add(Math.round(inp.getBoundingClientRect().left)); });
          }
          for (const [i, xs] of cols) if (xs.size > 1) out.push(`kolom ${i} tidak sejajar (x: ${[...xs].join(", ")})`);
        }
        return out;
      }, w);
      if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: `${process.env.SHOTS}/${title.replace(/\W+/g, "-")}-${w}.png`, fullPage: true }); }
      const ok = !r.length;
      if (!ok) bad++;
      console.log(`${ok ? "✓" : "✗"} ${w}px · ${title}${ok ? "" : "\n    " + r.join("\n    ")}`);
      await page.close();
    }
  }
  await browser.close();
  process.exit(bad ? 1 : 0);
})();
