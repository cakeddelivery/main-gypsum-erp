/**
 * Tab halaman Borongan. Alur terbaru: Kiriman (KRM → bagi → lapor → AMB → diterima divisi), Stok, Klaim Upah (termasuk
 * Riwayat pembayaran & Batalkan pembayaran), Ringkasan. Tab "Bayar Upah" lama sudah dihapus (pembayaran lama dibatalkan/ditagih lewat Klaim Upah).
 * Tab alur lama Serah Terima & Penerimaan HANYA muncul di menu bila masih ada data lama yang hanya bisa dituntaskan di sana
 * (serah terima DIKIRIM / penerimaan divisi lama yang masih aktif), berlabel "(sisa data lama: N)".
 * Alamat ?tab= tetap bisa dibuka untuk melihat riwayat (selama perannya berhak), tanpa muncul di menu.
 */
export type TabKey = "kiriman" | "stok" | "klaim" | "ringkasan" | "serah" | "hasil" | "terima" | "orang" | "tugas";
export type Tab = { key: TabKey; label: string };

const TABS: Tab[] = [
  { key: "kiriman", label: "Kiriman" },
  { key: "stok", label: "Stok" },
  { key: "klaim", label: "Klaim Upah" },
  { key: "ringkasan", label: "Ringkasan" },
  { key: "serah", label: "Serah Terima" },
  { key: "hasil", label: "Setoran Hasil" },
  { key: "terima", label: "Penerimaan" },
  { key: "orang", label: "Orang" },
  { key: "tugas", label: "Tugas & Tarif" },
];
export const LEGACY_TABS: TabKey[] = ["serah", "terima"];

export type TabContext = {
  manage: boolean;
  canPay: boolean;
  setoranOnly: boolean;
  driver: boolean;
  coordinatorOnly: boolean;
  /** Tim Cetak/Oven (isi patung kering) atau Packing (terima setoran Assembling) */
  timKiriman: boolean;
  /** Data lama yang masih menggantung */
  legacy: { handover: number; receipts: number };
};

/** Tab yang boleh dibuka perannya (termasuk tab lama lewat ?tab=) */
export function accessibleTabs(c: TabContext): Tab[] {
  return TABS.filter((t) => c.manage || t.key !== "tugas")
    // Anggota divisi: kiriman (termasuk menerima setoran), klaim, ringkasan, setoran hasil
    .filter((t) => !c.setoranOnly || ["kiriman", "klaim", "ringkasan", "hasil"].includes(t.key))
    // Driver: hanya Pembagian & Ambil Setoran (tab Kiriman)
    .filter((t) => !c.driver || t.key === "kiriman")
    // Koordinator titik: lapor hasil (Kiriman), Klaim Upah, Stok titik, dan pekerja titiknya (Orang)
    .filter((t) => !c.coordinatorOnly || ["kiriman", "stok", "klaim", "orang"].includes(t.key))
    // Stok bahan titik: koordinator & pengelola
    .filter((t) => t.key !== "stok" || c.coordinatorOnly || c.manage)
    .filter((t) => !c.timKiriman || t.key === "kiriman");
}

/** Tab di menu: tab lama hanya bila ada sisa data lama (dengan jumlahnya di label) */
export function menuTabs(c: TabContext): (Tab & { count?: number })[] {
  const out: (Tab & { count?: number })[] = [];
  for (const t of accessibleTabs(c)) {
    if (!LEGACY_TABS.includes(t.key)) { out.push(t); continue; }
    const n = t.key === "serah" ? c.legacy.handover : c.legacy.receipts;
    if (n > 0) out.push({ ...t, label: `${t.label} (sisa data lama: ${n.toLocaleString("id-ID")})`, count: n });
  }
  return out;
}

/** Tab yang dibuka: ?tab= bila boleh (termasuk tab lama), selain itu Klaim Upah untuk Finance tanpa titik, bila tidak Kiriman */
export function pickTab(requested: string | undefined, c: TabContext, financeOnly: boolean): TabKey {
  const ok = accessibleTabs(c).some((t) => t.key === requested);
  if (ok) return requested as TabKey;
  return financeOnly ? "klaim" : "kiriman";
}
