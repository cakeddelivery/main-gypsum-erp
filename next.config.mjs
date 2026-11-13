/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client", "bcryptjs", "tesseract.js"],
  experimental: {
    serverActions: { bodySizeLimit: "16mb" },
    // Halaman yang baru dibuka disimpan 30 detik di HP: kembali/berpindah ke menu yang sama terasa instan.
    // Setiap simpan/ubah data (server action + revalidatePath) langsung membuang simpanan ini, dan AutoRefresh
    // menyegarkan halaman daftar penting secara berkala, jadi data tidak basi.
    staleTimes: { dynamic: 30 },
  },
  async headers() {
    return [
      // Service worker selalu dicek ulang agar versi baru langsung terpakai setelah deploy
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          // Lokasi dipakai absen GPS, kamera untuk foto bukti; selain itu dimatikan
          { key: "Permissions-Policy", value: "geolocation=(self), camera=(self), microphone=(), payment=(), usb=()" },
        ],
      },
    ];
  },
};
export default nextConfig;
