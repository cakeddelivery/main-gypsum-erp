/** Bingkai halaman masuk / lupa password / reset password (logo + judul). */
export function AuthCard({ children, subtitle = "Main Gypsum · Dunia Lukis", wide }: { children: React.ReactNode; subtitle?: string; wide?: boolean }) {
  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500 p-4">
      <div className={`w-full ${wide ? "max-w-xl" : "max-w-sm"} rounded-2xl bg-white p-6 shadow-xl`}>
        <div className="mb-6 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-main-gypsum.png" alt="Logo Main Gypsum" width={128} height={128} className="h-32 w-32 rounded-2xl" />
          <h1 className="mt-3 font-semibold text-slate-900">Main Gypsum ERP</h1>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
        {children}
        {process.env.APP_ENV !== "production" && <p className="mt-4 rounded-lg bg-amber-50 p-2 text-center text-xs text-amber-700">Lingkungan staging · gunakan akun uji dari README</p>}
      </div>
    </div>
  );
}
