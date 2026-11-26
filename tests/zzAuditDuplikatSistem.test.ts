import { describe, expect, it, vi } from "vitest";

const handled: number[] = [];
vi.mock("@/lib/bot", () => ({ handleTelegramUpdate: vi.fn(async (u: { update_id: number }) => { await new Promise((r) => setTimeout(r, 20)); handled.push(u.update_id); }) }));
vi.mock("@/lib/telegram", async (orig) => ({ ...(await orig<typeof import("@/lib/telegram")>()), sendTelegram: vi.fn(async () => ({ ok: true })) }));

import { prisma } from "@/lib/db";
import { claimJob, runDueJobs } from "@/lib/jobs";
import { jakartaDateTime } from "@/lib/time";
import { POST } from "@/app/api/telegram/webhook/route";

const req = (id: number) => new Request("http://x/api/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "rahasia-uji" }, body: JSON.stringify({ update_id: id, message: { message_id: id, chat: { id: 1 }, text: "/menu" } }) });

describe("audit duplikat sistem", () => {
  it("claimJob: dua pemanggil paralel → hanya satu yang menang; tanggal baru boleh lagi", async () => {
    await prisma.setting.deleteMany({ where: { key: "job_uji_klaim" } });
    const r = await Promise.all(Array.from({ length: 6 }, () => claimJob("job_uji_klaim", "2030-01-01")));
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(await claimJob("job_uji_klaim", "2030-01-01")).toBe(false);
    expect(await claimJob("job_uji_klaim", "2030-01-02")).toBe(true);
  });

  it("runDueJobs dipanggil paralel (dua instance): rekap harian & slip gaji hanya jalan sekali", async () => {
    await prisma.setting.deleteMany({ where: { key: { startsWith: "job_" } } });
    await runDueJobs(jakartaDateTime("2030-03-04", "02:00")); // pemanasan impor dinamis (di produksi satu proses sudah hangat)
    await prisma.setting.deleteMany({ where: { key: { startsWith: "job_" } } });
    const t = jakartaDateTime("2030-03-05", "13:00");
    const rs = await Promise.all([runDueJobs(t), runDueJobs(t), runDueJobs(t)]);
    expect(rs.filter((r) => "dailyRecap" in r)).toHaveLength(1);
    expect(rs.filter((r) => "monthlyPayroll" in r)).toHaveLength(1);
    const again = await runDueJobs(t);
    expect("dailyRecap" in again).toBe(false);
  });

  it("webhook Telegram: update_id sama (kirim ulang / paralel) diproses sekali", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "rahasia-uji";
    delete process.env.HERMES_WEBHOOK_URL;
    handled.length = 0;
    await prisma.reminderLog.deleteMany({ where: { key: { startsWith: "tg-update:" } } });
    await Promise.all([POST(req(900001)), POST(req(900001))]);
    await POST(req(900001));
    expect(handled).toEqual([900001]);
    await POST(req(900002));
    expect(handled).toEqual([900001, 900002]);
  });
});
