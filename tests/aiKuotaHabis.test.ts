import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// OCR server dimatikan di tes ini (foto uji bukan gambar sungguhan): cadangan OCR gagal juga → nominal null
vi.mock("@/lib/ocrReceipt", async (orig) => ({ ...(await orig<typeof import("@/lib/ocrReceipt")>()), ocrReceipt: vi.fn(async () => { throw new Error("OCR mati"); }), ocrImageText: vi.fn(async () => "") }));

// Penyedia AI tiruan yang selalu menolak: kuota habis (400 model_tokens_exhausted) atau rate limit (429)
let mode: "kuota" | "limit" | "rusak" = "kuota";
const server = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (mode === "kuota") { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: "model_tokens_exhausted" } })); }
    if (mode === "limit") { res.statusCode = 429; return res.end("rate limit"); }
    res.statusCode = 500;
    res.end("boom");
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.AI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AI_API_KEY = "uji";
});
afterAll(() => {
  server.close();
  for (const k of ["AI_BASE_URL", "AI_API_KEY"]) delete process.env[k];
});

describe("Kegagalan AI tidak memblokir alur manual", () => {
  it("readReceipt: gagal dengan pesan ramah (tanpa detail HTTP/token), bukan error mentah", async () => {
    const { readReceipt } = await import("@/lib/receipt");
    mode = "kuota";
    await expect(readReceipt(Buffer.from("ffd8", "hex"), "", [])).rejects.toThrow(/Kuota AI .* Isi manual/);
    mode = "limit";
    await expect(readReceipt(Buffer.from("ffd8", "hex"), "", [])).rejects.toThrow(/Kuota AI/);
    mode = "rusak";
    await expect(readReceipt(Buffer.from("ffd8", "hex"), "", [])).rejects.toThrow(/Layanan AI sedang bermasalah/);
    mode = "kuota";
    await expect(readReceipt(Buffer.from("ffd8", "hex"), "", [])).rejects.not.toThrow(/HTTP 400|tokens_exhausted/);
  });
  it("bukti WD (PDF, tanpa OCR): AI gagal → hasil null, tidak melempar; form manual tetap jalan", async () => {
    const { readWdProofFile } = await import("@/lib/wdProofServer");
    mode = "kuota";
    await expect(readWdProofFile(Buffer.from("%PDF-1.4"), "application/pdf", 100_000)).resolves.toBeNull();
  });
  it("talangan: nominal bukti tidak terbaca → null (isi manual), tidak melempar", async () => {
    const { readProofAmount } = await import("@/lib/talangan");
    mode = "limit";
    await expect(readProofAmount(Buffer.from("not an image"), "image/jpeg")).resolves.toBeNull();
  });
});
