import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA, closePeriod, postJournal, reverseJournal } from "@/lib/accounting";
import { rebuildGl } from "@/lib/marketplace/gl";
import { jakartaDateTime } from "@/lib/time";

const actor = { id: "system", name: "uji-audit" };
const date = jakartaDateTime("2026-11-20", "10:00");
const post = () =>
  prisma.$transaction((tx) =>
    postJournal(tx, { date, storeId: null, description: "uji audit keuangan", source: "MANUAL", actor, lines: [{ accountCode: COA.BEBAN_LAIN, debit: 1000 }, { accountCode: COA.KAS, credit: 1000 }] }),
  );

describe("Audit Keuangan — double lewat paralel", () => {
  it("jurnal pembalik: dua permintaan paralel hanya menghasilkan SATU pembalik", async () => {
    const j = await post();
    const run = () => prisma.$transaction((tx) => reverseJournal(tx, j.id, date, actor, "uji"));
    const r = await Promise.allSettled([run(), run(), run()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.journal.count({ where: { reversalOfId: j.id } })).toBe(1);
  });

  it("tutup buku: dua penutupan paralel tidak menyusutkan aset dua kali", async () => {
    await prisma.accountingPeriod.deleteMany({ where: { year: 2026, month: 3 } });
    const asset = await prisma.fixedAsset.create({ data: { name: "Aset uji audit", storeId: (await prisma.store.findFirstOrThrow()).id, acquiredAt: jakartaDateTime("2026-01-05", "10:00"), cost: BigInt(1_200_000), usefulLifeMonths: 12, residual: BigInt(0), journalId: (await post()).id } });
    await Promise.allSettled([closePeriod(2026, 3, actor), closePeriod(2026, 3, actor)]);
    expect(await prisma.journal.count({ where: { source: "PENYUSUTAN", sourceId: `${asset.id}:2026-3` } })).toBe(1);
  });

  it("buku bayangan: rebuild paralel tidak gagal dan tidak menggandakan; tidak menyentuh jurnal nyata", async () => {
    const before = await prisma.journal.count();
    const r = await Promise.allSettled([rebuildGl(), rebuildGl()]);
    expect(r.every((x) => x.status === "fulfilled")).toBe(true);
    const keys = (await prisma.marketplaceGlJournal.findMany({ select: { key: true } })).map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(await prisma.journal.count()).toBe(before);
  });
});

// ---- aksi web: klik ganda & paralel ----
import { vi } from "vitest";
vi.mock("@/lib/auth", async (orig) => {
  const real = await orig<typeof import("@/lib/auth")>();
  return { ...real, assertPerm: async () => ({ id: "u-audit", name: "uji-audit", role: "OWNER", can: () => true }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));

const form = (o: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
};

describe("Audit Keuangan — aksi akuntansi: klik ganda & paralel", () => {
  it("jurnal manual identik dikirim 2x berturut-turut & 2x paralel: hanya satu terbukukan", async () => {
    const { manualJournal } = await import("@/app/(app)/akuntansi/actions");
    const [beban, kas] = await Promise.all([prisma.coaAccount.findUniqueOrThrow({ where: { code: COA.BEBAN_LAIN } }), prisma.coaAccount.findUniqueOrThrow({ where: { code: COA.KAS } })]);
    const mk = (desc: string) => form({ date: "2026-11-21", description: desc, acc: [beban.id, kas.id], debit: ["5000", ""], credit: ["", "5000"], memo: ["", ""] });
    const a = await manualJournal(null, mk("uji ganda berturut"));
    const b = await manualJournal(null, mk("uji ganda berturut"));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(await prisma.journal.count({ where: { description: "uji ganda berturut" } })).toBe(1);
    const p = await Promise.all([manualJournal(null, mk("uji ganda paralel")), manualJournal(null, mk("uji ganda paralel")), manualJournal(null, mk("uji ganda paralel"))]);
    expect(p.filter((x) => x.ok)).toHaveLength(1);
    expect(await prisma.journal.count({ where: { description: "uji ganda paralel" } })).toBe(1);
  });

  it("piutang manual: kirim ganda tidak membuat dua piutang; pelunasan paralel tidak melebihi sisa", async () => {
    const { createReceivable, settle } = await import("@/app/(app)/akuntansi/actions");
    const rev = await prisma.coaAccount.findFirstOrThrow({ where: { type: "PENDAPATAN" } });
    const kas = await prisma.bankAccount.findFirstOrThrow({ where: { active: true, marketplace: false } });
    const fd = () => form({ customer: "Pelanggan Uji Audit", amount: "100000", date: "2026-11-21", revenueAccountId: rev.id });
    const r = await Promise.all([createReceivable(null, fd()), createReceivable(null, fd())]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    const doc = await prisma.receivable.findFirstOrThrow({ where: { customer: "Pelanggan Uji Audit" } });
    const pay = () => form({ kind: "piutang", id: doc.id, amount: "80000", bankAccountId: kas.id, date: "2026-11-22" });
    const s = await Promise.all([settle(null, pay()), settle(null, pay())]);
    expect(s.filter((x) => x.ok)).toHaveLength(1);
    expect(Number((await prisma.receivable.findUniqueOrThrow({ where: { id: doc.id } })).paid)).toBe(80000);
  });
});
