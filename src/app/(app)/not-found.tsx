import Link from "next/link";
export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h2 className="text-lg font-semibold">Data tidak ditemukan</h2>
      <Link href="/" className="link mt-3 inline-block text-sm">Kembali ke dashboard</Link>
    </div>
  );
}
