import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { ActionForm, Submit } from "@/components/ActionForm";
import { loginAction } from "./actions";

export const metadata = { title: "Masuk" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-main-gypsum.png" alt="Logo Main Gypsum" width={128} height={128} className="h-32 w-32 rounded-2xl" />
          <h1 className="mt-3 font-semibold text-slate-900">Main Gypsum ERP</h1>
          <p className="text-xs text-slate-500">Main Gypsum · Dunia Lukis</p>
        </div>
        <ActionForm action={loginAction} className="space-y-4">
          <input type="hidden" name="next" value={next ?? "/"} />
          <label className="block">
            <span className="label">Username</span>
            <input name="username" className="input" autoComplete="username" autoCapitalize="none" required />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input name="password" type="password" className="input" autoComplete="current-password" required />
          </label>
          <Submit className="btn-primary w-full" pendingText="Memeriksa…">
            Masuk
          </Submit>
        </ActionForm>
        {process.env.APP_ENV !== "production" && <p className="mt-4 rounded-lg bg-amber-50 p-2 text-center text-xs text-amber-700">Lingkungan staging · gunakan akun uji dari README</p>}
      </div>
    </div>
  );
}
