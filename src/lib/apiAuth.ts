import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "./db";

export const API_SCOPES = {
  "finance:read": "Baca rekening, kategori, status draft, rekap",
  "finance:draft": "Buat & ubah DRAFT transaksi (tidak bisa membukukan)",
} as const;
export type ApiScope = keyof typeof API_SCOPES;

export function hashKey(secret: string) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/** Buat API key baru: mgk_<prefix>_<secret>. Secret hanya ditampilkan sekali. */
export function generateApiKey() {
  const prefix = crypto.randomBytes(4).toString("hex");
  const secret = crypto.randomBytes(24).toString("base64url");
  return { prefix, key: `mgk_${prefix}_${secret}`, hash: hashKey(`mgk_${prefix}_${secret}`) };
}

export function apiError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function authenticateApi(req: Request, scope: ApiScope) {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(mgk_([a-f0-9]{8})_[A-Za-z0-9_-]+)$/);
  if (!m) return { error: apiError(401, "unauthorized", "API key tidak valid") };
  const client = await prisma.apiClient.findUnique({ where: { keyPrefix: m[2] } });
  const expected = client ? Buffer.from(client.keyHash, "hex") : Buffer.alloc(32);
  const given = Buffer.from(hashKey(m[1]), "hex");
  if (!client || !client.active || !crypto.timingSafeEqual(expected, given)) return { error: apiError(401, "unauthorized", "API key tidak valid") };
  if (!client.scopes.split(",").map((s) => s.trim()).includes(scope)) return { error: apiError(403, "forbidden", `Scope ${scope} diperlukan`) };
  await prisma.apiClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } });
  return { client };
}

/**
 * Idempotency: permintaan POST/PATCH wajib membawa header Idempotency-Key.
 * Permintaan ulang dengan key yang sama mengembalikan respons tersimpan.
 */
export async function withIdempotency(req: Request, clientId: string, handler: () => Promise<{ status: number; body: unknown }>) {
  const key = req.headers.get("idempotency-key");
  if (!key || key.length < 8 || key.length > 128) return apiError(400, "idempotency_key_required", "Header Idempotency-Key (8-128 karakter) wajib diisi");
  const fullKey = `${clientId}:${key}`;
  const prev = await prisma.idempotencyRecord.findUnique({ where: { key: fullKey } });
  if (prev) return NextResponse.json(prev.response, { status: prev.status, headers: { "idempotent-replayed": "true" } });
  const { status, body } = await handler();
  const json = JSON.parse(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
  if (status < 500) {
    await prisma.idempotencyRecord.create({ data: { key: fullKey, clientId, status, response: json } }).catch(() => undefined);
  }
  return NextResponse.json(json, { status });
}
