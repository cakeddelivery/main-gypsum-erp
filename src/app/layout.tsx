import type { Metadata, Viewport } from "next";
import "./globals.css";
import { THEME_SCRIPT } from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: { default: "Main Gypsum ERP", template: "%s · Main Gypsum ERP" },
  description: "Sistem ERP terintegrasi Main Gypsum & Dunia Lukis",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
