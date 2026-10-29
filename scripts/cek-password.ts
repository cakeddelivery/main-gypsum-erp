/* Cek akun aktif yang masih memakai password bawaan seed (Gypsum#2026 / SEED_PASSWORD). Jalankan: npm run cek:password */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const candidates = ["Gypsum#2026", process.env.SEED_PASSWORD].filter((p): p is string => !!p);

async function main() {
  const users = await prisma.user.findMany({ where: { active: true }, orderBy: { username: "asc" } });
  const weak: string[] = [];
  for (const u of users) {
    for (const p of candidates) if (await bcrypt.compare(p, u.passwordHash)) { weak.push(`${u.username} (${u.role})`); break; }
  }
  if (weak.length) {
    console.log(`⚠️  ${weak.length} akun aktif masih memakai password bawaan:\n - ${weak.join("\n - ")}`);
    console.log("Ganti passwordnya di Pengaturan → Pengguna, atau nonaktifkan akun uji yang tidak dipakai.");
    process.exitCode = 1;
  } else console.log(`✓ ${users.length} akun aktif dicek, tidak ada yang memakai password bawaan.`);
}

main().finally(() => prisma.$disconnect());
