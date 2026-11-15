/**
 * Data uji TEKS PANJANG untuk audit tampilan HP (HANYA database lokal/staging, bukan produksi).
 *   npx tsx scripts/data-uji-teks-panjang.ts          → tambah data uji (kode diawali TES-PANJANG)
 *   npx tsx scripts/data-uji-teks-panjang.ts --hapus  → hapus lagi
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const TAG = "TES-PANJANG";
const LONG_PRODUCT = "Paket Giftbox Premium Edisi Spesial Keluarga Besar Isi 24 pcs Series Hewan Laut, Dinosaurus & Transportasi Darat";
const LONG_PERSON = "Muhammad Ridwan Saputra Wijayakusuma Nugroho Prasetyo";

async function main() {
  if (process.env.APP_ENV === "production") throw new Error("Menolak: jangan jalankan di produksi");
  if (process.argv.includes("--hapus")) {
    const items = await prisma.item.findMany({ where: { sku: { startsWith: TAG } }, select: { id: true } });
    await prisma.item.deleteMany({ where: { id: { in: items.map((i) => i.id) } } }).catch((e) => console.log("item dipakai data lain, dibiarkan:", e.message));
    await prisma.employee.deleteMany({ where: { code: { startsWith: TAG } } }).catch((e) => console.log("karyawan dipakai data lain, dibiarkan:", e.message));
    await prisma.supplier.deleteMany({ where: { code: { startsWith: TAG } } }).catch((e) => console.log("supplier dipakai data lain, dibiarkan:", e.message));
    console.log("Data uji teks panjang dihapus");
    return;
  }
  const divs = await prisma.division.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  for (const [i, d] of divs.entries()) {
    await prisma.item.upsert({
      where: { sku: `${TAG}-${i}` },
      create: { sku: `${TAG}-${i}`, name: `${LONG_PRODUCT} (${d.name})`, type: "BARANG_JADI", unit: "paket isi 24 pcs", divisionId: d.id },
      update: {},
    });
    await prisma.employee.upsert({
      where: { code: `${TAG}-${i}` },
      create: { code: `${TAG}-${i}`, name: `${LONG_PERSON} ${i + 1}`, divisionId: d.id, position: "Operator produksi bagian finishing & pengemasan", joinDate: new Date("2026-01-05") },
      update: {},
    });
  }
  await prisma.supplier.upsert({
    where: { code: `${TAG}-SUP` },
    create: { code: `${TAG}-SUP`, name: "CV Sumber Rejeki Makmur Sentosa Abadi Jaya Perkasa Indonesia", address: "Jl. Raya Tumenggungan Gang Beringin Indah No. 3 RT 004 RW 002, Kecamatan Lamongan, Kabupaten Lamongan, Jawa Timur 62214", note: "Pengiriman hanya hari Senin–Kamis sebelum pukul 14.00; konfirmasi stok lewat WhatsApp admin gudang terlebih dahulu" },
    update: {},
  });
  console.log(`Data uji teks panjang ditambahkan untuk ${divs.length} divisi`);
}

main().finally(() => prisma.$disconnect());
