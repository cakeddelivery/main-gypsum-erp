import Link from "next/link";
export default function Forbidden() {
  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="max-w-sm text-center">
        <div className="text-4xl">🔒</div>
        <h1 className="mt-2 text-lg font-semibold">Akses ditolak</h1>
        <p className="mt-1 text-sm text-slate-500">Role Anda tidak memiliki izin untuk membuka menu ini. Hubungi Owner bila perlu akses.</p>
        <Link href="/" className="btn-primary mt-4">Ke dashboard</Link>
      </div>
    </div>
  );
}
