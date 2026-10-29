"use server";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getUser, hashPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { friendly, type ActionResult } from "@/lib/action";

/** Tandai notifikasi sudah dibaca (jumlah saat ini disimpan; bila nanti bertambah, muncul lagi sebagai belum dibaca) */
export async function markAlertsRead(items: { key: string; count: number }[]) {
  const user = await getUser();
  if (!user) return;
  for (const it of items.slice(0, 50)) {
    const key = String(it.key).slice(0, 40);
    const count = Math.max(0, Math.floor(Number(it.count) || 0));
    await prisma.alertRead.upsert({ where: { userId_key: { userId: user.id, key } }, create: { userId: user.id, key, count }, update: { count, readAt: new Date() } });
  }
  revalidatePath("/", "layout");
}

/** Ganti password akun sendiri (semua role) */
export async function changeOwnPassword(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  try {
    const user = await getUser();
    if (!user) throw new Error("Sesi berakhir, silakan login ulang");
    const current = String(fd.get("current") ?? "");
    const next = z.string().min(8, "Password baru minimal 8 karakter").parse(String(fd.get("password") ?? ""));
    if (next !== String(fd.get("confirm") ?? "")) throw new Error("Konfirmasi password baru tidak sama");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await bcrypt.compare(current, row.passwordHash))) throw new Error("Password lama salah");
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next) } });
    await audit(user, "PASSWORD_DIGANTI", "User", user.id);
    return { ok: true, message: "Password berhasil diganti", ts: Date.now() };
  } catch (e) {
    return { ok: false, error: friendly(e), ts: Date.now() };
  }
}
