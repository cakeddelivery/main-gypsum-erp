import Link from "next/link";
import { ActionForm, Submit } from "@/components/ActionForm";
import { PasswordInput } from "@/components/PasswordInput";
import { validInvite } from "@/lib/registration";
import { todayStr } from "@/lib/time";
import { AuthCard } from "../login/AuthCard";
import { registerAction } from "./actions";
import { BankSelect } from "@/components/BankSelect";
import { ChoiceEnhancer } from "@/components/ChoiceEnhancer";

export const metadata = { title: "Pendaftaran karyawan" };
export const dynamic = "force-dynamic";

const L = ({ label, hint, children, wide }: { label: string; hint?: string; children: React.ReactNode; wide?: boolean }) => (
  <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
    <span className="label">{label}</span>
    {children}
    {hint && <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>}
  </label>
);

/** Form pendaftaran karyawan, diisi sendiri oleh calon karyawan lewat tautan undangan Owner */
export default async function DaftarPage({ searchParams }: { searchParams: Promise<{ kode?: string }> }) {
  const { kode } = await searchParams;
  const inv = await validInvite(kode);
  if (!inv) {
    return (
      <AuthCard subtitle="Pendaftaran karyawan">
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-800">Tautan pendaftaran tidak berlaku atau sudah kedaluwarsa. Minta tautan baru ke Owner Main Gypsum.</p>
        <p className="mt-4 text-center text-sm"><Link href="/login" className="link">Sudah punya akun? Masuk</Link></p>
      </AuthCard>
    );
  }
  return (
    <AuthCard subtitle="Formulir pendaftaran karyawan" wide>
      {/* Dropdown bisa dicari & pilihan ≤3 jadi tombol, sama seperti di dalam aplikasi */}
      <ChoiceEnhancer />
      <ActionForm action={registerAction} className="space-y-4" persist>
        <input type="hidden" name="kode" value={kode} />
        {/* Honeypot anti-bot: tidak terlihat, jangan diisi */}
        <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
        <p className="text-sm text-slate-600">Isi data diri dengan benar. Setelah dikirim, Owner akan memverifikasi. Akun baru bisa dipakai masuk setelah disetujui.</p>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Data diri</legend>
          <L label="Nama lengkap" wide><input name="fullName" className="input" autoComplete="name" required maxLength={80} /></L>
          <L label="Nama panggilan"><input name="nickname" className="input" autoComplete="nickname" required maxLength={30} /></L>
          <L label="Jenis kelamin">
            <select name="gender" className="input" required defaultValue=""><option value="" disabled>— pilih —</option><option value="L">Laki-laki</option><option value="P">Perempuan</option></select>
          </L>
          <L label="Tempat lahir"><input name="birthPlace" className="input" required maxLength={60} /></L>
          <L label="Tanggal lahir"><input type="date" name="birthDate" className="input" required max={todayStr()} /></L>
          <L label="Alamat lengkap" wide><textarea name="address" className="input" rows={2} required maxLength={300} placeholder="Jalan, RT/RW, desa/kelurahan, kecamatan, kota" /></L>
          <L label="No. WhatsApp" hint="Contoh: 081234567890"><input name="phone" type="tel" inputMode="tel" className="input" autoComplete="tel" required /></L>
          <L label="Email" hint="Untuk lupa password & masuk dengan Google"><input name="email" type="email" className="input" autoComplete="email" autoCapitalize="none" required /></L>
          <L label="Tanggal mulai kerja" hint="Usulan; Owner bisa menyesuaikan" wide><input type="date" name="startDate" className="input" required defaultValue={todayStr()} /></L>
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Rekening gaji</legend>
          <div className="block sm:col-span-2"><span className="label">Nama bank / e-wallet</span><BankSelect required /></div>
          <L label="No. rekening"><input name="bankAccountNo" inputMode="numeric" className="input" required /></L>
          <L label="Atas nama rekening"><input name="bankAccountName" className="input" required maxLength={80} /></L>
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Akun login</legend>
          <L label="Username" hint="Huruf kecil/angka, tanpa spasi" wide><input name="username" className="input" autoComplete="username" autoCapitalize="none" required pattern="[a-zA-Z0-9._\-]{3,30}" /></L>
          <L label="Password" hint="Minimal 8 karakter"><PasswordInput name="password" autoComplete="new-password" minLength={8} required /></L>
          <L label="Ulangi password"><PasswordInput name="confirm" autoComplete="new-password" minLength={8} required /></L>
        </fieldset>
        <Submit className="btn-primary w-full" pendingText="Mengirim…">Kirim pendaftaran</Submit>
      </ActionForm>
      <p className="mt-4 text-center text-sm"><Link href="/login" className="link">Sudah punya akun? Masuk</Link></p>
    </AuthCard>
  );
}
