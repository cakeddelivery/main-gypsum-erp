import Link from "next/link";
import { ActionForm, Submit } from "@/components/ActionForm";
import { mailConfigured } from "@/lib/mail";
import { RESET_NO_SMTP_MESSAGE } from "@/lib/passwordReset";
import { AuthCard } from "../login/AuthCard";
import { requestResetAction } from "./actions";

export const metadata = { title: "Lupa password" };
export const dynamic = "force-dynamic";

export default function LupaPasswordPage() {
  return (
    <AuthCard subtitle="Lupa password">
      {mailConfigured() ? (
        <ActionForm action={requestResetAction} className="space-y-4" persist resetOnSuccess>
          <p className="text-sm text-slate-600">Ketik username atau email akun Anda. Kami kirim link untuk membuat password baru ke email yang terdaftar di akun.</p>
          <label className="block">
            <span className="label">Username atau email</span>
            <input name="identifier" className="input" autoComplete="username" autoCapitalize="none" maxLength={120} required />
          </label>
          <Submit className="btn-primary w-full" pendingText="Mengirim…">Kirim link reset</Submit>
        </ActionForm>
      ) : (
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-800">{RESET_NO_SMTP_MESSAGE} Owner dapat mengganti password Anda di Pengaturan → Pengguna.</p>
      )}
      <p className="mt-4 text-center text-sm"><Link href="/login" className="link">← Kembali ke halaman masuk</Link></p>
    </AuthCard>
  );
}
