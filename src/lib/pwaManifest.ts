import type { MetadataRoute } from "next";
import { PWA_BG, PWA_THEME, pwaInfo } from "./pwa";

/** Manifest PWA; Koordinator & Driver langsung membuka portal Borongan (tanpa menu ☰) */
export function buildManifest(role?: string | null): MetadataRoute.Manifest {
  const p = pwaInfo();
  const portal = role === "KOORDINATOR" || role === "DRIVER";
  const sc = (name: string, url: string, description: string) => ({ name, short_name: name, url, description, icons: [{ src: p.icon(96), sizes: "96x96", type: "image/png" }] });
  return {
    id: "/",
    name: p.name,
    short_name: p.shortName,
    description: "ERP Main Gypsum & Dunia Lukis — produksi, stok, absensi, gaji, dan keuangan.",
    lang: "id",
    dir: "ltr",
    start_url: portal ? "/borongan?tab=kiriman&source=pwa" : "/?source=pwa",
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
    shortcuts: portal
      ? [
          sc("Kiriman", "/borongan?tab=kiriman", "Kiriman berjalan"),
          ...(role === "KOORDINATOR" ? [sc("Stok titik", "/borongan?tab=stok", "Stok bahan di titik"), sc("Klaim upah", "/borongan?tab=klaim", "Klaim upah titik")] : []),
        ]
      : [
      sc("Transaksi", "/finance", "Daftar transaksi keuangan"),
      sc("Catat transaksi", "/finance?baru=1", "Buka form transaksi baru"),
      sc("Penjualan", "/penjualan", "Daftar penjualan"),
      sc("Stok", "/stok", "Stok barang"),
        ],
  };
}
