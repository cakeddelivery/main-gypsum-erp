import Link from "next/link";
import { AuthCard } from "../../login/AuthCard";

export const metadata = { title: "Pendaftaran terkirim" };

export default async function SelesaiPage({ searchParams }: { searchParams: Promise<{ no?: string }> }) {
  const { no } = await searchParams;
  return (
    <AuthCard subtitle="Pendaftaran karyawan">
      <div role="status" className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
        <p className="font-semibold">Pendaftaran terkirim{no ? ` (${no})` : ""}.</p>
        <p className="mt-1">Owner akan memverifikasi data Anda. Setelah disetujui, Anda bisa masuk dengan username & password yang tadi dibuat.</p>
      </div>
      <p className="mt-4 text-center text-sm"><Link href="/login" className="link">Ke halaman masuk</Link></p>
    </AuthCard>
  );
}
