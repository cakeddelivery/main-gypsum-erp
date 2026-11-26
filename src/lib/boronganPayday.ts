import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { claimJob } from "./jobClaim";
import { coordinatorsAt } from "./borongan";
import { claimBreakdown, claimable } from "./boronganClaim";
import { jakartaParts, todayStr } from "./time";
import type { Alert } from "./alerts";

type DB = PrismaClient | Prisma.TransactionClient;
type Actor = { id: string; name: string };

/**
 * Hari bayar upah borongan per titik (mis. Beringin: Senin). Pengingat dikirim SEHARI SEBELUMNYA (Beringin: Minggu)
 * pada jam pengingat (bawaan 08:00 WIB) ke koordinator/pencatat titik itu + Finance + Owner, berisi ringkasan setoran yang
 * belum diklaim. Setting JSON: { [pointId]: { day: 0–6 (0 = Minggu, 1 = Senin, …), time: "HH:MM" } }.
 */
export const PAYDAY_KEY = "borongan_hari_bayar";
export const DEFAULT_REMIND_TIME = "08:00";
export const DAY_NAMES = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"] as const;
export type PaydayConfig = Record<string, { day: number; time: string }>;

export async function paydayConfig(db: DB = prisma): Promise<PaydayConfig> {
  const raw = (await db.setting.findUnique({ where: { key: PAYDAY_KEY } }))?.value;
  try {
    const v = raw ? (JSON.parse(raw) as PaydayConfig) : {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => Number.isInteger(x?.day) && x.day >= 0 && x.day <= 6).map(([k, x]) => [k, { day: x.day, time: /^\d{2}:\d{2}$/.test(x.time ?? "") ? x.time : DEFAULT_REMIND_TIME }]));
  } catch {
    return {};
  }
}

/** Atur hari bayar titik (null = tanpa pengingat) dan jam pengingat (sehari sebelumnya) */
export async function savePayday(pointId: string, day: number | null, time: string, actor: Actor) {
  if (day != null && !(Number.isInteger(day) && day >= 0 && day <= 6)) throw new Error("Hari bayar tidak valid");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Jam pengingat tidak valid (HH:MM)");
  const cfg = await paydayConfig();
  if (day == null) delete cfg[pointId];
  else cfg[pointId] = { day, time };
  await prisma.setting.upsert({ where: { key: PAYDAY_KEY }, create: { key: PAYDAY_KEY, value: JSON.stringify(cfg) }, update: { value: JSON.stringify(cfg) } });
  await audit(actor, "BORONGAN_HARI_BAYAR", "BoronganPoint", pointId, { hariBayar: day == null ? null : DAY_NAMES[day], jamPengingat: day == null ? null : time });
}

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
/** Hari pengingat = sehari sebelum hari bayar */
export const remindWeekday = (payDay: number) => (payDay + 6) % 7;

/** Titik yang pengingatnya jatuh tempo sekarang (hari pengingat & sudah lewat jamnya) */
export function duePoints(cfg: PaydayConfig, now: Date): string[] {
  const p = jakartaParts(now);
  const minutes = p.hour * 60 + p.minute;
  return Object.entries(cfg).filter(([, x]) => p.weekday === remindWeekday(x.day) && minutes >= toMin(x.time)).map(([id]) => id);
}

/** Ringkasan setoran titik yang belum diklaim (jumlah setoran, pcs, estimasi upah) */
export async function unclaimedSummary(pointId: string, db: DB = prisma) {
  const results = await db.boronganResult.findMany({ where: claimable(pointId), include: { worker: { select: { id: true, name: true } }, coordinator: { select: { id: true, name: true } }, driver: { select: { id: true, name: true } }, task: { select: { name: true } } } });
  return { setoran: results.length, pcs: results.reduce((a, r) => a + r.qty, 0), total: claimBreakdown(results).totals.all };
}

export function paydayText(point: string, payDay: number, s: { setoran: number; pcs: number; total: number }) {
  return {
    title: `Besok ${DAY_NAMES[payDay]} pembayaran upah borongan ${point} — ajukan/cek klaim`,
    body: s.setoran ? `Belum diklaim: ${s.setoran} setoran · ${s.pcs.toLocaleString("id-ID")} pcs · estimasi Rp${s.total.toLocaleString("id-ID")}` : "Semua setoran sudah diklaim — cek klaim yang menunggu persetujuan",
  };
}

/** Penerima: koordinator/pencatat titik (yang punya akun) + Finance + Owner */
export async function paydayRecipients(pointId: string, db: DB = prisma) {
  const [coords, staff] = await Promise.all([
    db.boronganPerson.findMany({ where: { ...coordinatorsAt(pointId), userId: { not: null } }, select: { userId: true } }),
    db.user.findMany({ where: { active: true, role: { in: ["FINANCE", "OWNER"] } }, select: { id: true } }),
  ]);
  return [...new Set([...coords.map((c) => c.userId!), ...staff.map((u) => u.id)])];
}

/** Dipanggil tiap menit oleh runDueJobs: kirim push pengingat (sekali per titik per tanggal) */
export async function sendPaydayReminders(now: Date = new Date()) {
  const cfg = await paydayConfig();
  const date = todayStr(now);
  const sent: string[] = [];
  for (const pointId of duePoints(cfg, now)) {
    const key = `job_borongan_bayar_${pointId}`;
    if (!(await claimJob(key, date))) continue; // atomik: dua proses tidak mengirim dobel
    const point = await prisma.boronganPoint.findUnique({ where: { id: pointId }, select: { name: true, active: true } });
    if (!point?.active) continue;
    const t = paydayText(point.name, cfg[pointId].day, await unclaimedSummary(pointId));
    const { sendPush } = await import("./push");
    await sendPush(await paydayRecipients(pointId), { title: t.title, body: t.body, url: "/borongan?tab=klaim", tag: `borongan-bayar-${pointId}` });
    await prisma.notificationLog.create({ data: { channel: "PUSH", type: "BORONGAN_HARI_BAYAR", target: point.name, status: "TERKIRIM", payload: `${t.title}. ${t.body}` } }).catch(() => {});
    sent.push(point.name);
  }
  return { titik: sent };
}

/**
 * Notifikasi lonceng (in-app) pada hari pengingat (setelah jamnya) dan hari bayar: Finance/Owner untuk semua titik yang
 * diatur, koordinator/pencatat hanya titiknya.
 */
export async function paydayAlerts(user: { id: string; role: string }, now: Date = new Date()): Promise<Alert[]> {
  const cfg = await paydayConfig();
  const ids = Object.keys(cfg);
  if (!ids.length) return [];
  const staff = user.role === "FINANCE" || user.role === "OWNER";
  let mine = ids;
  if (!staff) {
    const c = await prisma.boronganPerson.findFirst({ where: { userId: user.id, role: "KOORDINATOR", active: true }, select: { pointId: true, extraPoints: { select: { pointId: true } } } });
    if (!c) return [];
    const own = new Set([c.pointId, ...c.extraPoints.map((e) => e.pointId)]);
    mine = ids.filter((id) => own.has(id));
  }
  const p = jakartaParts(now);
  const minutes = p.hour * 60 + p.minute;
  const out: Alert[] = [];
  for (const id of mine) {
    const x = cfg[id];
    const remind = p.weekday === remindWeekday(x.day) && minutes >= toMin(x.time);
    const payday = p.weekday === x.day;
    if (!remind && !payday) continue;
    const point = await prisma.boronganPoint.findUnique({ where: { id }, select: { name: true, active: true } });
    if (!point?.active) continue;
    const s = await unclaimedSummary(id);
    const t = paydayText(point.name, x.day, s);
    out.push({ key: `borongan-bayar-${id}-${todayStr(now)}`, label: `${payday ? `Hari ini ${DAY_NAMES[x.day]} pembayaran upah borongan ${point.name} — ajukan/cek klaim` : t.title} · ${t.body}`, count: Math.max(1, s.setoran), href: "/borongan?tab=klaim", tone: "amber" });
  }
  return out;
}
