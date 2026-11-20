import { prisma } from "../db";
import { addDays, todayStr } from "../time";

/**
 * Sinkron harian: mulai tanggal tertentu, file Order & Penghasilan marketplace harus diunggah setiap hari per toko/kanal.
 * Tugas Supervisor; Owner jadi cadangan bila Supervisor belum memperbarui. Hanya penilaian (tidak mengubah data).
 */
export const SYNC_START_KEY = "marketplace_sync_start";
export const SYNC_HOUR_KEY = "marketplace_sync_hour";
const wib = (d: Date) => new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);
const wibHour = (d: Date) => new Date(d.getTime() + 7 * 3600000).getUTCHours();

export type SyncState = "OK" | "PERINGATAN" | "MERAH";
/** Terlambat 0 hari = OK · 1 hari = peringatan · ≥ 2 hari = merah */
export function syncVerdict(lastDate: string | null, requiredDate: string, startDate: string): { status: SyncState; behind: number } {
  const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
  const behind = lastDate ? Math.max(0, days(requiredDate, lastDate)) : Math.max(1, days(requiredDate, startDate) + 1);
  return { status: behind === 0 ? "OK" : behind === 1 ? "PERINGATAN" : "MERAH", behind };
}

export type SyncRow = { storeId: string; store: string; channel: string; kind: "ORDER" | "INCOME"; last: Date | null; lastDate: string | null; status: SyncState; behind: number };

export async function syncConfig() {
  const [s, h] = await Promise.all([prisma.setting.findUnique({ where: { key: SYNC_START_KEY } }), prisma.setting.findUnique({ where: { key: SYNC_HOUR_KEY } })]);
  const hour = Number(h?.value);
  return { start: /^\d{4}-\d{2}-\d{2}$/.test(s?.value ?? "") ? s!.value : null, hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 10 };
}

/** Status pembaruan data per toko/kanal/jenis file. Aktif hanya bila tanggal mulai sudah diatur dan sudah tiba. */
export async function syncStatus(now = new Date()) {
  const cfg = await syncConfig();
  const today = todayStr(now);
  // Sebelum jam pengingat, yang dituntut baru data sampai kemarin
  const required = wibHour(now) >= cfg.hour ? today : addDays(today, -1);
  const active = !!cfg.start && required >= cfg.start;
  const out = { ...cfg, today, required, active, rows: [] as SyncRow[], worst: "OK" as SyncState, stale: 0 };
  if (!active) return out;
  const [stores, imports] = await Promise.all([
    prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, select: { id: true, name: true }, orderBy: { code: "asc" } }),
    prisma.marketplaceImport.findMany({ where: { undoneAt: null }, select: { storeId: true, channel: true, kind: true, createdAt: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const last = new Map<string, Date>();
  const tracked = new Set<string>();
  for (const i of imports) {
    const k = `${i.storeId}|${i.channel}|${i.kind}`;
    if (!last.has(k)) last.set(k, i.createdAt);
    tracked.add(`${i.storeId}|${i.channel}`);
  }
  for (const s of stores) {
    for (const ch of ["SHP", "TTS"]) {
      if (!tracked.has(`${s.id}|${ch}`)) continue; // toko/kanal yang belum pernah dipakai tidak ditagih
      for (const kind of ["ORDER", "INCOME"] as const) {
        const l = last.get(`${s.id}|${ch}|${kind}`) ?? null;
        const lastDate = l ? wib(l) : null;
        const v = syncVerdict(lastDate, required, cfg.start!);
        out.rows.push({ storeId: s.id, store: s.name, channel: ch, kind, last: l, lastDate, ...v });
      }
    }
  }
  out.stale = out.rows.filter((r) => r.status !== "OK").length;
  out.worst = out.rows.some((r) => r.status === "MERAH") ? "MERAH" : out.stale ? "PERINGATAN" : "OK";
  return out;
}

/** Pengingat push: Supervisor pada jam yang diatur; Owner (cadangan) 2 jam kemudian bila masih belum diperbarui */
export async function sendMarketplaceSyncReminder(now: Date, audience: "SUPERVISOR" | "OWNER") {
  const st = await syncStatus(now);
  if (!st.active || !st.stale) return { notifikasi: 0 };
  const users = await prisma.user.findMany({ where: { active: true, role: audience }, select: { id: true } });
  const { sendPush } = await import("../push");
  const label = (c: string) => (c === "SHP" ? "Shopee" : "TikTok");
  const lines = st.rows.filter((r) => r.status !== "OK").map((r) => `${r.store} ${label(r.channel)} ${r.kind === "ORDER" ? "order" : "penghasilan"}${r.lastDate ? ` (terakhir ${r.lastDate})` : " (belum ada)"}`);
  const r = await sendPush(users.map((u) => u.id), {
    title: audience === "OWNER" ? "Cadangan: data marketplace belum diperbarui" : "Perbarui data marketplace hari ini",
    body: `${lines.slice(0, 4).join(" · ")}${lines.length > 4 ? ` · +${lines.length - 4} lainnya` : ""}`,
    url: "/penjualan",
    tag: "mp-sync",
  });
  return { notifikasi: 1, perangkat: r.sent, audience, stale: st.stale };
}
