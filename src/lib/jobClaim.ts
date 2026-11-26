import { prisma } from "./db";

/**
 * Klaim job untuk tanggal ini secara ATOMIK (satu pernyataan SQL): hanya satu pemanggil yang mendapat true.
 * Dua proses (scheduler PM2 + cron eksternal, dua instance, restart tumpang tindih) yang memanggil bersamaan
 * tidak lagi sama-sama lolos cek lalu menjalankan job dua kali (pesan Telegram/push dobel, slip gaji dobel).
 */
export async function claimJob(key: string, date: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${key}, ${date}, NOW())
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = NOW()
    WHERE "Setting"."value" <> EXCLUDED."value"
    RETURNING "key"`;
  return rows.length > 0;
}
