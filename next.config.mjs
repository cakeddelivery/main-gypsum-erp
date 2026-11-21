import { execSync } from "node:child_process";

/**
 * Versi build: commit + waktu build. Ditanam ke kode (APP_BUILD_ID) dan dipakai sebagai build id Next,
 * sehingga aplikasi di HP bisa membandingkan versinya dengan /api/version lalu memuat ulang otomatis.
 */
const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "nogit";
  }
})();
// next build memuat file ini di beberapa proses (build worker server & klien). Nilai disimpan ke process.env
// sekali di proses utama agar semua worker mewarisi versi yang SAMA; tanpa ini versi klien ≠ server
// dan aplikasi selalu mengira ada versi baru.
process.env.APP_BUILD_ID ||= `${commit}-${Date.now().toString(36)}`;
const BUILD_ID = process.env.APP_BUILD_ID;

// Build ringan (VPS 3,6 GB RAM): BUILD_RINGAN=1 melewati typecheck di dalam next build — typecheck & lint sudah
// dijalankan sebelum merge (npm run -s typecheck). Build biasa (npm run build) tetap memeriksa tipe.
const ringan = process.env.BUILD_RINGAN === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Folder hasil build; update produksi membangun ke folder sementara lalu menukarnya ke .next (situs tidak mati saat build)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typescript: { ignoreBuildErrors: ringan },
  eslint: { ignoreDuringBuilds: ringan },
  generateBuildId: async () => BUILD_ID,
  env: { APP_BUILD_ID: BUILD_ID },
  serverExternalPackages: ["@prisma/client", "bcryptjs", "tesseract.js"],
  experimental: {
    serverActions: { bodySizeLimit: "16mb" },
    // Hemat memori saat build (hanya memengaruhi proses build, bukan perilaku aplikasi):
    // satu proses pembuat halaman, tanpa worker thread, dan optimasi memori webpack
    cpus: 1,
    workerThreads: false,
    webpackMemoryOptimizations: true,
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
      // Manifest & versi selalu dicek ulang (tidak boleh disimpan browser/CDN)
      { source: "/manifest.webmanifest", headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }] },
      { source: "/api/version", headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }] },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          // Lokasi dipakai absen GPS, kamera untuk foto bukti, kamera + mikrofon untuk video unboxing retur; selain itu dimatikan
          { key: "Permissions-Policy", value: "geolocation=(self), camera=(self), microphone=(self), payment=(), usb=()" },
        ],
      },
    ];
  },
};
export default nextConfig;
