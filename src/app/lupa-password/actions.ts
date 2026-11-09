"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clientIp, hashPassword } from "@/lib/auth";
import { requestPasswordReset, resetPasswordWithToken } from "@/lib/passwordReset";
import { friendly, type ActionResult } from "@/lib/action";

export async function requestResetAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await requestPasswordReset(String(fd.get("identifier") ?? ""), await clientIp());
  return r.ok ? { ok: true, message: r.message, ts: Date.now() } : { ok: false, error: r.error, ts: Date.now() };
}

export async function resetPasswordAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let ok = false;
  try {
    const pw = z.string().min(8, "Password baru minimal 8 karakter").max(200).parse(String(fd.get("password") ?? ""));
    if (pw !== String(fd.get("confirm") ?? "")) throw new Error("Konfirmasi password baru tidak sama");
    const r = await resetPasswordWithToken(String(fd.get("token") ?? ""), await hashPassword(pw), await clientIp());
    if (!r.ok) return { ok: false, error: r.error, ts: Date.now() };
    ok = true;
  } catch (e) {
    return { ok: false, error: friendly(e), ts: Date.now() };
  }
  if (ok) redirect("/login?reset=ok");
  return { ok: false, error: "Gagal", ts: Date.now() };
}
