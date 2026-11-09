import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { suggestCategory } from "@/lib/extract";

describe("Kategori Bahan Pesanan Custom & Langganan Software & AI", () => {
  it("tersedia dengan akun yang benar dan dikenali dari keterangan", async () => {
    const cats = await prisma.txCategory.findMany({ where: { active: true }, include: { coaAccount: true } });
    const custom = cats.find((c) => c.name === "Bahan Pesanan Custom")!;
    const sub = cats.find((c) => c.name === "Langganan Software & AI")!;
    expect([custom.direction, custom.coaAccount.code, custom.coaAccount.type]).toEqual(["KELUAR", "5-1100", "HPP"]);
    expect([sub.direction, sub.coaAccount.code, sub.coaAccount.type]).toEqual(["KELUAR", "6-1550", "BEBAN"]);
    expect(suggestCategory("Beli label custom (5) Edy Tri Junianto", "KELUAR", cats)).toBe(custom.id);
    expect(suggestCategory("Print custom warna (WARNA PRINT LAMONGAN)", "KELUAR", cats)).toBe(custom.id);
    expect(suggestCategory("Langganan Chatgpt Go 1 bulan", "KELUAR", cats)).toBe(sub.id);
    expect(suggestCategory("Langganan AI claude pro", "KELUAR", cats)).toBe(sub.id);
    expect(suggestCategory("bayar listrik pln", "KELUAR", cats)).not.toBe(sub.id);
  });
});
