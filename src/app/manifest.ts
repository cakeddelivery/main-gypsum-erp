import type { MetadataRoute } from "next";
import { PWA_BG, PWA_THEME, pwaInfo } from "@/lib/pwa";

// Dibaca saat diminta agar nama/ikon staging mengikuti APP_ENV di server
export const dynamic = "force-dynamic";

export default function manifest(): MetadataRoute.Manifest {
  const p = pwaInfo();
  const sc = (name: string, url: string, description: string) => ({ name, short_name: name, url, description, icons: [{ src: p.icon(96), sizes: "96x96", type: "image/png" }] });
  return {
    id: "/",
    name: p.name,
    short_name: p.shortName,
    description: "ERP Main Gypsum & Dunia Lukis — produksi, stok, absensi, gaji, dan keuangan.",
    lang: "id",
    dir: "ltr",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: PWA_BG,
    theme_color: PWA_THEME,
    categories: ["business", "finance", "productivity"],
    icons: [
      { src: p.icon(192), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: p.icon(512), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: p.maskable, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      sc("Transaksi", "/finance", "Daftar transaksi keuangan"),
      sc("Catat transaksi", "/finance?baru=1", "Buka form transaksi baru"),
      sc("Penjualan", "/penjualan", "Daftar penjualan"),
      sc("Stok", "/stok", "Stok barang"),
    ],
  };
}
