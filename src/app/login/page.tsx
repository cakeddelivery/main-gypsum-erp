import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { ActionForm, Submit } from "@/components/ActionForm";
import { PasswordInput } from "@/components/PasswordInput";
import { GOOGLE_ERRORS, googleConfigured, safeNext, type GoogleError } from "@/lib/googleAuth";
import { AuthCard } from "./AuthCard";
import { loginAction } from "./actions";

export const metadata = { title: "Masuk" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; google?: string; reset?: string }> }) {
  if (await getUser()) redirect("/");
  const { next, google, reset } = await searchParams;
  const nextPath = safeNext(next ?? "/");
  const googleError = google && google in GOOGLE_ERRORS ? GOOGLE_ERRORS[google as GoogleError] : null;
  return (
    <AuthCard>
      {reset === "ok" && <p role="status" className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">✓ Password berhasil diganti. Silakan masuk dengan password baru.</p>}
      {googleError && <p role="alert" className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{googleError}</p>}
      <ActionForm action={loginAction} className="space-y-4">
        <input type="hidden" name="next" value={nextPath} />
        <label className="block">
          <span className="label">Username</span>
          <input name="username" className="input" autoComplete="username" autoCapitalize="none" required />
        </label>
        <div>
          <label className="block">
            <span className="label">Password</span>
            <PasswordInput name="password" autoComplete="current-password" required />
          </label>
          <div className="mt-1.5 text-right">
            <Link href="/lupa-password" className="link text-xs">Lupa password?</Link>
          </div>
        </div>
        <Submit className="btn-primary w-full" pendingText="Memeriksa…">
          Masuk
        </Submit>
      </ActionForm>
      {googleConfigured() && (
        <>
          <div className="my-4 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200" />atau<span className="h-px flex-1 bg-slate-200" /></div>
          {/* Link biasa (bukan fetch) agar browser pindah ke halaman Google */}
          <a href={`/api/auth/google?next=${encodeURIComponent(nextPath)}`} className="btn-secondary w-full">
            <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden>
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
              <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
            </svg>
            Masuk dengan Google
          </a>
        </>
      )}
    </AuthCard>
  );
}
