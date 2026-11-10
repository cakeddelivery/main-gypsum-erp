import { afterEach, describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { existsSync } from "node:fs";

const env = process.env.APP_ENV;
afterEach(() => {
  process.env.APP_ENV = env;
});

describe("PWA manifest", () => {
  it("memenuhi syarat instal: nama, ikon 192/512 + maskable, start_url, display", () => {
    process.env.APP_ENV = "production";
    const m = manifest();
    expect(m.name).toBe("Main Gypsum ERP");
    expect(m.short_name).toBe("MG ERP");
    expect(m.display).toBe("standalone");
    expect(m.start_url).toMatch(/^\//);
    expect(m.scope).toBe("/");
    const sizes = (m.icons ?? []).map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
    for (const i of m.icons ?? []) expect(existsSync(`public${i.src}`)).toBe(true);
    expect((m.shortcuts ?? []).map((s) => s.url)).toEqual(["/finance", "/finance?baru=1", "/penjualan", "/stok"]);
  });

  it("staging memakai nama & ikon berbeda", () => {
    process.env.APP_ENV = "staging";
    const m = manifest();
    expect(m.short_name).toBe("MG ERP (Tes)");
    for (const i of m.icons ?? []) {
      expect(i.src).toContain("-tes");
      expect(existsSync(`public${i.src}`)).toBe(true);
    }
  });
});
