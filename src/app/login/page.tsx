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
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-600 font-bold text-white">MG</span>
          <div>
            <h1 className="font-semibold text-slate-900">Main Gypsum ERP</h1>
            <p className="text-xs text-slate-500">Main Gypsum · Dunia Lukis</p>
          </div>
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
