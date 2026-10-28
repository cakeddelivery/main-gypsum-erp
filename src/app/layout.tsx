import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Main Gypsum ERP", template: "%s · Main Gypsum ERP" },
  description: "Sistem ERP terintegrasi Main Gypsum & Dunia Lukis",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#2559b8" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
