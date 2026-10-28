/* Scheduler proses terpisah (alternatif cron eksternal): cek job setiap menit. Jalankan: npm run scheduler */
import { runDueJobs } from "../src/lib/jobs";

async function tick() {
  try {
    const r = await runDueJobs();
    if (Object.keys(r).length) console.log(new Date().toISOString(), "job dijalankan:", JSON.stringify(r));
  } catch (e) {
    console.error(new Date().toISOString(), "job gagal:", e);
  }
}

console.log("Scheduler Main Gypsum aktif (rekap 07.00 WIB, tutup buku tgl 1 09.00 WIB)");
tick();
setInterval(tick, 60_000);
