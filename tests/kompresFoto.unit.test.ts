import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { compressImage, proofContentType, sniffMime, stripJpegMetadata, SMALL_BYTES } from "@/lib/imageCompress";
import { compressStorage } from "@/lib/compressStorage";
import { readProof, saveProof } from "@/lib/storage";

const noisy = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#808080", noise: { type: "gaussian" as const, mean: 128, sigma: 40 } } });
const bigJpeg = () => noisy(4000, 3000).jpeg({ quality: 95 }).toBuffer();
const GPS = { IFD3: { GPSLatitudeRef: "S", GPSLatitude: "7/1 7/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "112/1 25/1 0/1" } };
/** Kiri merah, kanan biru (400×200), dengan tag EXIF Orientation */
async function halves(orientation: number) {
  const red = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#ff0000" } }).png().toBuffer();
  return sharp({ create: { width: 400, height: 200, channels: 3, background: "#0000ff" } })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg({ quality: 95 })
    .withMetadata({ orientation })
    .toBuffer();
}
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("kompres foto bukti", () => {
  it("gambar besar diperkecil (sisi terpanjang 1600 px, JPEG) dan disimpan sebagai .jpg", async () => {
    const orig = await bigJpeg();
    const rel = await saveProof(orig, "image/jpeg");
    expect(rel.endsWith(".jpg")).toBe(true);
    const saved = await readProof(rel);
    const m = await sharp(saved).metadata();
    expect(Math.max(m.width!, m.height!)).toBe(1600);
    expect(saved.length).toBeLessThan(orig.length / 3);
  });

  it("PNG screenshot: batas lebih longgar (2000 px) dan isinya jadi JPEG", async () => {
    const png = await noisy(1500, 3200).png().toBuffer();
    const c = await compressImage(png);
    expect(c.changed).toBe(true);
    expect(sniffMime(c.buf)).toBe("image/jpeg");
    const m = await sharp(c.buf).metadata();
    expect([m.width, m.height]).toEqual([938, 2000]);
  });

  it("tidak memperbesar gambar kecil", async () => {
    const png = await noisy(300, 500).png().toBuffer(); // > 150 KB karena noise, tapi kecil dimensinya
    const c = await compressImage(png);
    const m = await sharp(c.buf).metadata();
    expect([m.width, m.height]).toEqual([300, 500]);
  });

  it("orientasi EXIF diterapkan (foto HP miring jadi tegak)", async () => {
    const c = await compressImage(await halves(6)); // 6 = putar 90° searah jarum jam
    expect(c.changed).toBe(true);
    const { data, info } = await sharp(c.buf).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([200, 400]);
    const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    // Kiri (merah) menjadi atas, kanan (biru) menjadi bawah
    expect(px(100, 50)[0]).toBeGreaterThan(200);
    expect(px(100, 350)[2]).toBeGreaterThan(200);
    expect((await sharp(c.buf).metadata()).orientation).toBeUndefined();
  });

  it("EXIF/GPS dibuang: gambar besar (encode ulang) maupun kecil (tanpa encode ulang, piksel sama)", async () => {
    const big = await noisy(3000, 2000).jpeg({ quality: 95 }).withExif(GPS).toBuffer();
    expect((await sharp(big).metadata()).exif).toBeDefined();
    const c1 = await compressImage(big);
    expect(c1.changed).toBe(true);
    expect((await sharp(c1.buf).metadata()).exif).toBeUndefined();

    const small = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#336699" } }).jpeg().withExif(GPS).toBuffer();
    expect(small.length).toBeLessThan(SMALL_BYTES);
    const c2 = await compressImage(small);
    expect(c2.reason).toBe("metadata dibuang");
    expect((await sharp(c2.buf).metadata()).exif).toBeUndefined();
    expect(c2.buf.includes(Buffer.from("GPS"))).toBe(false);
    expect((await sharp(c2.buf).raw().toBuffer()).equals(await sharp(small).raw().toBuffer())).toBe(true);
    expect(stripJpegMetadata(Buffer.from("bukan jpeg"))).toBeNull();
  });

  it("PDF disimpan apa adanya", async () => {
    const rel = await saveProof(PDF, "application/pdf");
    expect(rel.endsWith(".pdf")).toBe(true);
    expect((await readProof(rel)).equals(PDF)).toBe(true);
    expect((await compressImage(PDF)).changed).toBe(false);
  });

  it("file yang sudah kecil tidak membesar / tidak diubah", async () => {
    const small = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const c = await compressImage(small);
    expect(c.changed).toBe(false);
    expect(c.buf).toBe(small);
    const rel = await saveProof(small, "image/png");
    expect(rel.endsWith(".png")).toBe(true);
    expect((await readProof(rel)).equals(small)).toBe(true);
    // Hasil kompres yang dikompres lagi tidak pernah lebih besar
    const once = (await compressImage(await bigJpeg())).buf;
    const twice = await compressImage(once, { minSaving: 0.1 });
    expect(twice.buf.length).toBeLessThanOrEqual(once.length);
  });

  it("content-type dibaca dari isi file, bukan ekstensi", async () => {
    const jpg = (await compressImage(await noisy(2500, 2500).png().toBuffer())).buf;
    expect(proofContentType(jpg, "image/png")).toBe("image/jpeg");
    expect(proofContentType(PDF, null)).toBe("application/pdf");
    expect(proofContentType(Buffer.from("??"), "image/webp")).toBe("image/webp");
    expect(proofContentType(Buffer.from("??"), null)).toBe("application/octet-stream");
  });

  it("OCR screenshot bukti/mutasi sama sebelum & sesudah kompres", async () => {
    const { ocrImageText } = await import("@/lib/ocrReceipt");
    const { receiptFromOcrText } = await import("@/lib/ocrReceiptText");
    const { amountFromOcrText } = await import("@/lib/ocrAmount");
    const orig = readFileSync(join(__dirname, "fixtures", "screenshot-bukti-mutasi.png"));
    const c = await compressImage(orig);
    expect(c.changed).toBe(true);
    expect(c.buf.length).toBeLessThan(orig.length);
    const acc = [{ id: "sb", code: "SEABANK", name: "Seabank", aliases: "sea bank" }];
    const now = new Date("2026-11-07T08:00:00Z");
    const [t1, t2] = [await ocrImageText(orig), await ocrImageText(c.buf)];
    expect(receiptFromOcrText(t2, acc, now)).toEqual(receiptFromOcrText(t1, acc, now));
    expect(receiptFromOcrText(t2, acc, now)).toMatchObject({ amount: 1284500, date: "2026-11-07", time: "14:23" });
    expect(amountFromOcrText(t2)).toBe(amountFromOcrText(t1));
    // Teks kecil (baris mutasi 9 px) tetap terbaca
    const rows = Array.from({ length: 30 }, (_, i) => (12345 * (i + 3)).toLocaleString("id-ID"));
    const hits = (t: string) => rows.filter((r) => t.includes(r)).length;
    expect(hits(t2)).toBeGreaterThanOrEqual(hits(t1) - 1);
    expect(hits(t2)).toBeGreaterThanOrEqual(28);
  }, 120_000);
});

describe("skrip kompres:file (compressStorage)", () => {
  it("pratinjau tidak mengubah apa pun; jalankan kompres di tempat; aman diulang", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kompres-"));
    tmpDirs.push(dir);
    mkdirSync(join(dir, "2026", "11"), { recursive: true });
    const bigPng = await noisy(2400, 2400).png().toBuffer();
    const smallJpg = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#00ff00" } }).jpeg().toBuffer();
    writeFileSync(join(dir, "2026", "11", "a.png"), bigPng);
    writeFileSync(join(dir, "2026", "11", "b.jpg"), await bigJpeg());
    writeFileSync(join(dir, "2026", "11", "c.jpg"), smallJpg);
    writeFileSync(join(dir, "2026", "11", "d.pdf"), PDF);

    const pre = await compressStorage(dir, { run: false });
    expect(pre.total).toBe(4);
    expect(pre.changed).toBe(2);
    expect(pre.after).toBeLessThan(pre.before);
    expect(readFileSync(join(dir, "2026", "11", "a.png")).equals(bigPng)).toBe(true);

    const r1 = await compressStorage(dir, { run: true });
    expect(r1.changed).toBe(2);
    expect(r1.after).toBe(pre.after);
    expect(readdirSync(join(dir, "2026", "11")).sort()).toEqual(["a.png", "b.jpg", "c.jpg", "d.pdf"]); // nama tetap, tanpa file sementara
    const a = readFileSync(join(dir, "2026", "11", "a.png"));
    expect(sniffMime(a)).toBe("image/jpeg");
    expect(proofContentType(a, "image/png")).toBe("image/jpeg");
    expect(readFileSync(join(dir, "2026", "11", "c.jpg")).equals(smallJpg)).toBe(true);
    expect(readFileSync(join(dir, "2026", "11", "d.pdf")).equals(PDF)).toBe(true);
    expect(statSync(join(dir, "2026", "11", "a.png")).size).toBe(a.length);

    const snapshot = ["a.png", "b.jpg"].map((f) => readFileSync(join(dir, "2026", "11", f)));
    const r2 = await compressStorage(dir, { run: true });
    expect(r2.changed).toBe(0);
    expect(r2.before).toBe(r1.after);
    expect(r2.files.filter((f) => f.status === "sudah diproses").length).toBe(2);
    ["a.png", "b.jpg"].forEach((f, i) => expect(readFileSync(join(dir, "2026", "11", f)).equals(snapshot[i])).toBe(true));
  });
});
