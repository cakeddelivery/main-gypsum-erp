import type { Metadata, Viewport } from "next";
import "./globals.css";
import { THEME_SCRIPT } from "@/components/ThemeToggle";
import { PwaRegister } from "@/components/Pwa";
import { AppUpdater } from "@/components/AppUpdater";
import { CURRENT_BUILD } from "@/lib/appVersion";
import { pwaInfo } from "@/lib/pwa";

const PWA = pwaInfo();

const DESCRIPTION = "Sistem ERP terintegrasi Main Gypsum & Dunia Lukis — produksi, stok, absensi, penggajian, dan keuangan.";

export const metadata: Metadata = {
  // URL absolut untuk gambar pratinjau tautan (WhatsApp, Telegram, dll.)
  metadataBase: new URL(process.env.APP_URL || "https://erp.maingypsum.shop"),
  title: { default: "Main Gypsum ERP", template: "%s · Main Gypsum ERP" },
  description: DESCRIPTION,
  applicationName: PWA.name,
  // Aplikasi terpasang (PWA): manifest dari src/app/manifest.ts, ikon di public/pwa/
  icons: { apple: [{ url: PWA.apple, sizes: "180x180", type: "image/png" }] },
  appleWebApp: { capable: true, title: PWA.shortName, statusBarStyle: "default" },
  formatDetection: { telephone: false },
  openGraph: { type: "website", locale: "id_ID", siteName: "Main Gypsum ERP", title: "Main Gypsum ERP", description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: "Main Gypsum ERP", description: DESCRIPTION },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Cegah iPhone memperbesar (zoom) halaman saat kolom isian disentuh
  maximumScale: 1,
  // Isi sampai ke tepi layar iPhone (poni/garis bawah); bottom nav memakai safe-area-inset-bottom
  viewportFit: "cover",
  // Android: saat keyboard muncul, tinggi layar ikut mengecil sehingga popup & kolom isian tidak tertutup keyboard
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#2559b8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1120" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" suppressHydrationWarning>
      <head>
        {/* Terapkan mode malam sebelum halaman tampil agar tidak berkedip */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <meta name="app-build" content={CURRENT_BUILD} />
      </head>
      <body>
        {children}
        <PwaRegister />
        <AppUpdater />
      </body>
    </html>
  );
}
