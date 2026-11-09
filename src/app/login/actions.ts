"use server";
import { redirect } from "next/navigation";
import { login } from "@/lib/auth";
import type { ActionResult } from "@/lib/action";
import { safeNext } from "@/lib/googleAuth";

export async function loginAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const username = String(fd.get("username") ?? "");
  const password = String(fd.get("password") ?? "");
  if (!username || !password) return { ok: false, error: "Isi username dan password" };
  const r = await login(username, password);
  if (!r.ok) return { ok: false, error: r.error, ts: Date.now() };
  redirect(safeNext(String(fd.get("next") ?? "/")));
}
