/* Siapkan divisi laporan shift + ganti bahan baku lama dengan bahan baku per divisi. Jalankan sekali setelah update: npm run setup:divisi */
import { PrismaClient } from "@prisma/client";
import { applyDivisionSetup } from "../src/lib/divisionSetup";

const prisma = new PrismaClient();
applyDivisionSetup(prisma, { replaceOld: true })
  .then((r) => {
    console.log(`Divisi baru: ${r.divisionsCreated} · bahan baku baru: ${r.materialsCreated}`);
    if (r.replaced) console.log(`Bahan baku lama: ${r.deleted} dihapus, ${r.archived} dinonaktifkan (punya riwayat transaksi)`);
    else console.log("Bahan baku lama sudah pernah diganti sebelumnya, tidak diubah lagi");
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
