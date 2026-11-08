import { beforeAll, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
vi.mock("@/lib/telegram", async (orig) => {
  const real = await orig<typeof import("@/lib/telegram")>();
  return { ...real, telegramConfigured: () => true, sendTelegram: vi.fn(async (_c: string, text: string) => (sent.push(text), { ok: true })) };
});

import { prisma } from "@/lib/db";
import { postJournal, reverseJournal, COA } from "@/lib/accounting";
import { budgetReport, budgetWarnings, copyBudgetFromPrev, deleteBudget, levelOf, pendingBudgetNotices, saveBudget } from "@/lib/budget";
import { alertsFor } from "@/lib/alerts";
import { sendBudgetNotice } from "@/lib/jobs";
import { jakartaDateTime } from "@/lib/time";

// Bulan jauh di depan agar tidak bentrok dengan data tes lain
const Y = 2031;
const M = 3;
const NOW = jakartaDateTime("2031-03-20", "09:00");
let owner: { id: string; name: string };
let transport: string;
let listrik: string;
let iklan: string;

const spend = (code: string, amount: number, date = "2031-03-10") =>
  prisma.$transaction((tx) => postJournal(tx, { date: jakartaDateTime(date, "12:00"), description: `Tes anggaran ${code}`, source: "MANUAL", actor: owner, lines: [{ accountCode: code, debit: amount }, { accountCode: COA.KAS, credit: amount }] }));

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  owner = { id: u.id, name: u.name };
  const id = async (code: string) => (await prisma.coaAccount.findUniqueOrThrow({ where: { code } })).id;
  transport = await id("6-1200");
  listrik = await id("6-1300");
  iklan = await id("6-1600");
  await prisma.telegramIdentity.upsert({ where: { telegramUserId: "777099" }, create: { telegramUserId: "777099", userId: u.id, chatId: "777099" }, update: { active: true, chatId: "777099" } });
});

describe("anggaran beban", () => {
  it("level: aman < 80% ≤ waspada < 100% ≤ lewat", () => {
    expect(levelOf(1000, 799).level).toBe("AMAN");
    expect(levelOf(1000, 800).level).toBe("WASPADA");
    expect(levelOf(1000, 1000).level).toBe("LEWAT");
    expect(levelOf(0, 5).level).toBe("TANPA");
    expect(levelOf(1000, 125).pct).toBe(12.5);
  });

  it("menolak akun bukan beban dan nominal 0", async () => {
    const kas = await prisma.coaAccount.findUniqueOrThrow({ where: { code: COA.KAS } });
    await expect(saveBudget({ year: Y, month: M, accountId: kas.id, amount: 1000 }, owner)).rejects.toThrow(/akun beban/);
    await expect(saveBudget({ year: Y, month: M, accountId: transport, amount: 0 }, owner)).rejects.toThrow(/lebih dari 0/);
  });

  it("realisasi dari jurnal, termasuk jurnal pembalik, dan akun tanpa anggaran ikut tampil", async () => {
    await saveBudget({ year: Y, month: M, accountId: transport, amount: 1_000_000 }, owner);
    await saveBudget({ year: Y, month: M, accountId: listrik, amount: 500_000, note: "PLN" }, owner);
    await spend("6-1200", 850_000);
    const wrong = await spend("6-1300", 200_000);
    await prisma.$transaction((tx) => reverseJournal(tx, wrong.id, jakartaDateTime("2031-03-11", "12:00"), owner, "salah catat"));
    await spend("6-1300", 520_000);
    await spend("6-1600", 75_000);
    await spend("6-1200", 999_000, "2031-04-02"); // bulan lain, tidak dihitung
    const r = await budgetReport(Y, M);
    const t = r.rows.find((x) => x.accountId === transport)!;
    const l = r.rows.find((x) => x.accountId === listrik)!;
    const i = r.rows.find((x) => x.accountId === iklan)!;
    expect([t.actual, t.pct, t.level]).toEqual([850_000, 85, "WASPADA"]);
    expect([l.actual, l.level, l.remaining]).toEqual([520_000, "LEWAT", -20_000]);
    expect([i.budgetId, i.level, i.actual]).toEqual([null, "TANPA", 75_000]);
    expect(r.totalBudget).toBe(1_500_000);
    expect(r.budgetedActual).toBe(1_370_000);
    expect(r.totalActual).toBe(1_445_000);
  });

  it("peringatan dashboard untuk bulan berjalan", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const w = await budgetWarnings();
      expect(w.over.map((x) => x.accountId)).toEqual([listrik]);
      expect(w.warn.map((x) => x.accountId)).toEqual([transport]);
      const alerts = await alertsFor((p) => p === "accounting.view");
      expect(alerts.find((a) => a.key === "budget-over")?.count).toBe(1);
      expect(alerts.find((a) => a.key === "budget-warn")?.count).toBe(1);
      expect((await alertsFor(() => false)).find((a) => a.key.startsWith("budget"))).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifikasi bot ke Owner sekali per ambang per akun per bulan", async () => {
    sent.length = 0;
    expect(await sendBudgetNotice(NOW)).toMatchObject({ sent: expect.any(Number) });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toContain("Beban Transport");
    expect(sent[0]).toContain("Beban Listrik");
    sent.length = 0;
    expect((await pendingBudgetNotices(NOW)).items).toHaveLength(0);
    await sendBudgetNotice(NOW);
    expect(sent).toHaveLength(0);
    // Transport naik dari 85% ke ≥100% → kirim lagi, hanya transport
    await spend("6-1200", 200_000, "2031-03-15");
    await sendBudgetNotice(NOW);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toContain("Beban Transport");
    expect(sent[0]).not.toContain("Beban Listrik");
  });

  it("salin dari bulan lalu tanpa menimpa yang sudah ada, lalu hapus", async () => {
    await saveBudget({ year: Y, month: M + 1, accountId: transport, amount: 2_000_000 }, owner);
    const r = await copyBudgetFromPrev(Y, M + 1, owner);
    expect(r).toEqual({ copied: 1, skipped: 1 });
    const apr = await prisma.expenseBudget.findMany({ where: { year: Y, month: M + 1 } });
    expect(apr.find((b) => b.accountId === transport)?.amount).toBe(2_000_000n);
    expect(apr.find((b) => b.accountId === listrik)?.note).toBe("PLN");
    await expect(copyBudgetFromPrev(Y, 1, owner)).rejects.toThrow(/Belum ada anggaran/);
    await deleteBudget(apr[0].id, owner);
    expect(await prisma.expenseBudget.count({ where: { year: Y, month: M + 1 } })).toBe(1);
  });
});
