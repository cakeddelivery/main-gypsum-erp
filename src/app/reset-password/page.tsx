import Link from "next/link";
import type { Metadata } from "next";
import { ActionForm, Submit } from "@/components/ActionForm";
import { PasswordInput } from "@/components/PasswordInput";
import { RESET_INVALID, findValidResetToken } from "@/lib/passwordReset";
import { AuthCard } from "../login/AuthCard";
import { resetPasswordAction } from "../lupa-password/actions";

// Token ada di URL: jangan bocorkan lewat header Referer
export const metadata: Metadata = { title: "Buat password baru", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const row = await findValidResetToken(token);
  return (
    <AuthCard subtitle="Buat password baru">
      {row ? (
        <ActionForm action={resetPasswordAction} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <p className="text-sm text-slate-600">Akun: <b className="font-mono">{row.user.username}</b>. Setelah password diganti, semua perangkat yang sedang login akan keluar.</p>
          {/* username tersembunyi agar pengelola password di browser menyimpan ke akun yang benar */}
          <input type="text" name="username" value={row.user.username} autoComplete="username" readOnly hidden />
          <label className="block">
            <span className="label">Password baru</span>
            <PasswordInput name="password" autoComplete="new-password" minLength={8} required />
            <span className="mt-1 block text-xs text-slate-500">Minimal 8 karakter</span>
          </label>
          <label className="block">
            <span className="label">Ulangi password baru</span>
            <PasswordInput name="confirm" autoComplete="new-password" minLength={8} required />
          </label>
          <Submit className="btn-primary w-full">Simpan password baru</Submit>
        </ActionForm>
      ) : (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-3 text-sm text-rose-700">{RESET_INVALID}</p>
      )}
      <p className="mt-4 flex justify-between text-sm"><Link href="/lupa-password" className="link">Minta link baru</Link><Link href="/login" className="link">Halaman masuk</Link></p>
    </AuthCard>
  );
}
