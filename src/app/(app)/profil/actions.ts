"use server";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getUser, hashPassword, refreshSession } from "@/lib/auth";
import { passwordChangeData } from "@/lib/loginGuard";
import { audit } from "@/lib/audit";
import { normEmail } from "@/lib/email";
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
    // Versi sesi naik → semua sesi lain (HP/komputer lain) otomatis keluar; sesi ini diterbitkan ulang.
    await prisma.user.update({ where: { id: user.id }, data: passwordChangeData(await hashPassword(next)) });
    await refreshSession(user.id);
    await audit(user, "PASSWORD_DIGANTI", "User", user.id);
    return { ok: true, message: "Password berhasil diganti", ts: Date.now() };
  } catch (e) {
    return { ok: false, error: friendly(e), ts: Date.now() };
  }
}

/** Ubah email akun sendiri (wajib password saat ini, karena email dipakai untuk reset password & login Google) */
export async function saveOwnEmail(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  try {
    const user = await getUser();
    if (!user) throw new Error("Sesi berakhir, silakan login ulang");
    const email = normEmail(String(fd.get("email") ?? ""));
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await bcrypt.compare(String(fd.get("current") ?? ""), row.passwordHash))) throw new Error("Password saat ini salah");
    if (email && (await prisma.user.findFirst({ where: { email, id: { not: user.id } } }))) throw new Error("Email sudah dipakai akun lain");
    await prisma.user.update({ where: { id: user.id }, data: { email } });
    await audit(user, "EMAIL_DIUBAH", "User", user.id, { dari: row.email, ke: email });
    revalidatePath("/profil");
    return { ok: true, message: email ? "Email tersimpan" : "Email dihapus", ts: Date.now() };
  } catch (e) {
    return { ok: false, error: friendly(e), ts: Date.now() };
  }
}
