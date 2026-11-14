import { describe, expect, it } from "vitest";
import { requestWaText, stockHint, waShareUrl, type WaRequest } from "@/lib/stockRequestWa";

const item = (name: string, unit: string, extra: Partial<WaRequest["item"]> = {}): WaRequest["item"] => ({ name, unit, buyMode: "OFFLINE", productUrl: null, supplier: null, ...extra });

describe("Permintaan stok → WhatsApp", () => {
  it("teks rapi per divisi dengan stok/limit dan link produk online", () => {
    const text = requestWaText(
      [
        { qty: 2, note: "Otomatis: stok akhir Shift 1 Sab, 14 Nov 2026 = 1 roll, limit 2", division: { name: "Packing" }, item: item("Bubblewrap Putih", "roll", { buyMode: "ONLINE", productUrl: "https://shopee.co.id/x" }) },
        { qty: 1.5, note: null, division: { name: "Divisi Giftbox" }, item: item("Lem", "kg", { supplier: { name: "Toko Lem" } }) },
        { qty: 5, note: "Otomatis: … = 0 pcs, limit 3", division: { name: "Packing" }, item: item("Lakban", "pcs") },
      ],
      new Date("2026-11-14T03:00:00Z"),
    );
    expect(text).toBe(
      [
        "*Permintaan Stok — 14 Nov 2026*",
        "",
        "*Divisi Giftbox*",
        "1. Lem — 1,5 kg",
        "   Offline · Toko Lem",
        "",
        "*Divisi Packing*",
        "1. Bubblewrap Putih — 2 roll (stok 1, limit 2)",
        "   Online: https://shopee.co.id/x",
        "2. Lakban — 5 pcs (stok 0, limit 3)",
        "   Offline",
      ].join("\n"),
    );
  });

  it("link wa.me membawa teks yang ter-encode (pilih grup sendiri)", () => {
    expect(waShareUrl("*A & B*\n1. x")).toBe("https://wa.me/?text=*A%20%26%20B*%0A1.%20x");
    expect(stockHint("catatan manual")).toBeNull();
  });
});
