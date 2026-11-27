/*
 * DIAGNOSA selisih stok harian (HANYA MEMBACA, tidak mengubah apa pun):
 *   npm run diagnosa:selisih-harian -- --tanggal=2026-11-27
 * Per divisi × barang pada tanggal itu: stok awal hari (saldo sebelum 00.00 WIB) + saldo awal reset (SALDO-AWAL-…), mutasi hari itu per jenis
 * (ref: KRM kiriman, BGI pembagian, AMB ambil, HSB hasil titik, PND penerimaan divisi, RJP reject saat diterima divisi, LPH hasil laporan shift, LPS opname laporan, PRD produksi,
 * JUAL penjualan, dst.), lalu stok akhir hitungan laporan shift 1 & 2 vs stok sistem pada jam selesai shift. Bila ada selisih, baris mutasi
 * penyebabnya ditampilkan (waktu, jenis, ref, jumlah, catatan).
 * Baris LPS = penyesuaian otomatis stok akhir laporan (selisih sesudah LPS selalu 0), maka dianggap "SELISIH TIDAK TERJELASKAN":
 * ringkasan di atas per divisi, urut nilai terbesar (qty & Rp), dan ditandai ⚠ di baris mutasinya. Memakai stockGapReport (sama dengan cek:selisih-stok / menu Stok › Selisih).
 */
import { prisma } from "../src/lib/db";
import { kindLabel, stockGapReport } from "../src/lib/stockGap";
import { locationSettings } from "../src/lib/stock";

const tanggal = process.argv.find((a) => a.startsWith("--tanggal="))?.slice(10) ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) throw new Error("--tanggal harus YYYY-MM-DD");
const f = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 3 });
const kindOf = (ref: string | null) => (ref ?? "").replace(/^BATAL-/, "").split(/[:-]/)[0] || "-";
const wib = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().replace("T", " ").slice(0, 16);

async function main() {
  const start = new Date(`${tanggal}T00:00:00+07:00`);
  const end = new Date(start.getTime() + 86_400_000);
  const days = Math.max(1, Math.ceil((Date.now() - start.getTime()) / 86_400_000) + 1);
  const gap = await stockGapReport(days);
  const rows = gap.rows.filter((r) => r.date === tanggal);
  const locs = await locationSettings(prisma);
  const locIds = [locs.wip, locs.finished].filter(Boolean) as string[];
  console.log(`DIAGNOSA SELISIH HARIAN (read-only) · ${tanggal} · laporan_shift_ke_stok=${gap.settingOn ? "menyala" : "MATI"} · ${gap.reportsChecked} laporan terkirim di periode\n`);
  if (!rows.length) console.log("Belum ada laporan terkirim bertanggal itu (atau tanpa hitungan stok akhir hasil).");

  const items = await prisma.item.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.itemId))] } }, select: { id: true, name: true, unit: true } });
  const byDivision = new Map<string, typeof rows>();
  for (const r of rows) byDivision.set(r.division, [...(byDivision.get(r.division) ?? []), r]);

  // Selisih tidak terjelaskan = penyesuaian otomatis LPS (stok akhir laporan) per divisi × barang
  const lpsMoves = rows.length ? await prisma.stockMovement.findMany({ where: { itemId: { in: items.map((i) => i.id) }, date: { gte: start, lt: end }, ref: { startsWith: "LPS" }, OR: [{ toLocationId: { in: locIds } }, { fromLocationId: { in: locIds } }] } }) : [];
  const sgn = (m: { toLocationId: string | null; fromLocationId: string | null; qty: unknown }) => (m.toLocationId && locIds.includes(m.toLocationId) ? Number(m.qty) : 0) - (m.fromLocationId && locIds.includes(m.fromLocationId) ? Number(m.qty) : 0);
  const unexplained: { division: string; name: string; unit: string; qty: number; rp: number }[] = [];
  for (const [division, list] of byDivision) {
    for (const itemId of new Set(list.map((r) => r.itemId))) {
      const ms = lpsMoves.filter((m) => m.itemId === itemId);
      if (!ms.length) continue;
      const qty = ms.reduce((a, m) => a + sgn(m), 0);
      const rp = ms.reduce((a, m) => a + sgn(m) * Number(m.unitCost), 0);
      const it = items.find((i) => i.id === itemId);
      if (qty !== 0 || rp !== 0) unexplained.push({ division, name: it?.name ?? itemId, unit: it?.unit ?? "", qty, rp });
    }
  }
  const rp = (n: number) => `${n < 0 ? "-" : n > 0 ? "+" : ""}Rp ${Math.abs(Math.round(n)).toLocaleString("id-ID")}`;
  const unexplainedKey = new Set(unexplained.map((u) => `${u.division}|${u.name}`));
  if (unexplained.length) {
    console.log("⚠ SELISIH TIDAK TERJELASKAN (penyesuaian otomatis stok akhir laporan / LPS), per divisi, terbesar dulu:");
    const byDiv = new Map<string, typeof unexplained>();
    for (const u of unexplained) byDiv.set(u.division, [...(byDiv.get(u.division) ?? []), u]);
    const sum = (l: typeof unexplained) => l.reduce((a, u) => a + Math.abs(u.rp), 0);
    for (const [d, l] of [...byDiv].sort((a, b) => sum(b[1]) - sum(a[1]))) {
      console.log(`  ${d}: ${l.length} barang · total |Rp| ${rp(sum(l)).replace(/^\+/, "")}`);
      for (const u of l.sort((a, b) => Math.abs(b.rp) - Math.abs(a.rp) || Math.abs(b.qty) - Math.abs(a.qty))) console.log(`     ${u.name}: ${u.qty > 0 ? "+" : ""}${f(u.qty)} ${u.unit} · ${rp(u.rp)}`);
    }
    console.log("");
  } else if (rows.length) console.log("Tidak ada selisih tidak terjelaskan (tidak ada penyesuaian LPS hari itu).\n");
  for (const [division, list] of [...byDivision].sort((a, b) => a[0].localeCompare(b[0], "id"))) {
    console.log(`== ${division} ==`);
    for (const itemId of [...new Set(list.map((r) => r.itemId))]) {
      const it = items.find((i) => i.id === itemId);
      const open = await prisma.$queryRaw<{ qty: number }[]>`
        SELECT COALESCE(SUM(CASE WHEN "toLocationId" = ANY(${locIds}) THEN qty ELSE 0 END) - SUM(CASE WHEN "fromLocationId" = ANY(${locIds}) THEN qty ELSE 0 END), 0)::float8 AS qty
        FROM "StockMovement" WHERE "itemId" = ${itemId} AND date < ${start}`;
      const moves = await prisma.stockMovement.findMany({ where: { itemId, date: { gte: start, lt: end }, OR: [{ toLocationId: { in: locIds } }, { fromLocationId: { in: locIds } }] }, orderBy: { date: "asc" } });
      const saldoAwal = moves.filter((m) => (m.ref ?? "").startsWith("SALDO-AWAL"));
      const signed = (m: (typeof moves)[number]) => (m.toLocationId && locIds.includes(m.toLocationId) ? Number(m.qty) : 0) - (m.fromLocationId && locIds.includes(m.fromLocationId) ? Number(m.qty) : 0);
      const kinds = new Map<string, { n: number; net: number }>();
      for (const m of moves) {
        const k = (m.ref ?? "").startsWith("SALDO-AWAL") ? "SALDO-AWAL" : kindOf(m.ref);
        const cur = kinds.get(k) ?? { n: 0, net: 0 };
        kinds.set(k, { n: cur.n + 1, net: cur.net + signed(m) });
      }
      console.log(`  ${it?.name ?? itemId} (${it?.unit ?? ""})${unexplainedKey.has(`${division}|${it?.name ?? itemId}`) ? "  ⚠ ada SELISIH TIDAK TERJELASKAN (LPS)" : ""}`);
      console.log(`     stok awal hari (sebelum 00.00 WIB): ${f(open[0]?.qty ?? 0)}${saldoAwal.length ? ` · saldo awal reset: ${f(saldoAwal.reduce((a, m) => a + signed(m), 0))} (${saldoAwal.length} mutasi, ${wib(saldoAwal[0].date)})` : ""}`);
      for (const [k, v] of [...kinds].sort()) console.log(`     mutasi ${k === "SALDO-AWAL" ? "Saldo awal reset" : kindLabel(k)}: ${v.n}× · bersih ${v.net > 0 ? "+" : ""}${f(v.net)}`);
      for (const r of list.filter((x) => x.itemId === itemId)) {
        console.log(`     ${r.shift}: hitungan laporan ${f(r.counted)} | stok sistem ${f(r.system)} | selisih ${r.diff > 0 ? "+" : ""}${f(r.diff)}${r.big ? "  ‼ BESAR" : ""}`);
      }
      if (list.some((x) => x.itemId === itemId && x.diff !== 0)) {
        console.log("     → baris mutasi hari itu (penyebab selisih):");
        for (const m of moves) console.log(`        ${kindOf(m.ref) === "LPS" ? "⚠ SELISIH TIDAK TERJELASKAN · " : ""}${wib(m.date)} · ${m.type} · ${m.ref ?? "(tanpa ref)"} · ${signed(m) > 0 ? "+" : ""}${f(signed(m))}${m.note ? ` · ${m.note.slice(0, 80)}` : ""}`);
      }
    }
    console.log("");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
