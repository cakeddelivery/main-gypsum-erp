import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Penyedia AI tiruan: model pertama kuota habis, kedua tidak bisa membaca gambar, ketiga berhasil
const calls: string[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const model = JSON.parse(body).model as string;
    calls.push(model);
    res.setHeader("content-type", "application/json");
    if (model === "habis") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { type: "model_unavailable", code: "model_tokens_exhausted" } }));
    }
    const content = model === "teks-saja" ? "Maaf, saya tidak dapat melihat gambar." : '{"is_receipt": true, "amount": 1580000, "date": "2026-10-30", "direction": "KELUAR", "account": "Seabank", "to_account": "", "counterparty": "CV Gypsum Jaya"}';
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.AI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AI_API_KEY = "uji";
  process.env.RECEIPT_MODEL = "habis";
  process.env.AI_MODEL_FALLBACK = "teks-saja, bisa-gambar";
});
afterAll(() => {
  server.close();
  for (const k of ["AI_BASE_URL", "AI_API_KEY", "RECEIPT_MODEL", "AI_MODEL_FALLBACK"]) delete process.env[k];
});

describe("Model AI cadangan", () => {
  it("lanjut ke model berikutnya saat kuota habis atau jawaban tanpa nominal", async () => {
    const { readReceipt } = await import("@/lib/receipt");
    const r = await readReceipt(Buffer.from("ffd8", "hex"), "", [{ id: "b1", code: "SEABANK", name: "Seabank", aliases: "" }]);
    expect(calls).toEqual(["habis", "teks-saja", "bisa-gambar"]);
    expect(r?.amount).toBe(1_580_000);
    expect(r?.account).toBe("Seabank");
  });
});
