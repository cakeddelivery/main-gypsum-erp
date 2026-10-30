/* Data awal Main Gypsum Unified ERP. Jalankan: npm run db:seed (aman diulang / idempoten untuk master). */
import { PrismaClient, type AccountType, type Role, type ProductionStage } from "@prisma/client";
import bcrypt from "bcryptjs";
import { applyDivisionSetup } from "../src/lib/divisionSetup";

const prisma = new PrismaClient();
const PASSWORD = process.env.SEED_PASSWORD || "Gypsum#2026";

const COA: [string, string, AccountType, boolean?][] = [
  ["1-1100", "Kas Tunai", "ASET", true],
  ["1-1201", "Bank Seabank", "ASET", true],
  ["1-1202", "ShopeePay", "ASET", true],
  ["1-1203", "Saldo Penjual Shopee", "ASET", true],
  ["1-1300", "Piutang Usaha", "ASET"],
  ["1-1310", "Piutang Karyawan (Kasbon)", "ASET"],
  ["1-1401", "Persediaan Bahan Baku", "ASET"],
  ["1-1402", "Persediaan Barang Dalam Proses", "ASET"],
  ["1-1403", "Persediaan Barang Jadi", "ASET"],
  ["1-1500", "Uang Muka & Biaya Dibayar di Muka", "ASET"],
  ["1-2100", "Aset Tetap - Peralatan & Mesin", "ASET"],
  ["1-2200", "Aset Tetap - Cetakan (Mold)", "ASET"],
  ["1-2900", "Akumulasi Penyusutan", "ASET"],
  ["2-1100", "Utang Usaha", "KEWAJIBAN"],
  ["2-1200", "Utang Gaji & Upah", "KEWAJIBAN"],
  ["2-1210", "Utang Kompensasi Pengelola (Owner)", "KEWAJIBAN"],
  ["2-1300", "Utang Lain-lain", "KEWAJIBAN"],
  ["2-1400", "Utang Pinjaman Modal", "KEWAJIBAN"],
  ["3-1000", "Modal Pemilik", "EKUITAS"],
  ["3-2000", "Laba Ditahan", "EKUITAS"],
  ["3-3000", "Prive Pemilik", "EKUITAS"],
  ["3-9000", "Ekuitas Saldo Awal", "EKUITAS"],
  ["4-1000", "Penjualan", "PENDAPATAN"],
  ["4-1100", "Penjualan Custom & Giftbox", "PENDAPATAN"],
  ["4-9000", "Pendapatan Lain-lain", "PENDAPATAN"],
  ["5-1000", "Harga Pokok Penjualan", "HPP"],
  ["6-1100", "Beban Gaji & Upah Produksi", "BEBAN"],
  ["6-1150", "Beban Kompensasi Pengelola (Owner)", "BEBAN"],
  ["6-1200", "Beban Transport", "BEBAN"],
  ["6-1300", "Beban Listrik, Air & Gas", "BEBAN"],
  ["6-1400", "Beban Packing & Operasional", "BEBAN"],
  ["6-1500", "Beban Admin & Layanan Platform", "BEBAN"],
  ["6-1600", "Beban Iklan & Promosi", "BEBAN"],
  ["6-1700", "Beban Penyusutan", "BEBAN"],
  ["6-1800", "Beban Reject & Selisih Persediaan", "BEBAN"],
  ["6-1900", "Beban Ongkos Kirim", "BEBAN"],
  ["6-9000", "Beban Lain-lain", "BEBAN"],
];

async function main() {
  const org = (await prisma.organization.findFirst()) ?? (await prisma.organization.create({ data: { name: "Main Gypsum Group" } }));
  const mg = await prisma.store.upsert({ where: { code: "MG" }, create: { code: "MG", name: "Main Gypsum", organizationId: org.id }, update: {} });
  await prisma.store.upsert({ where: { code: "DL" }, create: { code: "DL", name: "Dunia Lukis", organizationId: org.id }, update: {} });

  const acc: Record<string, string> = {};
  for (const [code, name, type, isCash] of COA) {
    const a = await prisma.coaAccount.upsert({ where: { code }, create: { code, name, type, isCash: !!isCash }, update: {} });
    acc[code] = a.id;
  }

  const banks: [string, string, string, string][] = [
    ["KAS", "Kas Tunai", "1-1100", "kas,tunai,cash"],
    ["SEABANK", "Seabank", "1-1201", "seabank,sea bank,bank"],
    ["SHOPEEPAY", "ShopeePay", "1-1202", "shopeepay,spay,shopee pay"],
    ["SALDO_SHOPEE", "Saldo Penjual Shopee", "1-1203", "saldo penjual,saldo shopee,penjual shopee"],
  ];
  const bank: Record<string, string> = {};
  for (const [code, name, coa, aliases] of banks) {
    bank[code] = (await prisma.bankAccount.upsert({ where: { code }, create: { code, name, coaAccountId: acc[coa], aliases }, update: {} })).id;
  }

  const cats: [string, "MASUK" | "KELUAR", string, string][] = [
    ["Penjualan Produk", "MASUK", "4-1000", "penjualan,jual,order,pencairan,cair,omzet"],
    ["Penjualan Custom/Giftbox", "MASUK", "4-1100", "custom,giftbox,souvenir,pesanan khusus"],
    ["Setoran Modal", "MASUK", "3-1000", "modal,setoran modal,suntik dana"],
    ["Pendapatan Lain", "MASUK", "4-9000", "bunga,cashback,lain"],
    ["Pembelian Bahan Baku", "KELUAR", "1-1401", "gypsum,tepung,cat,kuas,bahan,lem,plastik,dus,box,kardus"],
    ["Gaji & Upah", "KELUAR", "6-1100", "gaji,upah,borongan,lembur"],
    ["Transport", "KELUAR", "6-1200", "transport,bensin,bbm,parkir,ojek"],
    ["Listrik, Air & Gas", "KELUAR", "6-1300", "listrik,pln,air,pdam,gas,elpiji,token"],
    ["Packing & Operasional", "KELUAR", "6-1400", "packing,lakban,bubble,operasional,atk"],
    ["Admin & Layanan Platform", "KELUAR", "6-1500", "admin,biaya layanan,potongan"],
    ["Iklan & Promosi", "KELUAR", "6-1600", "iklan,ads,promosi,endorse"],
    ["Ongkos Kirim", "KELUAR", "6-1900", "ongkir,ongkos kirim,ekspedisi,jne,jnt,sicepat"],
    ["Pembelian Peralatan", "KELUAR", "1-2100", "mesin,peralatan,oven,kompresor,cetakan,mold"],
    ["Prive Pemilik", "KELUAR", "3-3000", "prive,ambil pribadi"],
    ["Beban Lain-lain", "KELUAR", "6-9000", "lain-lain,lainnya"],
  ];
  for (const [name, direction, coa, keywords] of cats) {
    const ex = await prisma.txCategory.findFirst({ where: { name } });
    if (!ex) await prisma.txCategory.create({ data: { name, direction, coaAccountId: acc[coa], keywords } });
  }

  const divisions: [string, string][] = [
    ["CTK", "Divisi Cetak"],
    ["OVN", "Divisi Oven & Sortir"],
    ["FIL", "Divisi Filling Cat"],
    ["ASM", "Divisi Assembling"],
    ["QCP", "Divisi QC & Packing"],
    ["GDG", "Gudang"],
  ];
  const div: Record<string, string> = {};
  for (const [code, name] of divisions) div[code] = (await prisma.division.upsert({ where: { code }, create: { code, name, shiftCount: code === "CTK" || code === "OVN" ? 2 : 1 }, update: {} })).id;

  const s1 = await prisma.shift.upsert({ where: { code: "S1" }, create: { code: "S1", name: "Shift 1", startTime: "07:00", endTime: "15:00", toleranceMinutes: 10 }, update: {} });
  await prisma.shift.upsert({ where: { code: "S2" }, create: { code: "S2", name: "Shift 2", startTime: "15:00", endTime: "23:00", toleranceMinutes: 10 }, update: {} });

  const locs: [string, string, string | null][] = [
    ["GBB", "Gudang Bahan Baku", div.GDG],
    ["WIP", "Area Produksi (WIP)", div.CTK],
    ["GBJ", "Gudang Barang Jadi", div.QCP],
  ];
  const loc: Record<string, string> = {};
  for (const [code, name, divisionId] of locs) loc[code] = (await prisma.location.upsert({ where: { code }, create: { code, name, divisionId }, update: {} })).id;

  const sup = (await prisma.supplier.findFirst({ where: { name: "CV Gypsum Jaya" } })) ?? (await prisma.supplier.create({ data: { name: "CV Gypsum Jaya", phone: "0812-0000-0001", address: "Surabaya" } }));
  const sup2 = (await prisma.supplier.findFirst({ where: { name: "Toko Cat Warna" } })) ?? (await prisma.supplier.create({ data: { name: "Toko Cat Warna", phone: "0812-0000-0002" } }));
  const gc = (await prisma.gypsumCharacter.findFirst({ where: { name: "Gypsum Super Putih" } })) ?? (await prisma.gypsumCharacter.create({ data: { name: "Gypsum Super Putih", waterRatio: "1 : 0,6", settingMinutes: 20, hardness: "Sedang", note: "Untuk karakter detail halus" } }));

  const items: [string, string, "BAHAN_BAKU" | "BARANG_DALAM_PROSES" | "BARANG_JADI", string, number, number, string | null][] = [
    ["BB-GYP", "Tepung Gypsum", "BAHAN_BAKU", "kg", 50, 4500, sup.id],
    ["BB-CAT", "Cat Akrilik (set)", "BAHAN_BAKU", "botol", 20, 12000, sup2.id],
    ["BB-KUAS", "Kuas Lukis", "BAHAN_BAKU", "pcs", 30, 1500, sup2.id],
    ["BB-PLS", "Plastik Kemasan", "BAHAN_BAKU", "pcs", 200, 150, null],
    ["BB-BOX", "Giftbox Karton", "BAHAN_BAKU", "pcs", 50, 3500, null],
    ["BJ-SAT-COWOK", "Figur Satuan Cowok (jadi)", "BARANG_JADI", "pcs", 20, 0, null],
    ["BJ-SAT-CEWEK", "Figur Satuan Cewek (jadi)", "BARANG_JADI", "pcs", 20, 0, null],
    ["BJ-SAT-HEWAN", "Figur Satuan Hewan (jadi)", "BARANG_JADI", "pcs", 20, 0, null],
    ["BJ-P12-MIX", "Paket 12 Mix (jadi)", "BARANG_JADI", "paket", 5, 0, null],
  ];
  const it: Record<string, string> = {};
  for (const [sku, name, type, unit, min, cost, supplierId] of items) {
    it[sku] = (await prisma.item.upsert({ where: { sku }, create: { sku, name, type, unit, minStock: min, avgCost: BigInt(cost), supplierId, gypsumCharacterId: sku === "BB-GYP" ? gc.id : null }, update: {} })).id;
  }

  const products: [string, string, "SATUAN" | "PAKET_12" | "PAKET_24" | "PAKET_48" | "GIFTBOX" | "CUSTOM", "COWOK" | "CEWEK" | "HEWAN" | "TRANSPORTASI" | "MIX", number, string, [string, number][]][] = [
    ["MG-SAT-COWOK", "Lukis Gypsum Satuan Cowok", "SATUAN", "COWOK", 1, "BJ-SAT-COWOK", [["BB-GYP", 0.08], ["BB-PLS", 1]]],
    ["MG-SAT-CEWEK", "Lukis Gypsum Satuan Cewek", "SATUAN", "CEWEK", 1, "BJ-SAT-CEWEK", [["BB-GYP", 0.08], ["BB-PLS", 1]]],
    ["MG-SAT-HEWAN", "Lukis Gypsum Satuan Hewan", "SATUAN", "HEWAN", 1, "BJ-SAT-HEWAN", [["BB-GYP", 0.1], ["BB-PLS", 1]]],
    ["MG-P12-MIX", "Paket 12 Lukis Gypsum Mix", "PAKET_12", "MIX", 12, "BJ-P12-MIX", [["BB-GYP", 0.96], ["BB-CAT", 1], ["BB-KUAS", 2], ["BB-PLS", 12]]],
  ];
  for (const [sku, name, type, variant, packQty, fin, bom] of products) {
    const ex = await prisma.product.findUnique({ where: { sku } });
    if (ex) continue;
    const p = await prisma.product.create({ data: { sku, name, type, variant, packQty, storeId: mg.id, finishedItemId: it[fin], laborCost: BigInt(packQty * 600), overheadCost: BigInt(packQty * 250) } });
    for (const [item, qty] of bom) await prisma.bomLine.create({ data: { productId: p.id, itemId: it[item], qty } });
    for (const [channel, price] of [["OFFLINE", packQty === 1 ? 5000 : 45000], ["SHOPEE", packQty === 1 ? 6500 : 52000]] as const) {
      await prisma.priceHistory.create({ data: { productId: p.id, channel, price: BigInt(price), hpp: BigInt(0), createdBy: "Seed" } });
    }
  }

  const rates: [ProductionStage, number][] = [["FILLING_CAT", 150], ["ASSEMBLING", 200], ["CETAK", 50]];
  for (const [stage, r] of rates) await prisma.pieceRate.upsert({ where: { stage }, create: { stage, ratePerPcs: BigInt(r) }, update: {} });

  const emps: [string, string, string, string, "HARIAN" | "BORONGAN" | "CAMPURAN", number][] = [
    ["K001", "Budi Santoso", "CTK", "Kapten Divisi Cetak", "HARIAN", 85000],
    ["K002", "Siti Aminah", "CTK", "Operator Cetak", "HARIAN", 75000],
    ["K003", "Rina Lestari", "FIL", "Operator Filling Cat", "BORONGAN", 0],
    ["K004", "Agus Prasetyo", "ASM", "Operator Assembling", "CAMPURAN", 50000],
    ["K005", "Dewi Kartika", "QCP", "Operator QC & Packing", "HARIAN", 75000],
  ];
  const emp: Record<string, string> = {};
  for (const [code, name, d, position, wageType, rate] of emps) {
    emp[code] = (await prisma.employee.upsert({ where: { code }, create: { code, name, divisionId: div[d], position, wageType, dailyRate: BigInt(rate), joinDate: new Date("2025-01-06") }, update: {} })).id;
  }

  const hash = await bcrypt.hash(PASSWORD, 10);
  const users: [string, string, Role, string | null, string | null][] = [
    ["owner", "Owner Main Gypsum", "OWNER", null, null],
    ["finance", "Staf Finance", "FINANCE", null, null],
    ["admin", "Admin Umum", "ADMIN", null, null],
    ["adminprod", "Admin Produksi", "ADMIN_PRODUKSI", null, null],
    ["adminmp", "Admin Marketplace", "ADMIN_MARKETPLACE", null, null],
    ["kapten", "Budi Santoso", "KAPTEN_DIVISI", emp.K001, div.CTK],
    ["content", "PIC Content Creator", "PIC_CONTENT", null, null],
    ["operator", "Siti Aminah", "OPERATOR", emp.K002, null],
  ];
  for (const [username, name, role, employeeId, divisionId] of users) {
    await prisma.user.upsert({ where: { username }, create: { username, name, role, passwordHash: hash, employeeId, divisionId }, update: {} });
  }

  const settings: Record<string, string> = {
    default_store_id: mg.id,
    loc_raw: loc.GBB,
    loc_wip: loc.WIP,
    loc_finished: loc.GBJ,
    late_deduction_per_minute: "0",
    payroll_require_validated: "true",
    payday_offset_days: "7",
    weekly_off_quota: "1",
    monthly_workdays: "26",
    auto_close_enabled: "true",
    daily_recap_time: "07:00",
    month_close_time: "09:00",
    report_recipients: "Owner, Admin Produksi",
    company_address: "",
  };
  for (const [key, value] of Object.entries(settings)) await prisma.setting.upsert({ where: { key }, create: { key, value }, update: {} });

  // Sisihan harian kompensasi owner (Rp100 rb/hari per owner = ±Rp3 jt/bulan), Seabank -> ShopeePay
  if (!(await prisma.reserveFund.count({ where: { kind: "OWNER" } }))) {
    for (const name of ["Kompensasi Pengelola - Cak Ed", "Kompensasi Pengelola - Jojo"]) {
      await prisma.reserveFund.create({ data: { name, kind: "OWNER", dailyAmount: BigInt(100000), fromBankId: bank.SEABANK, toBankId: bank.SHOPEEPAY, storeId: mg.id } });
    }
  }
  // Budget per pcs dibagi pekerja / koordinator / driver
  const tasks: [string, string, number, number, number][] = [["CAT_GIFTBOX", "Cat giftbox", 80, 20, 0], ["CAT_PLASTIK", "Cat plastik", 13, 2, 0], ["ASSEMBLING", "Assembling", 30, 15, 15]];
  for (const [code, name, w, c, d] of tasks) await prisma.pieceTask.upsert({ where: { code }, create: { code, name, ratePerPcs: BigInt(w + c + d), workerRate: BigInt(w), coordinatorRate: BigInt(c), driverRate: BigInt(d) }, update: {} });

  const targets: [string, ProductionStage, number][] = [["CTK", "CETAK", 600], ["FIL", "FILLING_CAT", 400], ["ASM", "ASSEMBLING", 300], ["QCP", "PACKING", 300]];
  for (const [d, stage, qty] of targets) {
    const ex = await prisma.productionTarget.findFirst({ where: { divisionId: div[d], stage, employeeId: null } });
    if (!ex) await prisma.productionTarget.create({ data: { divisionId: div[d], stage, dailyQty: qty } });
  }
  // Divisi laporan shift (Produksi, Giftbox, Packing, Assembling) + checklist & bahan baku per divisi
  await applyDivisionSetup(prisma);
  void s1;
  console.log(`Seed selesai. Login: owner / finance / admin / adminprod / adminmp / kapten / content / operator — password: ${process.env.SEED_PASSWORD ? "(SEED_PASSWORD)" : PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
