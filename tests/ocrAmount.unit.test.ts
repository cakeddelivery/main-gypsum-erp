import { describe, expect, it } from "vitest";
import { amountFromOcrText, bankFromOcrText, parseRupiah } from "@/lib/ocrAmount";

describe("Baca nominal dari teks OCR", () => {
  it("format angka rupiah", () => {
    expect(parseRupiah("1.580.000")).toBe(1_580_000);
    expect(parseRupiah("1,580,000.00")).toBe(1_580_000);
    expect(parseRupiah("1.580.000,00")).toBe(1_580_000);
    expect(parseRupiah("1 580 000")).toBe(1_580_000);
  });
  it("bukti m-banking: ambil total, abaikan biaya admin", () => {
    const t = `Transfer Berhasil\n30 Okt 2026 09:12\nSeaBank\nPenerima CV GYPSUM JAYA\nNominal Transfer\nRp1.580.000\nBiaya Admin Rp2.500\nTotal Rp1.580.000`;
    expect(amountFromOcrText(t)).toBe(1_580_000);
  });
  it("tanpa kata kunci: Rp yang paling sering muncul", () => {
    expect(amountFromOcrText("Berhasil\nRp 250.000\nKe: Toko Cat\nRp 250.000\nRef 123456789")).toBe(250_000);
  });
  it("kata kunci di baris yang sama tanpa Rp", () => {
    expect(amountFromOcrText("Jumlah 360.000\nNo. Ref 99887766")).toBe(360_000);
  });
  it("Rp salah baca OCR (Ap/rp) & angka tanggal tidak ikut", () => {
    expect(amountFromOcrText("Transier Berhasil Ap300.000")).toBe(300_000);
    expect(amountFromOcrText("Berhasil rp 75.000 30 Okt 2026")).toBe(75_000);
  });
  it("cadangan angka ribuan tanpa Rp, abaikan jam/tanggal", () => {
    expect(amountFromOcrText("Berhasil\n1.250.000\n30/10/2026 10:21")).toBe(1_250_000);
  });
  it("tidak ada nominal", () => {
    expect(amountFromOcrText("foto kucing")).toBeNull();
  });
  it("kenali rekening dari teks", () => {
    expect(bankFromOcrText("Transfer dari SeaBank", [{ id: "s", name: "Seabank" }, { id: "k", name: "Kas" }])).toBe("s");
  });
});
