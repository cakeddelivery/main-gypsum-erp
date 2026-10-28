"use client";
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-rose-200 bg-white p-6 text-center">
      <h2 className="text-lg font-semibold text-rose-700">Terjadi kesalahan</h2>
      <p className="mt-2 text-sm text-slate-600">Halaman tidak dapat dimuat. {error.digest && <span className="text-xs text-slate-400">Kode: {error.digest}</span>}</p>
      <button className="btn-primary mt-4" onClick={reset}>
        Coba lagi
      </button>
    </div>
  );
}
