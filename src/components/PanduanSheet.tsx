import type { Letterhead } from "@/lib/letterhead";
import { reportSteps, type Guide } from "@/lib/panduan";
import { DocSheet } from "./DocSheet";

/** Lebar lembar = A4 tegak; diunduh 2× (pixelRatio 2) → 2480 × 3508 px (300 dpi) */
export const PANDUAN_W = 1240;
export const PANDUAN_H = 1754;

type IconName = "login" | "pin" | "work" | "report" | "home" | "key" | "mail" | "google" | "user" | "lock" | "help" | "camera" | "auto";

function Ico({ name, size = 30 }: { name: IconName; size?: number }) {
  const p: Record<IconName, React.ReactNode> = {
    login: <><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /></>,
    pin: <><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z" /><circle cx="12" cy="10" r="2.6" /></>,
    work: <><path d="M3 7h18v13H3z" /><path d="M8 7V4h8v3" /><path d="M3 12h18" /></>,
    report: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 13h7M9 17h5" /></>,
    home: <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>,
    key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M15 8l2 2" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
    google: <><path d="M20 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h4.5a4 4 0 0 1-1.7 2.6" /><path d="M12 20a8 8 0 1 1 5.3-14" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" /><path d="M12 17h.01" /></>,
    camera: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
    auto: <><path d="M4 12a8 8 0 0 1 14-5.3L20 9" /><path d="M20 4v5h-5" /><path d="M20 12a8 8 0 0 1-14 5.3L4 15" /><path d="M4 20v-5h5" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p[name]}
    </svg>
  );
}

/** Nama tombol/menu persis seperti di aplikasi */
function B({ children }: { children: React.ReactNode }) {
  return <b className="whitespace-nowrap rounded-md bg-[#1e3a8a] px-2 py-0.5 font-bold text-[#ffffff]">{children}</b>;
}

type Phase = { no: number; icon: IconName; when: string; title: string; color: string; soft: string; body: React.ReactNode };

/** Lembar Panduan satu divisi: alur harian bernomor + kotak info penting, dengan kop surat Main Gypsum */
export function PanduanSheet({ id, guide, lh, date }: { id: string; guide: Guide; lh: Letterhead; date: string }) {
  const steps = reportSteps(guide);
  const phases: Phase[] = [
    {
      no: 1, icon: "login", when: "Datang", title: "Masuk ke ERP", color: "#1d4ed8", soft: "#eff6ff",
      body: (
        <>
          <li>Buka ERP di HP, ketik username &amp; password, tekan <B>Masuk</B> (atau <B>Masuk dengan Google</B>). Tetap masuk sampai 90 hari.</li>
          <li>Muncul &quot;Gmail Anda belum diisi&quot;? Tekan <B>Isi Gmail sekarang</B>.</li>
        </>
      ),
    },
    {
      no: 2, icon: "pin", when: "Mulai shift", title: "Absen masuk", color: "#047857", soft: "#ecfdf5",
      body: (
        <>
          <li>Menu <B>Absensi</B> → tekan <B>Absen masuk sekarang</B>.</li>
          <li>Izinkan lokasi (GPS) &amp; berada di lokasi kerja. Lewat 10 menit dari jam shift = telat.</li>
        </>
      ),
    },
    {
      no: 3, icon: "work", when: "Saat bekerja", title: "Catat yang datang", color: "#b45309", soft: "#fffbeb",
      body: (
        <>
          <li>Ada kiriman dari supplier/toko: menu <B>Laporan Shift</B> → <B>+ Barang masuk</B>. Catat <u>sebelum</u> menghitung stok akhir.</li>
          {guide.terima && <li>Hasil borongan datang: buka laporan hari ini → <B>+ Penerimaan borongan</B>, isi total per barang.</li>}
          <li>Stok bahan di bawah limit? Permintaan stok dibuat <b>otomatis</b> dari laporan, tidak perlu lapor manual.</li>
        </>
      ),
    },
    {
      no: 4, icon: "report", when: "Akhir shift", title: "Kirim laporan shift", color: "#7c3aed", soft: "#f5f3ff",
      body: (
        <>
          <li>Tekan tombol bulat <B>+</B> <b>Lapor</b> di tengah bawah. Laporan hari ini &amp; shift sesuai jam HP terbuka sendiri.</li>
          <li className="list-none">
            <div className="my-1 flex flex-wrap items-center gap-2">
              {steps.map((s, i) => (
                <span key={s} className="flex items-center gap-2">
                  <span className="rounded-full border-2 border-[#7c3aed] bg-[#ffffff] px-3 py-0.5 text-[17.5px] font-bold text-[#5b21b6]">{i + 1}. {s}</span>
                  {i < steps.length - 1 && <span className="text-[24px] font-bold text-[#7c3aed]">→</span>}
                </span>
              ))}
            </div>
          </li>
          {guide.hasil.length > 0 && <li><b>Hasil kerja:</b> {guide.hasil.join(" ")}</li>}
          {guide.catatan && <li>{guide.catatan}</li>}
          <li className="flex items-start gap-1"><span><b>Checklist:</b> centang semua; tanda <span className="inline-flex translate-y-1 text-[#7c3aed]"><Ico name="camera" size={22} /></span> &quot;Wajib foto bukti&quot; harus difoto. <b>Stok jadi / Stok akhir:</b> hitung fisik (bila ada).</span></li>
          <li>Tekan <B>Berikutnya ›</B> sampai akhir → <B>Kirim laporan</B> → <B>Ya, kirim</B>. Gambar laporan bisa diunduh lewat <B>🖼️ Lihat &amp; unduh JPG</B>.</li>
        </>
      ),
    },
    {
      no: 5, icon: "home", when: "Pulang", title: "Absen pulang", color: "#be123c", soft: "#fff1f2",
      body: <li>Menu <B>Absensi</B> → tekan <B>Absen pulang</B> (di lokasi kerja).</li>,
    },
  ];

  const infos: { icon: IconName; title: string; body: React.ReactNode }[] = [
    { icon: "key", title: "Lupa password", body: <>Di halaman masuk tekan <B>Lupa password?</B> → ketik username/email → <B>Kirim link reset</B> → buka link di Gmail.</> },
    { icon: "lock", title: "Ganti password", body: <>Ikon akun (kanan atas) → <B>Profil</B> → <B>Ganti password</B> → <B>Simpan password</B>.</> },
    { icon: "mail", title: "Isi Gmail", body: <><B>Profil</B> → <B>Isi email</B> → <B>Simpan email</B>. Gunanya: reset password sendiri, menerima pemberitahuan, dan bisa tekan <B>Masuk dengan Google</B> (Gmail harus sama).</> },
    { icon: "user", title: "PIC otomatis", body: <>Nama PIC laporan diambil dari akun yang mengirim. Selalu pakai akun sendiri.</> },
    { icon: "lock", title: "Jaga akun", body: <>Jangan bagikan password. Di HP orang lain, tekan <B>Keluar</B> setelah selesai.</> },
    { icon: "help", title: "Bila ada error", body: <>Tutup lalu buka lagi aplikasinya. Muncul &quot;Versi baru tersedia&quot;? Isian aman, tekan <B>Muat ulang</B>. Masih error? Foto layarnya, hubungi Kapten divisi atau Admin (WA {lh.phone}).</> },
  ];

  return (
    <div className="panduan">
      <DocSheet
        id={id} lh={lh} exportWidth={PANDUAN_W} eyebrow="Panduan penggunaan ERP" title={`Lembar Panduan Divisi ${guide.name}`}
        subtitle="Langkah harian dari absen masuk sampai absen pulang"
        meta={{ label: "Untuk", value: `Anggota Divisi ${guide.name}` }} signer="Manajemen" signDate={date}
      >
        <div className="text-[#0f172a]">
          <ol className="relative grid gap-2.5">
            {/* garis alur penghubung langkah */}
            <span className="absolute bottom-10 left-[29px] top-10 w-1 rounded bg-[#cbd5e1]" aria-hidden />
            {phases.map((ph) => (
              <li key={ph.no} className="relative flex gap-4">
                <div className="z-10 flex w-[62px] shrink-0 flex-col items-center">
                  <span className="grid h-[62px] w-[62px] place-items-center rounded-full text-[#ffffff] shadow" style={{ background: ph.color }}>
                    <Ico name={ph.icon} size={30} />
                  </span>
                </div>
                <div className="min-w-0 flex-1 rounded-2xl border-2 px-5 py-2.5" style={{ borderColor: ph.color, background: ph.soft }}>
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-[27px] font-extrabold leading-tight" style={{ color: ph.color }}>{ph.no}. {ph.title}</span>
                    <span className="rounded-full px-3 py-0.5 text-[15px] font-bold uppercase tracking-wide text-[#ffffff]" style={{ background: ph.color }}>{ph.when}</span>
                  </div>
                  <ul className="mt-1 list-disc space-y-1 pl-6 text-[19.5px] leading-snug">{ph.body}</ul>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-4 rounded-2xl border-2 border-[#f59e0b] bg-[#fffbeb] px-5 py-3">
            <div className="mb-1.5 text-[24px] font-extrabold text-[#92400e]">Info penting</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {infos.map((x) => (
                <div key={x.title} className="flex gap-3">
                  <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#fde68a] text-[#92400e]"><Ico name={x.icon} size={24} /></span>
                  <div className="min-w-0 text-[16.5px] leading-snug">
                    <div className="text-[17.5px] font-bold text-[#0f172a]">{x.title}</div>
                    <div className="text-[#334155]">{x.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </DocSheet>
    </div>
  );
}
