import type { Role } from "@prisma/client";
import type { ReportTemplate } from "./shiftReport";

/**
 * Lembar Panduan: satu sumber isi untuk halaman /panduan (HP), lembar A4 (JPG/PDF), dan file di docs/panduan.
 * Teks memakai penanda sederhana: «Tombol» = nama tombol/menu persis seperti di aplikasi, **tebal** = penekanan.
 */
export type DivisionGuideId = "cetak" | "produksi" | "giftbox" | "packing" | "assembling";
export type RoleGuideId = "supervisor" | "finance" | "owner";
export type GuideId = DivisionGuideId | RoleGuideId;

export type GuideIcon = "login" | "pin" | "work" | "report" | "home" | "key" | "mail" | "user" | "lock" | "help" | "eye" | "stock" | "truck" | "money" | "wallet" | "check" | "cog" | "tag" | "book" | "alert";

export type Phase = { icon: GuideIcon; when: string; title: string; color: string; soft: string; items: string[]; flow?: string[]; shot?: string };
export type Info = { icon: GuideIcon; title: string; text: string };
export type Guide = {
  id: GuideId;
  kind: "divisi" | "role";
  /** Nama pendek untuk tab, mis. "Giftbox" / "Supervisor" */
  name: string;
  /** Judul lembar */
  title: string;
  audience: string;
  subtitle: string;
  phases: Phase[];
  /** Tugas mingguan/bulanan ringkas (panduan role) */
  periodic?: string[];
  infos: Info[];
};

const C = {
  blue: ["#1d4ed8", "#eff6ff"],
  green: ["#047857", "#ecfdf5"],
  amber: ["#b45309", "#fffbeb"],
  violet: ["#7c3aed", "#f5f3ff"],
  red: ["#be123c", "#fff1f2"],
  teal: ["#0f766e", "#f0fdfa"],
} as const;
const ph = (c: keyof typeof C, p: Omit<Phase, "color" | "soft">): Phase => ({ ...p, color: C[c][0], soft: C[c][1] });

// ---------------- Panduan divisi ----------------

type DivSpec = { id: DivisionGuideId; name: string; template: ReportTemplate; hasil: string[]; terima: boolean; catatan?: string };

const DIVISIONS: DivSpec[] = [
  { id: "cetak", name: "Cetak", template: "CETAK", hasil: ["Hasil cetak per karyawan: pilih nama, isi jumlah per series (Hewan, Cowok, Transportasi, Cewek)."], terima: false },
  { id: "produksi", name: "Produksi (Oven)", template: "PRODUKSI", hasil: ["Hasil panen per oven (Oven Besar, Oven Kecil) per series.", "Reject panen + pilih alasan reject (bila ada).", "Hasil cetak per karyawan (bila ikut mencetak)."], terima: false },
  { id: "giftbox", name: "Giftbox", template: "GIFTBOX", hasil: ["Resi: jumlah Shopee & Tiktok.", "Giftbox: jumlah box per jenis (Reguler, Bonus Palet, dll.).", "Jumlah patung dihitung otomatis."], terima: true },
  { id: "packing", name: "Packing", template: "PACKING", hasil: ["Resi: jumlah Shopee & Tiktok.", "Patung mix (paket): jumlah paket per isi & series.", "Patung satuan: jumlah per series."], terima: false },
  { id: "assembling", name: "Assembling", template: "ASSEMBLING", hasil: [], terima: true, catatan: "Assembling tidak mengisi hasil kerja di form: hasil borongan dicatat lewat «+ Penerimaan borongan» dan tampil otomatis di laporan." },
];

/** Tahap form laporan divisi (urutan sama dengan form di aplikasi) */
export function reportSteps(hasWork: boolean): string[] {
  return [...(hasWork ? ["Hasil kerja"] : []), "Checklist", "Stok jadi", "Stok akhir", "Catatan & kirim"];
}

const MEMBER_INFOS: Info[] = [
  { icon: "key", title: "Lupa password", text: "Di halaman masuk tekan «Lupa password?» → ketik username/email → «Kirim link reset» → buka link di Gmail." },
  { icon: "mail", title: "Akun: password, Gmail, foto", text: "«Profil» → «Ganti password» / «Isi email» / «Unggah foto». Gmail untuk reset password & «Masuk dengan Google»." },
  { icon: "check", title: "Izin & Sakit", text: "«Absen» → «Izin & Sakit» → «+ Ajukan izin / sakit». Sakit > 1 hari wajib foto surat dokter." },
  { icon: "user", title: "PIC otomatis", text: "Nama PIC laporan diambil dari akun yang mengirim. Selalu pakai akun sendiri." },
  { icon: "lock", title: "Jaga akun", text: "Jangan bagikan password. Di HP orang lain, tekan «Keluar» setelah selesai." },
  { icon: "help", title: "Bila ada error", text: "Tutup lalu buka lagi aplikasinya. Muncul \"Versi baru tersedia\"? Isian aman, tekan «Muat ulang». Masih error? Foto layarnya, hubungi Kapten divisi atau Admin (WA {wa})." },
];

const LOGIN = ph("blue", {
  icon: "login", when: "Datang", title: "Masuk ke ERP", shot: "login",
  items: ["Buka ERP di HP, ketik username & password, tekan «Masuk» (atau «Masuk dengan Google»). Tetap masuk sampai 90 hari.", "Muncul \"Lengkapi akun Anda\"? Isi Gmail & foto profil."],
});
const ABSEN = ph("green", {
  icon: "pin", when: "Mulai shift", title: "Absen masuk", shot: "absen",
  items: ["Menu bawah «Absen» → tab «Hari ini» → tekan tombol hijau «Absen Masuk».", "Izinkan lokasi (GPS) & berada di lokasi kerja (titik hijau). Lewat 10 menit dari jam shift = telat."],
});
const PULANG = ph("red", { icon: "home", when: "Pulang", title: "Absen pulang", items: ["Menu bawah «Absen» → «Absen Pulang» (di lokasi kerja)."] });

function divisionGuide(d: DivSpec): Guide {
  return {
    id: d.id, kind: "divisi", name: d.name, title: `Lembar Panduan Divisi ${d.name}`, audience: `Anggota Divisi ${d.name}`,
    subtitle: "Langkah harian dari absen masuk sampai absen pulang",
    phases: [
      LOGIN,
      ABSEN,
      ph("amber", {
        icon: "work", when: "Saat bekerja", title: "Catat yang datang", shot: "barang",
        items: [
          "Ada kiriman dari supplier/toko: menu bawah «Laporan» → «+ Barang masuk». Catat **sebelum** menghitung stok akhir.",
          ...(d.terima ? ["Hasil borongan datang: buka laporan hari ini → «+ Penerimaan borongan», isi total per barang."] : []),
          "Stok bahan di bawah limit? Permintaan stok dibuat **otomatis** dari laporan, tidak perlu lapor manual.",
        ],
      }),
      ph("violet", {
        icon: "report", when: "Akhir shift", title: "Kirim laporan shift", shot: "lapor", flow: reportSteps(d.hasil.length > 0),
        items: [
          "Tekan tombol bulat «+» **Lapor** di tengah bawah. Laporan hari ini & shift sesuai jam HP terbuka sendiri.",
          ...(d.hasil.length ? [`**Hasil kerja:** ${d.hasil.join(" ")}`] : []),
          ...(d.catatan ? [d.catatan] : []),
          "**Checklist:** centang semua; yang bertanda \"Wajib foto bukti\" harus difoto. **Stok jadi / Stok akhir:** hitung fisik (bila ada).",
          "Tekan «Berikutnya ›» sampai akhir → «Kirim laporan» → «Ya, kirim». Gambar laporan: «🖼️ Lihat & unduh JPG».",
        ],
      }),
      PULANG,
    ],
    infos: MEMBER_INFOS,
  };
}

// ---------------- Panduan role ----------------

const STAFF_INFOS: Info[] = [
  { icon: "key", title: "Password & Gmail", text: "«Profil» → «Ganti password» / «Isi email». Gmail dipakai untuk «Lupa password?» dan «Masuk dengan Google»." },
  { icon: "lock", title: "Jaga akun", text: "Jangan bagikan password; izin Anda lebih luas dari anggota. HP hilang? Minta Owner tekan «Keluarkan semua perangkat»." },
  { icon: "help", title: "Bila ada error", text: "Tutup lalu buka lagi aplikasinya / tekan «Muat ulang». Masih error? Foto layarnya, kirim ke Owner/Admin (WA {wa})." },
  { icon: "book", title: "Panduan divisi", text: "Menu «Panduan» berisi lembar panduan; cetak dan tempel di area kerja bila perlu." },
];

const SUPERVISOR: Guide = {
  id: "supervisor", kind: "role", name: "Supervisor", title: "Lembar Panduan Supervisor", audience: "Supervisor produksi",
  subtitle: "Memantau semua divisi, stok bahan, dan borongan setiap hari",
  phases: [
    ph("green", { icon: "pin", when: "Mulai kerja", title: "Absen & cek peringatan", items: ["«Absensi» → «Absen Masuk» (GPS di lokasi kerja).", "Ikon lonceng (kanan atas): baca peringatan; laporan berlabel **Kendala** dibuka → «Tindak lanjuti»."] }),
    ph("blue", { icon: "eye", when: "Sepanjang hari", title: "Pantau laporan shift", items: ["«Laporan Shift»: laporan dikelompokkan per tanggal (terbaru di atas), 1 laporan per divisi per shift. Tekan «Lihat».", "Angka harian: «Rekap» dan «Resi & patung». Draf yang belum dikirim ditandai **Draf**: ingatkan divisinya."] }),
    ph("teal", { icon: "check", when: "Harian", title: "Validasi absensi", items: ["«Absensi» → tab «Validasi» → centang absen yang benar → «Validasi yang dipilih».", "Tab «Izin & Sakit»: «Setujui» / «Tolak» (tulis alasan). Hari yang disetujui otomatis tercatat Izin/Sakit (menggantikan Alpa)."] }),
    ph("amber", { icon: "stock", when: "Harian", title: "Stok & bahan baku", items: ["«Stok & Persediaan» → «Permintaan»: «Setujui» / «Tolak», lalu «Penuhi». Kirim daftar ke grup: «Kirim ke WhatsApp».", "«Laporan Shift» → «Order bahan baku»: item online pakai «🛒 Order online» (Link Produk).", "Barang pembelian datang: «Stok & Persediaan» → «Pembelian» → «Terima barang»."] }),
    ph("violet", { icon: "truck", when: "Saat ada kiriman", title: "Borongan", items: ["«Borongan» → «+ Kirim Bahan» → «Serahkan Ke Driver».", "Cek tab «Penerimaan & Selisih»: selisih minus = setoran koordinator belum/kurang diterima divisi. Selesaikan sebelum upah dibayar."] }),
    ph("red", { icon: "stock", when: "Paket retur datang", title: "Retur & video unboxing", items: ["«Retur & Komplain» → «+ Retur baru» → «📷 Foto label resi» → cek isian & produk → «Simpan & rekam video».", "Rekam tanpa jeda: tunjukkan label, buka paket → «■ Selesai rekam». Lalu «Periksa barang» (baik / rusak + foto) → «Ajukan klaim» bila ada yang rusak → «Tandai selesai».", "Komplain pembeli: «💬 Komplain & refund» → «+ Komplain» → Refund (isi rekening pembeli) atau Kirim ganti. Bukti bayar refund dikirim bot ke Anda."] }),
  ],
  periodic: ["Mingguan: cek «Rekap» per divisi dan laporan berlabel Kendala yang belum selesai.", "Pastikan setiap divisi punya bahan & limit yang benar di «Bahan & checklist divisi» (minta Owner bila perlu diubah)."],
  infos: STAFF_INFOS,
};

const FINANCE: Guide = {
  id: "finance", kind: "role", name: "Finance", title: "Lembar Panduan Finance", audience: "Finance",
  subtitle: "Transaksi, saldo, gaji, dan hutang setiap hari",
  phases: [
    ph("blue", { icon: "wallet", when: "Pagi 05.00", title: "Cek saldo", items: ["Bot Telegram mengirim saldo rekening. Cocokkan dengan aplikasi bank; riwayat di «Transaksi» → «Cek saldo harian»."] }),
    ph("green", { icon: "check", when: "Harian", title: "Transaksi", items: ["«Transaksi»: draf dari bot/AI dibuka, periksa nominal, rekening & kategori → «✓ Setujui & bukukan».", "Salah/dobel: «Tolak». Sudah dibukukan tapi salah: «Batalkan transaksi» (jurnal dibalik otomatis).", "Refund komplain (lonceng): «Setujui refund» → «Bayar refund» + bukti transfer (tercatat otomatis, bukti dikirim bot ke Supervisor)."] }),
    ph("amber", { icon: "money", when: "Harian", title: "Withdraw & dana sisihan", items: ["Withdraw marketplace berstatus **Dalam Proses**; saat uang masuk rekening tekan «Uang diterima».", "«Dana sisihan» → «Sisihkan» / «Sisihkan semua» (OPS, Nabung, SPinjam). «Dana talangan» → «Kembalikan» bila sudah diganti."] }),
    ph("violet", { icon: "stock", when: "Saat belanja", title: "Pembelian & hutang", items: ["«Stok & Persediaan» → «Pembelian» → «+ Pembelian» → «Simpan pembelian».", "Hutang per supplier: «Supplier» → klik nama. Ringkasan: «Akuntansi» → «Piutang & hutang»."] }),
    ph("red", { icon: "wallet", when: "Jadwal gaji", title: "Penggajian & upah", items: ["«Penggajian» → «+ Periode harian» → «Buka» → periksa → «Setujui» → «Bayar gaji». Kasbon: «Kasbon» → «+ Kasbon» / «Lunasi».", "Tunjangan (tgl 15) di «Tunjangan»; BPJS mengikuti data karyawan. Upah borongan: «Borongan» → «Bayar Upah» (setelah selisih beres)."] }),
  ],
  periodic: ["Klaim retur cair: «Retur & Komplain» → buka retur → «Klaim cair» (pemasukan otomatis tercatat di «Transaksi»).", "Bulanan: «Akuntansi» → «Biaya marketplace» → «+ Catat biaya».", "Bulanan: «Akuntansi» → «Cek konsistensi», selesaikan temuan sebelum Owner menutup buku."],
  infos: STAFF_INFOS,
};

const OWNER: Guide = {
  id: "owner", kind: "role", name: "Owner", title: "Lembar Panduan Owner", audience: "Owner",
  subtitle: "Ringkasan harian, akses, pengaturan, dan keputusan",
  phases: [
    ph("blue", { icon: "eye", when: "Pagi", title: "Ringkasan harian", items: ["«Beranda»: ringkasan hari ini. Telegram: cek saldo 05.00, Cek Konsistensi 06.00 (hanya bila ada masalah), rekap 07.00."] }),
    ph("red", { icon: "alert", when: "Bila ada temuan", title: "Keputusan", items: ["«Akuntansi» → «Cek konsistensi»: putuskan temuan **Kritis** lebih dulu.", "Selisih borongan: «Borongan» → tab «Penerimaan & Selisih».", "Izin & sakit karyawan menunggu: «Absensi» → tab «Izin & Sakit» → «Setujui» / «Tolak».", "Komplain & refund: «Retur & Komplain» → «💬 Komplain & refund» (refund cukup disetujui & dibayar Finance; Owner bisa ikut memantau)."] }),
    ph("green", { icon: "user", when: "Saat perlu", title: "Karyawan & akses", items: ["«Karyawan» → «Pendaftaran» → «+ Tautan undangan», lalu «Setujui» / «Tolak». Berhenti kerja: «Karyawan» → «Resign».", "«Pengaturan» → «Pengguna & hak akses»: izin per role (izin sensitif ditandai). HP hilang: «Keluarkan semua perangkat»."] }),
    ph("amber", { icon: "cog", when: "Saat perlu", title: "Pengaturan divisi", items: ["«Laporan Shift» → «Bahan & checklist divisi»: format laporan, bahan & limit, «Ubah checklist» (wajib foto), target.", "Sakelar «Hasil kerja → stok» menentukan hasil laporan masuk stok."] }),
    ph("violet", { icon: "tag", when: "Saat perlu", title: "Produk & harga", items: ["«Produk & HPP»: «Ubah harga», resep, dan «Overhead» per bulan."] }),
  ],
  periodic: ["Bulanan: «Akuntansi» → «Tutup buku» setelah Cek konsistensi bersih; lihat «Laba rugi».", "Bulanan: «Analitik» untuk tren penjualan & biaya.", "Bulanan: «Retur & Komplain» → «📊 Analitik»: kota, produk, kurir & alasan dengan kerugian terbesar (Unduh untuk Excel)."],
  infos: STAFF_INFOS,
};

export const GUIDES: Record<GuideId, Guide> = {
  ...(Object.fromEntries(DIVISIONS.map((d) => [d.id, divisionGuide(d)])) as Record<DivisionGuideId, Guide>),
  supervisor: SUPERVISOR,
  finance: FINANCE,
  owner: OWNER,
};

export const GUIDE_ORDER: GuideId[] = ["cetak", "produksi", "giftbox", "packing", "assembling", "supervisor", "finance", "owner"];
export const GUIDE_LIST: Guide[] = GUIDE_ORDER.map((id) => GUIDES[id]);
const DIVISION_IDS = DIVISIONS.map((d) => d.id);

export function isGuideId(v: unknown): v is GuideId {
  return typeof v === "string" && v in GUIDES;
}

/** Panduan divisi yang cocok untuk format laporan divisi (null bila divisi tanpa format laporan) */
export function guideForTemplate(template: string | null | undefined): DivisionGuideId | null {
  return DIVISIONS.find((d) => d.template === template)?.id ?? null;
}

/**
 * Panduan yang boleh dibuka pengguna (ditegakkan di server):
 * Owner semua; Supervisor/Admin produksi panduan Supervisor + semua divisi; Finance panduan Finance;
 * Admin panduan Supervisor, Finance + divisi; anggota/kapten hanya panduan divisinya.
 */
export function allowedGuides(role: Role, divisionTemplate: string | null | undefined): GuideId[] {
  const own = guideForTemplate(divisionTemplate);
  switch (role) {
    case "OWNER":
      return [...GUIDE_ORDER];
    case "SUPERVISOR":
    case "ADMIN_PRODUKSI":
      return ["supervisor", ...DIVISION_IDS];
    case "FINANCE":
      return ["finance"];
    case "ADMIN":
      return ["supervisor", "finance", ...DIVISION_IDS];
    default:
      return own ? [own] : [];
  }
}

/** Ganti {wa} dengan nomor WA kop surat */
export function fillWa(text: string, wa: string) {
  return text.replace(/\{wa\}/g, wa);
}

/** Pecah teks bertanda menjadi potongan: tombol «…», tebal **…**, atau teks biasa */
export function richParts(text: string): { t: "btn" | "b" | "txt"; v: string }[] {
  const out: { t: "btn" | "b" | "txt"; v: string }[] = [];
  const re = /«([^»]+)»|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ t: "txt", v: text.slice(last, m.index) });
    out.push(m[1] != null ? { t: "btn", v: m[1] } : { t: "b", v: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: "txt", v: text.slice(last) });
  return out;
}
