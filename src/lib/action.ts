import "server-only";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertPerm, ForbiddenError } from "./auth";
import type { Permission } from "./rbac";
import { AccountingError } from "./accounting";
import { FinanceError } from "./finance";
import { StockError } from "./stock";
import { PayrollError } from "./payroll";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";

export type ActionResult = { ok: boolean; message?: string; error?: string; ts?: number };

type User = Awaited<ReturnType<typeof assertPerm>>;

/**
 * Pembungkus server action: cek izin, tangkap error domain menjadi pesan ramah,
 * dan revalidate path terkait.
 */
export function action(perms: Permission | Permission[], fn: (fd: FormData, user: User) => Promise<string | void>, revalidate: string[] = []) {
  return async (_prev: ActionResult | null, fd: FormData): Promise<ActionResult> => {
    try {
      const user = await assertPerm(...(Array.isArray(perms) ? perms : [perms]));
      const message = await fn(fd, user);
      for (const p of revalidate) revalidatePath(p, "layout");
      return { ok: true, message: message || "Tersimpan", ts: Date.now() };
    } catch (e) {
      unstable_rethrow(e); // biarkan redirect()/notFound() Next.js lewat
      return { ok: false, error: friendly(e), ts: Date.now() };
    }
  };
}

export function friendly(e: unknown): string {
  if (e instanceof ForbiddenError || e instanceof AccountingError || e instanceof FinanceError || e instanceof StockError || e instanceof PayrollError) return e.message;
  if (e instanceof ZodError) return e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") return "Data sudah ada (duplikat). Periksa kode/nama yang unik.";
    if (e.code === "P2003") return "Data masih dipakai oleh data lain sehingga tidak dapat dihapus.";
    if (e.code === "P2025") return "Data tidak ditemukan.";
  }
  if (e instanceof Error && /append-only|tidak dapat diubah/.test(e.message)) return e.message;
  console.error(e);
  return e instanceof Error && e.message.length < 200 ? e.message : "Terjadi kesalahan. Silakan coba lagi.";
}

// ---------- helper parsing FormData ----------
export const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
export const optStr = (fd: FormData, k: string) => str(fd, k) || null;
export const int = (fd: FormData, k: string, def = 0) => {
  const s = str(fd, k).replace(/\./g, "").replace(/,/g, ".");
  if (!s) return def;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Nilai ${k} tidak valid`);
  return Math.round(n);
};
export const dec = (fd: FormData, k: string, def = 0) => {
  const s = str(fd, k).replace(",", ".");
  if (!s) return def;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Nilai ${k} tidak valid`);
  return n;
};
export const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
