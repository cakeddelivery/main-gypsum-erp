import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertPerm, ForbiddenError } from "./auth";
import type { Permission } from "./rbac";
import { AccountingError } from "./accounting";
import { FinanceError } from "./finance";
import { StockError } from "./stock";
import { PayrollError } from "./payroll";
import { ZodError } from "zod";
import { EmailError } from "./email";
import { RegistrationError } from "./registration";
import { Prisma } from "@prisma/client";
import { FieldError, fieldsOf } from "./fieldError";
import { claimToken, finishToken, releaseToken } from "./actionToken";
export { FieldError };

export type ActionResult = {
  ok: boolean;
  message?: string;
  error?: string;
  ts?: number;
  /** Kolom yang salah (name → pesan): ditandai merah di form dan difokus */
  fields?: Record<string, string>;
};

type User = Awaited<ReturnType<typeof assertPerm>>;

/**
 * Pembungkus server action: cek izin, tangkap error domain menjadi pesan ramah,
 * dan revalidate path terkait.
 */
export function action(perms: Permission | Permission[], fn: (fd: FormData, user: User) => Promise<string | void>, revalidate: string[] = []) {
  return async (_prev: ActionResult | null, fd: FormData): Promise<ActionResult> => {
    try {
      const user = await assertPerm(...(Array.isArray(perms) ? perms : [perms]));
      // Token kirim-form: kirim ulang (klik ganda, retry, tab ganda) dengan token sama tidak menjalankan aksi dua kali
      const raw = fd.get("_idem");
      const token = typeof raw === "string" && /^[\w-]{8,64}$/.test(raw) ? `${user.id}:${raw}` : null;
      if (token) {
        const c = await claimToken(token, user.id);
        if (!c.fresh) {
          if (c.state === "SELESAI") return { ok: true, message: c.message ?? "Tersimpan", ts: Date.now() };
          return { ok: false, error: "Permintaan yang sama masih diproses. Tunggu sebentar lalu cek daftar sebelum menyimpan lagi.", ts: Date.now() };
        }
      }
      let message: string | void;
      try {
        message = await fn(fd, user);
      } catch (e) {
        // redirect() sukses juga lewat throw: token tetap terpakai; error lain melepas token agar bisa dikirim ulang
        if (token) await (isRedirect(e) ? finishToken(token, "Tersimpan") : releaseToken(token)).catch(() => 0);
        throw e;
      }
      if (token) await finishToken(token, message || "Tersimpan").catch(() => 0);
      for (const p of revalidate) revalidatePath(p, "layout");
      // Angka di lonceng peringatan ikut segar setelah data berubah (lihat cachedAlerts)
      revalidateTag("alerts");
      return { ok: true, message: message || "Tersimpan", ts: Date.now() };
    } catch (e) {
      unstable_rethrow(e); // biarkan redirect()/notFound() Next.js lewat
      return { ok: false, error: friendly(e), fields: fieldsOf(e), ts: Date.now() };
    }
  };
}

const isRedirect = (e: unknown) => typeof (e as { digest?: unknown })?.digest === "string" && /^NEXT_REDIRECT/.test((e as { digest: string }).digest);

/** Batas panjang pesan Error biasa yang boleh tampil ke pengguna */
export const MAX_USER_MESSAGE = 600;

export function friendly(e: unknown): string {
  if (e instanceof ForbiddenError || e instanceof AccountingError || e instanceof FinanceError || e instanceof StockError || e instanceof PayrollError || e instanceof EmailError || e instanceof RegistrationError || e instanceof FieldError) return e.message;
  if (e instanceof ZodError) return e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") return "Data sudah ada (duplikat). Periksa kode/nama yang unik.";
    if (e.code === "P2003") return "Data masih dipakai oleh data lain sehingga tidak dapat dihapus.";
    if (e.code === "P2025") return "Data tidak ditemukan.";
  }
  if (e instanceof Error && /append-only|tidak dapat diubah/.test(e.message)) return e.message;
  console.error(e);
  // Pesan sengaja untuk pengguna (mis. daftar stok akhir yang belum diisi bisa >200 huruf) tetap ditampilkan; pesan internal (Prisma/stack) disembunyikan
  if (e instanceof Error && e.message.length < MAX_USER_MESSAGE && !/Invalid `|prisma|\n\s+at /i.test(e.message)) return e.message;
  return "Terjadi kesalahan. Silakan coba lagi.";
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
