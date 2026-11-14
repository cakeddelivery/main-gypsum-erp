import { describe, expect, it } from "vitest";
import { RELOAD_GAP_MS, canAutoReload, isNewBuild, isStaleError } from "@/lib/appVersion";
import { GET } from "@/app/api/version/route";

describe("Pembaruan otomatis aplikasi (PWA)", () => {
  it("versi baru hanya bila server memberi build lain yang valid", () => {
    expect(isNewBuild("abc-1", "abc-2")).toBe(true);
    expect(isNewBuild("abc-1", "abc-1")).toBe(false);
    expect(isNewBuild("abc-1", "")).toBe(false);
    expect(isNewBuild("abc-1", undefined)).toBe(false);
    expect(isNewBuild("abc-1", { build: "x" })).toBe(false);
    // Mode pengembangan tidak pernah memuat ulang otomatis
    expect(isNewBuild("dev", "abc-2")).toBe(false);
    expect(isNewBuild("abc-1", "dev")).toBe(false);
  });

  it("mengenali error karena versi lama: chunk hilang & server action berganti", () => {
    const chunk = new Error("Loading chunk 4321 failed.\n(error: https://erp/_next/static/chunks/4321.js)");
    chunk.name = "ChunkLoadError";
    expect(isStaleError(chunk)).toBe(true);
    expect(isStaleError(new Error('Server Action "7f3a" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action'))).toBe(true);
    expect(isStaleError("Failed to fetch dynamically imported module: https://erp/_next/static/x.js")).toBe(true);
    expect(isStaleError({ message: "Loading CSS chunk app-layout failed" })).toBe(true);
    expect(isStaleError(new Error("Saldo tidak cukup"))).toBe(false);
    expect(isStaleError(null)).toBe(false);
  });

  it("muat ulang otomatis paling sering sekali per menit (cegah berulang)", () => {
    const now = 1_000_000_000;
    expect(canAutoReload(null, now)).toBe(true);
    expect(canAutoReload(String(now - 5_000), now)).toBe(false);
    expect(canAutoReload(String(now - RELOAD_GAP_MS - 1), now)).toBe(true);
    expect(canAutoReload("rusak", now)).toBe(true);
    expect(canAutoReload(String(now + 60_000), now)).toBe(true); // jam HP mundur
  });

  it("/api/version tidak boleh disimpan cache", async () => {
    const res = GET();
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(typeof (await res.json()).build).toBe("string");
  });

  it("next.config memberi versi yang sama di setiap proses build (klien = server)", async () => {
    const before = process.env.APP_BUILD_ID;
    delete process.env.APP_BUILD_ID;
    try {
      // Dimuat dua kali seperti build worker server & klien
      const a = (await import("../next.config.mjs?w=1" as string)).default;
      const b = (await import("../next.config.mjs?w=2" as string)).default;
      expect(a.env.APP_BUILD_ID).toBeTruthy();
      expect(b.env.APP_BUILD_ID).toBe(a.env.APP_BUILD_ID);
      expect(await a.generateBuildId()).toBe(a.env.APP_BUILD_ID);
    } finally {
      if (before === undefined) delete process.env.APP_BUILD_ID;
      else process.env.APP_BUILD_ID = before;
    }
  });
});
