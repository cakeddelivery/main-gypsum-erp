import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { commitImport, previewImport, undoImport } from "@/lib/marketplace/import";
import { parseMarketplaceFile } from "@/lib/marketplace/parse";
import { detectFiles } from "@/lib/marketplace/slots";
import { createHash } from "node:crypto";

const num = Date.now().toString().slice(-6);
const actor = { id: "t", name: "Tester" };
const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
type Cell = string | number | null;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const col = (i: number) => String.fromCharCode(65 + i);
async function xlsx(sheets: Record<string, Cell[][]>) {
  const zip = new JSZip();
  const names = Object.keys(sheets);
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file("xl/workbook.xml", `<workbook xmlns:r="r"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`);
  names.forEach((n, i) => {
    const rows = sheets[n].map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => (c === null ? "" : typeof c === "number" ? `<c r="${col(ci)}${ri + 1}"><v>${c}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`)).join("")}</row>`).join("");
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zip.generateAsync({ type: "nodebuffer" });
}
async function dl() {
  const org = await prisma.organization.findFirstOrThrow();
  const ex = await prisma.store.findUnique({ where: { code: "DL" } });
  if (ex) return ex;
  const made = await prisma.store.create({ data: { code: "DL", name: "Dunia Lukis", organizationId: org.id } });
  cleanups.unshift(() => prisma.store.delete({ where: { id: made.id } }));
  return made;
}
const HEAD = ["No. Pesanan", "Status Pesanan", "SKU Induk", "Nama Produk", "Jumlah", "Harga Setelah Diskon", "Subtotal Pesanan", "Total Pembayaran", "Waktu Pesanan Dibuat"];
const orderFile = (rows: [string, string][], sku = "SKU-X") => xlsx({ orders: [HEAD, ...rows.map(([no, at]) => [no, "Selesai", sku, "Gypsum X", 1, 50000, 50000, 50000, at])] });
const incomeFile = (rows: [string, string][]) => xlsx({ Penghasilan: [["Laporan"], ["No.", "No. Pesanan", "Lihat Berdasarkan", "Waktu Pesanan Dibuat", "Tanggal Dana Dilepaskan", "Total Penghasilan", "Harga Produk", "Jumlah Pengembalian Dana ke Pembeli", "Biaya Administrasi"], ...rows.map(([no, at], i) => [i + 1, no, "Order", at, at, 45000, 50000, 0, -5000])] });

describe("Impor banyak file: per file, duplikat, multi-bulan", () => {
  it("file multi-bulan: periode dibaca dari isi file (bukan nama)", async () => {
    const p = await parseMarketplaceFile(await orderFile([[`${num}M1`, "2043-08-05 10:00"], [`${num}M2`, "2043-11-20 10:00"]]));
    expect(p.periodFrom!.toISOString().slice(0, 10)).toBe("2043-08-05");
    expect(p.periodTo!.toISOString().slice(0, 10)).toBe("2043-11-20");
  });

  it("20 file satu per satu tanpa batas jumlah; periode tumpang tindih aman; unggahan ganda ('(1)') dikenali dari isi", async () => {
    const st = await dl();
    const ids: string[] = [];
    let first: Buffer | null = null;
    // 20 file bulanan (Agu–Nov 2043 dan seterusnya), urut apa pun
    for (let i = 0; i < 20; i++) {
      const buf = await orderFile([[`${num}B${i}`, `2043-${String((i % 9) + 1).padStart(2, "0")}-10 10:00`]]);
      if (i === 0) first = buf;
      const parsed = await parseMarketplaceFile(buf);
      const [r] = await commitImport(actor, [{ fileName: `Order.all.${i}.xlsx`, storeId: st.id, parsed, hash: createHash("sha1").update(buf).digest("hex") }], { finalize: false });
      expect(r.baru).toBe(1);
      ids.push(r.importId);
    }
    cleanups.push(async () => { for (const id of ids.reverse()) await undoImport(actor, id).catch(() => {}); });

    // file identik dengan nama lain (unduhan ganda "(1)") → dikenali sudah diunggah
    const same = Buffer.from(first!); // unduhan ganda = byte yang sama persis, nama lain
    const det = await detectFiles([{ name: "Order.all (1).xlsx", buf: same, target: `${st.id}|SHP|ORDER` }]);
    expect(det[0].hash).toBe(createHash("sha1").update(same).digest("hex"));
    // hash file ke-0 sama persis dengan `same`? (isi sama → ya)
    expect(det[0].duplicate).toMatch(/sudah diunggah/i);
    expect(det[0].error).toBeUndefined();

    // tumpang tindih: unggah ulang pesanan yang sama dalam file berbeda → tidak dobel
    const overlap = await orderFile([[`${num}B0`, "2043-01-10 10:00"], [`${num}NEW`, "2043-01-11 10:00"]]);
    const [r2] = await commitImport(actor, [{ fileName: "overlap.xlsx", storeId: st.id, parsed: await parseMarketplaceFile(overlap) }], { finalize: false });
    ids.push(r2.importId);
    expect(r2.baru).toBe(1);
    expect(r2.dilewati).toBe(1);
  });

  it("file tanpa nama toko → minta pilih toko (bukan galat); slot salah jenis ditolak", async () => {
    const st = await dl();
    const buf = await orderFile([[`${num}Z1`, "2044-05-01 10:00"]], `UNIQ${num}`); // SKU yang belum pernah dikenal di toko mana pun
    const auto = await detectFiles([{ name: "x.xlsx", buf }]);
    expect(auto[0]).toMatchObject({ channel: "SHP", kind: "ORDER", needStore: true });
    expect(auto[0].error).toBeUndefined();
    const wrong = await detectFiles([{ name: "x.xlsx", buf, target: `${st.id}|SHP|INCOME` }]);
    expect(wrong[0].error).toMatch(/bukan/i);
  });

  it("pratinjau per file: penghasilan tanpa pesanan di ERP tidak dihitung 'tanpa pesanan' bila file pesanannya ikut dalam unggahan", async () => {
    const st = await dl();
    const buf = await incomeFile([[`${num}Q1`, "2045-03-01 10:00"]]);
    const parsed = await parseMarketplaceFile(buf);
    const a = await previewImport([{ fileName: "inc.xlsx", storeId: st.id, parsed }]);
    expect(a.files[0].incomeNoOrder).toBe(1);
    const b = await previewImport([{ fileName: "inc.xlsx", storeId: st.id, parsed }], { ordersInBatch: true });
    expect(b.files[0].incomeNoOrder).toBe(0);
  });
});
