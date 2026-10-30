import type { Metadata, Viewport } from "next";
import "./globals.css";
import { THEME_SCRIPT } from "@/components/ThemeToggle";

const DESCRIPTION = "Sistem ERP terintegrasi Main Gypsum & Dunia Lukis — produksi, stok, absensi, penggajian, dan keuangan.";

export const metadata: Metadata = {
  // URL absolut untuk gambar pratinjau tautan (WhatsApp, Telegram, dll.)
  metadataBase: new URL(process.env.APP_URL || "https://erp.maingypsum.shop"),
  title: { default: "Main Gypsum ERP", template: "%s · Main Gypsum ERP" },
  description: DESCRIPTION,
  applicationName: "Main Gypsum ERP",
  openGraph: { type: "website", locale: "id_ID", siteName: "Main Gypsum ERP", title: "Main Gypsum ERP", description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: "Main Gypsum ERP", description: DESCRIPTION },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Cegah iPhone memperbesar (zoom) halaman saat kolom isian disentuh
  maximumScale: 1,
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
      </head>
      <body>{children}</body>
    </html>
  );
}
