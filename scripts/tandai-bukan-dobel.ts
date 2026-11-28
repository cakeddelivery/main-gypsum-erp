/*
 * Tandai dua transaksi keuangan "BUKAN dobel" (permanen): audit-duplikat-keuangan tidak melaporkan pasangan ini lagi.
 * Tidak mengubah transaksi / jurnal apa pun.
 *   npm run tandai:bukan-dobel -- TRX-202611-0008 TRX-202611-0010 --alasan="Dikonfirmasi owner"           -> pratinjau
 *   npm run tandai:bukan-dobel -- TRX-202611-0008 TRX-202611-0010 --alasan="..." --jalankan               -> menyimpan
 */
import { PrismaClient } from "@prisma/client";
import { tandaiBukanDobel } from "../src/lib/bukanDobel";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const nums = args.filter((a) => !a.startsWith("--"));
const alasan = args.find((a) => a.startsWith("--alasan="))?.slice(9) ?? null;
const apply = args.includes("--jalankan");
tandaiBukanDobel(prisma, nums[0] ?? "", nums[1] ?? "", alasan, "skrip tandai:bukan-dobel", apply)
  .then((r) => {
    console.log(`${apply ? "DISIMPAN" : "PRATINJAU"}: ${r.a} & ${r.b} ${r.already ? "sudah ditandai bukan dobel" : "ditandai bukan dobel"}${alasan ? ` (${alasan})` : ""}`);
    if (!apply && !r.already) console.log("Tambahkan --jalankan untuk menyimpan.");
  })
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
