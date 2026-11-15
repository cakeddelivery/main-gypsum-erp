import { beforeEach, describe, expect, it } from "vitest";
import { clearReopen, readReopen, REOPEN_TTL_MS, reportReopenKey, writeReopen } from "@/lib/reopen";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("Popup laporan dibuka lagi setelah halaman dimuat ulang", () => {
  it("langkah & item checklist diingat, digabung, lalu dihapus saat ditutup", () => {
    const k = reportReopenKey("r1");
    expect(readReopen(k)).toBeNull();
    writeReopen(k, {});
    writeReopen(k, { step: "checklist" });
    writeReopen(k, { item: 2 });
    expect(readReopen(k)).toMatchObject({ step: "checklist", item: 2 });
    clearReopen(k);
    expect(readReopen(k)).toBeNull();
  });

  it("kedaluwarsa setelah 2 jam; data rusak diabaikan", () => {
    const k = reportReopenKey("r2");
    writeReopen(k, { step: "stok" });
    expect(readReopen(k, Date.now() + REOPEN_TTL_MS + 1000)).toBeNull();
    store.set(k, "{rusak");
    expect(readReopen(k)).toBeNull();
  });
});
