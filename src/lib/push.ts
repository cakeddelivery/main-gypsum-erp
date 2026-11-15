import webpush from "web-push";
import { prisma } from "./db";

/**
 * Notifikasi push (Web Push + VAPID) ke aplikasi terpasang / browser.
 * Kunci di .env VPS: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:… atau https://…).
 * Tanpa kunci, fitur push nonaktif (tidak ada yang dikirim, tombol aktifkan tidak muncul).
 */
export type PushPayload = {
  title: string;
  body: string;
  /** Halaman yang dibuka saat notifikasi diketuk (alamat di dalam ERP, mis. /laporan/buka?f=masuk) */
  url?: string;
  /** Notifikasi dengan tag sama menggantikan yang lama (tidak menumpuk) */
  tag?: string;
};

export function pushPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim());
}

let configured = false;
function setup() {
  if (configured) return true;
  if (!pushConfigured()) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:admin@maingypsum.shop", process.env.VAPID_PUBLIC_KEY!.trim(), process.env.VAPID_PRIVATE_KEY!.trim());
  configured = true;
  return true;
}

/** Hanya alamat di dalam aplikasi (cegah notifikasi membuka situs lain) */
export function safeUrl(url: string | undefined): string {
  return url && url.startsWith("/") && !url.startsWith("//") ? url : "/";
}

export type SubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

/** Simpan langganan perangkat ini untuk user (endpoint yang sama dipindah ke user terbaru) */
export async function saveSubscription(userId: string, sub: SubscriptionInput, userAgent?: string | null) {
  if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("Data langganan notifikasi tidak valid");
  const data = { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent?.slice(0, 200) ?? null, failCount: 0 };
  return prisma.pushSubscription.upsert({ where: { endpoint: sub.endpoint }, create: { endpoint: sub.endpoint, ...data }, update: data });
}

export async function removeSubscription(userId: string, endpoint: string) {
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
}

/**
 * Kirim notifikasi ke semua perangkat milik userIds. Langganan kedaluwarsa (404/410) dihapus;
 * yang gagal berulang (≥ 5 kali) juga dihapus. Mengembalikan jumlah terkirim/dihapus/gagal.
 */
export async function sendPush(userIds: string[], payload: PushPayload) {
  const result = { sent: 0, removed: 0, failed: 0, users: 0 };
  const ids = [...new Set(userIds)];
  if (!ids.length || !setup()) return result;
  const subs = await prisma.pushSubscription.findMany({ where: { userId: { in: ids }, user: { active: true } } });
  result.users = new Set(subs.map((s) => s.userId)).size;
  const body = JSON.stringify({ title: payload.title, body: payload.body, url: safeUrl(payload.url), tag: payload.tag });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 4 * 3600, urgency: "normal" });
        result.sent++;
        await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastSentAt: new Date(), failCount: 0 } });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410 || s.failCount >= 4) {
          result.removed++;
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        } else {
          result.failed++;
          await prisma.pushSubscription.update({ where: { id: s.id }, data: { failCount: { increment: 1 } } }).catch(() => {});
        }
      }
    }),
  );
  await prisma.notificationLog.create({ data: { channel: "PUSH", type: payload.tag ?? "PUSH", target: `${result.users} user`, status: result.sent ? "TERKIRIM" : "TIDAK_TERKIRIM", payload: JSON.stringify({ title: payload.title, ...result }) } }).catch(() => {});
  return result;
}
