"use server";
import { headers } from "next/headers";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { pushConfigured, removeSubscription, saveSubscription, sendPush, type SubscriptionInput } from "@/lib/push";

/** Simpan langganan notifikasi perangkat ini untuk akun yang sedang login */
export async function savePushSubscription(sub: SubscriptionInput) {
  const user = await requireUser();
  await saveSubscription(user.id, sub, (await headers()).get("user-agent"));
  return { ok: true };
}

/** Matikan notifikasi di perangkat ini */
export async function removePushSubscription(endpoint: string) {
  const user = await requireUser();
  await removeSubscription(user.id, endpoint);
  return { ok: true };
}

/** Kirim notifikasi tes ke semua perangkat akun ini */
export async function sendTestPush() {
  const user = await requireUser();
  if (!pushConfigured()) return { ok: false, message: "Notifikasi belum disiapkan di server (kunci VAPID belum dipasang)." };
  const devices = await prisma.pushSubscription.count({ where: { userId: user.id } });
  if (!devices) return { ok: false, message: "Belum ada perangkat yang aktif. Tekan Aktifkan notifikasi dulu." };
  const r = await sendPush([user.id], { title: "Tes notifikasi Main Gypsum", body: `Halo ${user.name}, notifikasi sudah aktif di HP ini. 👍`, url: "/profil", tag: "tes" });
  return r.sent ? { ok: true, message: `Notifikasi tes terkirim ke ${r.sent} perangkat.` } : { ok: false, message: "Notifikasi tes gagal terkirim. Coba matikan lalu aktifkan lagi." };
}
