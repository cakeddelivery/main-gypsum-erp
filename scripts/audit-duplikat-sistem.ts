/*
 * Deteksi data ganda lapisan sistem (HANYA MEMBACA / SELECT; tidak mengubah apa pun).
 * Jalankan di VPS:  npx tsx scripts/audit-duplikat-sistem.ts
 *
 * Yang diperiksa:
 *  1. Pesan notifikasi terjadwal terkirim >1x untuk (jenis, target) yang sama pada hari WIB yang sama (job jalan 2x)
 *  2. Job gagal berulang di hari yang sama
 *  3. Satu karyawan punya >1 akun user aktif / nama pengguna mirip (akun ganda)
 *  4. Satu orang Telegram/chat tertaut ke >1 akun, atau satu akun >1 identitas aktif
 *  5. Langganan push: satu akun punya sangat banyak perangkat, user_agent identik (pendaftaran ganda)
 *  6. Baris audit LOGIN beruntun identik (login ganda <2 detik) sebagai indikasi klik ganda
 *  7. Penanda dedupe webhook (ReminderLog tg-update:*) bila ada
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const wib = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
let issues = 0;
const head = (t: string) => console.log(`\n== ${t}`);
const show = (rows: unknown[], label: string) => {
  if (!rows.length) return console.log("  OK: tidak ada");
  issues += rows.length;
  console.log(`  ${rows.length} ${label}; contoh:`);
  for (const r of rows.slice(0, 8)) console.log("   ", JSON.stringify(r));
};

async function main() {
  const since = new Date(Date.now() - 60 * 86400_000);

  head("1. Notifikasi terjadwal ganda (jenis+target sama, hari WIB sama, status TERKIRIM)");
  const logs = await prisma.notificationLog.findMany({ where: { at: { gte: since }, status: "TERKIRIM", type: { in: ["REKAP_HARIAN", "TALANGAN", "ANGGARAN", "WD_PROSES", "CEK_KONSISTENSI", "TUTUP_BUKU", "CEK_SALDO", "CEK_SALDO_INGAT"] } }, select: { id: true, at: true, type: true, target: true, payload: true }, orderBy: { at: "asc" } });
  // Satu job bisa mengirim ke beberapa penerima (target sama); jadi hitung per (jenis, hari, penerima-bila-ada): >1 baris identik dengan payload sama = curiga
  const g = new Map<string, typeof logs>();
  for (const l of logs) g.set(`${l.type}|${wib(l.at)}|${l.target ?? ""}|${(l.payload ?? "").slice(0, 120)}`, [...(g.get(`${l.type}|${wib(l.at)}|${l.target ?? ""}|${(l.payload ?? "").slice(0, 120)}`) ?? []), l]);
  show([...g.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ kunci: k.slice(0, 90), kali: v.length, ids: v.slice(0, 3).map((x) => x.id) })), "kelompok terkirim lebih dari sekali");

  head("2. Job gagal berulang di hari yang sama (>=3x)");
  const fails = await prisma.notificationLog.findMany({ where: { at: { gte: since }, status: "GAGAL", channel: "SISTEM" }, select: { id: true, at: true, type: true } });
  const fg = new Map<string, string[]>();
  for (const f of fails) fg.set(`${f.type}|${wib(f.at)}`, [...(fg.get(`${f.type}|${wib(f.at)}`) ?? []), f.id]);
  show([...fg.entries()].filter(([, v]) => v.length >= 3).map(([k, v]) => ({ kunci: k, kali: v.length, ids: v.slice(0, 3) })), "job gagal berulang");

  head("3. Akun user ganda");
  const users = await prisma.user.findMany({ where: { active: true }, select: { id: true, username: true, name: true, employeeId: true } });
  const byName = new Map<string, typeof users>();
  for (const u of users) byName.set(u.name.trim().toLowerCase(), [...(byName.get(u.name.trim().toLowerCase()) ?? []), u]);
  show([...byName.entries()].filter(([, v]) => v.length > 1).map(([n, v]) => ({ nama: n, akun: v.map((x) => `${x.username}(${x.id})`) })), "nama pengguna aktif kembar");

  head("4. Identitas Telegram ganda");
  const ids = await prisma.telegramIdentity.findMany({ where: { active: true }, select: { id: true, userId: true, chatId: true, telegramUserId: true } });
  const byUser = new Map<string, typeof ids>();
  const byChat = new Map<string, typeof ids>();
  for (const i of ids) {
    byUser.set(i.userId, [...(byUser.get(i.userId) ?? []), i]);
    if (i.chatId) byChat.set(i.chatId, [...(byChat.get(i.chatId) ?? []), i]);
  }
  show([...byUser.entries()].filter(([, v]) => v.length > 1).map(([u, v]) => ({ userId: u, identitas: v.map((x) => x.id) })), "akun dengan >1 identitas Telegram aktif (pesan terjadwal terkirim ke tiap identitas)");
  show([...byChat.entries()].filter(([, v]) => v.length > 1).map(([c, v]) => ({ chatId: c, identitas: v.map((x) => x.id), userIds: v.map((x) => x.userId) })), "chat yang tertaut ke >1 identitas (penerima ganda)");

  head("5. Langganan push mencurigakan");
  const subs = await prisma.pushSubscription.findMany({ select: { id: true, userId: true, userAgent: true } });
  const sg = new Map<string, string[]>();
  for (const s of subs) sg.set(`${s.userId}|${s.userAgent ?? ""}`, [...(sg.get(`${s.userId}|${s.userAgent ?? ""}`) ?? []), s.id]);
  show([...sg.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ userId_agent: k.slice(0, 80), kali: v.length, ids: v.slice(0, 3) })), "akun+browser sama dengan >1 langganan (notifikasi bisa muncul dobel di perangkat itu)");

  head("6. Login beruntun identik <2 detik (klik ganda)");
  const lg = await prisma.auditLog.findMany({ where: { action: "LOGIN", at: { gte: since } }, select: { id: true, actorId: true, at: true }, orderBy: { at: "asc" } });
  const dup: unknown[] = [];
  for (let i = 1; i < lg.length; i++) if (lg[i].actorId === lg[i - 1].actorId && lg[i].at.getTime() - lg[i - 1].at.getTime() < 2000) dup.push({ actorId: lg[i].actorId, id: String(lg[i].id) });
  show(dup, "login ganda");

  head("Ringkasan");
  console.log(issues ? `  ${issues} temuan — tinjau contoh di atas (skrip ini tidak mengubah data).` : "  Tidak ada data ganda terdeteksi.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
