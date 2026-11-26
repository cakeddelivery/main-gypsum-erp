import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { withIdempotency } from "@/lib/apiAuth";
import { claimJob } from "@/lib/jobClaim";

const R = Math.random().toString(36).slice(2, 8);
const req = (key: string) => new Request("http://x/api/v1/x", { method: "POST", headers: { "idempotency-key": key + R } });

describe("audit duplikat sistem 2", () => {
  it("API v1: dua permintaan paralel dengan Idempotency-Key sama menjalankan handler sekali", async () => {
    let calls = 0;
    const h = async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return { status: 201, body: { id: calls } }; };
    const res = await Promise.all([withIdempotency(req("kunci-paralel-1"), "c1", h), withIdempotency(req("kunci-paralel-1"), "c1", h), withIdempotency(req("kunci-paralel-1"), "c1", h)]);
    expect(calls).toBe(1);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    // setelah selesai: ulang → respons tersimpan, handler tidak jalan lagi
    const again = await withIdempotency(req("kunci-paralel-1"), "c1", h);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(calls).toBe(1);
  });

  it("API v1: handler yang melempar error melepas kunci sehingga bisa dicoba ulang", async () => {
    await expect(withIdempotency(req("kunci-gagal-01"), "c1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const r = await withIdempotency(req("kunci-gagal-01"), "c1", async () => ({ status: 200, body: { ok: 1 } }));
    expect(r.status).toBe(200);
  });

  it("API v1: kunci sementara macet >5 menit diambil alih", async () => {
    await prisma.idempotencyRecord.create({ data: { key: `c1:kunci-macet-01${R}`, clientId: "c1", status: 0, response: {}, createdAt: new Date(Date.now() - 10 * 60_000) } });
    const r = await withIdempotency(req("kunci-macet-01"), "c1", async () => ({ status: 200, body: { ok: 1 } }));
    expect(r.status).toBe(200);
  });

  it("hari bayar borongan memakai klaim atomik yang sama", async () => {
    const r = await Promise.all([1, 2, 3].map(() => claimJob("job_borongan_bayar_uji" + R, "2030-05-05")));
    expect(r.filter(Boolean)).toHaveLength(1);
  });
});
