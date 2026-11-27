import type { Prisma, PrismaClient } from "@prisma/client";
import { autoCode } from "./codes";
import { defaultTaskTemplate } from "./taskDivision";
import { VARIANTS } from "./shiftReport";
import { flowItem } from "./shiftReportFlow";

type Tx = Prisma.TransactionClient;
type DB = Tx | PrismaClient;

/** Setting: tugas & paket bahan per titik borongan. { [pointId]: { tasks: taskId[], kit: itemId[] } } */
export const POINT_CONFIG_KEY = "borongan_titik";
export type PointConfig = Record<string, { tasks: string[]; kit: string[] }>;

export async function pointConfig(db: DB): Promise<PointConfig> {
  const s = await db.setting.findUnique({ where: { key: POINT_CONFIG_KEY } });
  if (!s) return {};
  try {
    const v = JSON.parse(s.value);
    return v && typeof v === "object" ? (v as PointConfig) : {};
  } catch {
    return {};
  }
}

const COLORS = ["merah", "biru", "kuning"] as const;
/** Jalankan berurutan (kode otomatis tidak boleh dibuat bersamaan di satu transaksi) */
async function seq<T, R>(xs: readonly T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const x of xs) out.push(await fn(x));
  return out;
}

/**
 * Siapkan borongan sesuai alur lapangan (aman diulang; jalankan pratinjau dulu):
 * - Titik ke-3 BERINGIN (Cat Plastik), lokasi stok BRN
 * - Tugas dipecah: Assembling per karakter (4) & Cat Plastik per warna (3); tarif sama dengan tugas lama, tugas lama dinonaktifkan
 * - Barang baru: Pot cat giftbox (divisi Giftbox), Cat plastik merah/biru/kuning (divisi Assembling)
 * - Tugas & paket bahan per titik: BMR = Assembling + Cat Giftbox; Mastrip = Assembling; Beringin = Cat Plastik
 * Takaran bahan per pcs yang belum pasti (kondimen, cat per pot/klip) TIDAK diisi: Owner mengisinya di Borongan → Tugas & Tarif.
 */
export async function setupBorongan(db: PrismaClient, apply: boolean): Promise<string[]> {
  const log: string[] = [];
  const run = async (tx: Tx) => {
    const say = (s: string) => log.push(s);
    // ---- Titik Beringin ----
    let brn = await tx.boronganPoint.findFirst({ where: { OR: [{ code: "BRN" }, { name: { equals: "Beringin", mode: "insensitive" } }] } });
    if (!brn) {
      say("+ Titik borongan BERINGIN (lokasi stok BRN)");
      const loc = (await tx.location.findUnique({ where: { code: "BRN" } })) ?? (await tx.location.create({ data: { code: "BRN", name: "Titik Borongan Beringin" } }));
      brn = await tx.boronganPoint.create({ data: { code: "BRN", name: "Beringin", locationId: loc.id, viaDriver: false } });
    } else say("= Titik Beringin sudah ada");
    const bmr = await tx.boronganPoint.findFirst({ where: { code: "BMR" } });
    const mst = await tx.boronganPoint.findFirst({ where: { code: "MST" } });

    // ---- Barang ----
    const div = async (t: string) => tx.division.findFirst({ where: { reportTemplate: t } });
    const asm = await div("ASSEMBLING");
    const gft = await div("GIFTBOX");
    const findItem = (name: string) => tx.item.findFirst({ where: { name: { equals: name, mode: "insensitive" }, active: true }, orderBy: { sku: "asc" } });
    const ensureMaterial = async (name: string, unit: string, d: { id: string; code: string } | null) => {
      const ex = await findItem(name);
      if (ex) return ex.id;
      if (!d) throw new Error(`Divisi untuk ${name} belum ada (jalankan npm run setup:divisi dulu)`);
      say(`+ Barang baru: ${name} (${unit})`);
      return (await tx.item.create({ data: { sku: await autoCode.divisionMaterial(tx, d.code), name, unit, type: "BAHAN_BAKU", divisionId: d.id } })).id;
    };
    // Hasil Cat Plastik per warna = barang SETENGAH JADI (ikut hitungan stok akhir hasil & limit "perlu diproduksi"), bukan bahan baku
    const ensureHasil = async (name: string, unit: string, d: { id: string; code: string } | null) => {
      const ex = await findItem(name);
      if (ex) return ex.id;
      if (!d) throw new Error(`Divisi untuk ${name} belum ada (jalankan npm run setup:divisi dulu)`);
      say(`+ Barang baru: ${name} (${unit}, setengah jadi)`);
      const sku = `SJ-${name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      return (await tx.item.create({ data: { sku, name, unit, type: "BARANG_DALAM_PROSES", divisionId: d.id } })).id;
    };
    // Pot cat giftbox hanya stok titik koordinator (BMR): tanpa divisi, tidak ikut stok akhir / daftar order divisi mana pun
    const pot = (await findItem("Pot cat giftbox"))?.id ?? (say("+ Barang baru: Pot cat giftbox (pcs, tanpa divisi)"), (await tx.item.create({ data: { sku: await autoCode.divisionMaterial(tx, gft?.code ?? "GIB"), name: "Pot cat giftbox", unit: "pcs", type: "BAHAN_BAKU" } })).id);
    const catPlastik = Object.fromEntries(await seq(COLORS, async (c) => [c, await ensureHasil(`Cat plastik ${c}`, "pcs", asm)] as const));
    const kering = Object.fromEntries(await seq(VARIANTS, async (v) => [v, await flowItem(tx, { kind: "kering", key: v })] as const));
    const jadi = Object.fromEntries(await seq(VARIANTS, async (v) => [v, await flowItem(tx, { kind: "jadi", key: v })] as const));
    const catGiftbox = (gft && (await tx.item.findFirst({ where: { divisionId: gft.id, name: { equals: "Cat Giftbox", mode: "insensitive" } } }))) || null;

    // ---- Tugas ----
    const tasks = await tx.pieceTask.findMany({ include: { inputs: true } });
    const rateOf = (re: RegExp, def: [number, number, number]): [number, number, number] => {
      const t = tasks.find((x) => re.test(x.name) && x.active) ?? tasks.find((x) => re.test(x.name));
      return t ? [Number(t.workerRate), Number(t.coordinatorRate), Number(t.driverRate)] : def;
    };
    const ensureTask = async (name: string, rate: [number, number, number], outputItemId: string | null, inputs: { itemId: string; qty: number }[]) => {
      const ex = tasks.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (ex) {
        const data: Prisma.PieceTaskUpdateInput = {};
        if (!ex.active) data.active = true;
        if (outputItemId && ex.outputItemId !== outputItemId) data.outputItem = { connect: { id: outputItemId } };
        if (Object.keys(data).length) { say(`~ Tugas ${name}: ${data.active ? "diaktifkan" : ""}${data.outputItem ? " hasil diperbarui" : ""}`); await tx.pieceTask.update({ where: { id: ex.id }, data }); }
        if (!ex.inputs.length && inputs.length) { say(`~ Tugas ${name}: bahan per pcs ${inputs.length} baris`); await tx.pieceTaskInput.createMany({ data: inputs.map((l) => ({ taskId: ex.id, itemId: l.itemId, qty: l.qty })) }); }
        return ex.id;
      }
      say(`+ Tugas ${name} (Rp${rate[0]}/${rate[1]}/${rate[2]} per pcs)`);
      const tpl = defaultTaskTemplate(name);
      const divisionId = tpl ? (await tx.division.findFirst({ where: { reportTemplate: tpl } }))?.id ?? null : null;
      const t = await tx.pieceTask.create({ data: { code: await autoCode.pieceTask(tx), name, divisionId, ratePerPcs: BigInt(rate[0] + rate[1] + rate[2]), workerRate: BigInt(rate[0]), coordinatorRate: BigInt(rate[1]), driverRate: BigInt(rate[2]), outputItemId, inputs: { create: inputs.map((l) => ({ itemId: l.itemId, qty: l.qty })) } } });
      return t.id;
    };
    const asmRate = rateOf(/^assembling$/i, [30, 15, 15]);
    const cpRate = rateOf(/^cat plastik$/i, [13, 2, 0]);
    const asmTasks = await seq(VARIANTS, (v) => ensureTask(`Assembling ${v}`, asmRate, jadi[v], [{ itemId: kering[v], qty: 1 }]));
    const cpTasks = await seq(COLORS, (c) => ensureTask(`Cat plastik ${c}`, cpRate, catPlastik[c], []));
    const cg = tasks.find((x) => /cat giftbox/i.test(x.name) && x.active) ?? tasks.find((x) => /cat giftbox/i.test(x.name));
    const cgTask = cg ? await ensureTask(cg.name, [0, 0, 0], catGiftbox?.id ?? null, [{ itemId: pot, qty: 1 }]) : await ensureTask("Cat giftbox", [80, 20, 0], catGiftbox?.id ?? null, [{ itemId: pot, qty: 1 }]);
    for (const old of tasks.filter((x) => x.active && /^(assembling|cat plastik)$/i.test(x.name))) {
      say(`- Tugas lama "${old.name}" dinonaktifkan (riwayat setoran tetap)`);
      await tx.pieceTask.update({ where: { id: old.id }, data: { active: false } });
    }

    // ---- Paket bahan per titik ----
    const named = async (names: string[]) => {
      const ids: string[] = [];
      for (const n of names) {
        const it = await findItem(n);
        if (it) ids.push(it.id);
        else say(`! Barang "${n}" tidak ditemukan, tidak masuk paket (tambahkan di Master data bila perlu)`);
      }
      return ids;
    };
    const kondimen = await named(["Plastik OPP", "Cotton bud", "Piring plastik", "Isi staples", ...VARIANTS.map((v) => `Background ${v.toLowerCase()}`), ...VARIANTS.map((v) => `Klip ${v.toLowerCase()}`)]);
    const assemblyKit = [...VARIANTS.map((v) => kering[v]), ...COLORS.map((c) => catPlastik[c]), ...kondimen];
    const cat5 = await named(["Cat merah", "Cat biru", "Cat kuning", "Cat putih", "Cat hitam"]);
    const cat3 = await named(["Cat merah", "Cat biru", "Cat kuning", "Plastik klip 2x3"]);
    const cfg: PointConfig = await pointConfig(tx);
    if (bmr) cfg[bmr.id] = { tasks: [...asmTasks, cgTask], kit: [...assemblyKit, pot, ...cat5] };
    if (mst) cfg[mst.id] = { tasks: asmTasks, kit: assemblyKit };
    cfg[brn.id] = { tasks: cpTasks, kit: cat3 };
    say(`= Paket titik: BMR ${bmr ? `${cfg[bmr.id].tasks.length} tugas, ${cfg[bmr.id].kit.length} bahan` : "(titik tidak ada)"} · Mastrip ${mst ? `${cfg[mst.id].tasks.length} tugas, ${cfg[mst.id].kit.length} bahan` : "(titik tidak ada)"} · Beringin ${cfg[brn.id].tasks.length} tugas, ${cfg[brn.id].kit.length} bahan`);
    await tx.setting.upsert({ where: { key: POINT_CONFIG_KEY }, create: { key: POINT_CONFIG_KEY, value: JSON.stringify(cfg) }, update: { value: JSON.stringify(cfg) } });
    if (!(await tx.boronganPerson.findFirst({ where: { pointId: brn.id, role: "KOORDINATOR", active: true } }))) say("= Beringin tanpa koordinator: bagian koordinator Cat Plastik dibayarkan ke pekerja");
  };
  if (apply) await db.$transaction(run, { timeout: 60000 });
  else {
    // Pratinjau: jalankan di transaksi lalu dibatalkan, jadi tidak ada yang tersimpan
    await db.$transaction(async (tx) => { await run(tx); throw new Rollback(); }, { timeout: 60000 }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
  }
  return log;
}

class Rollback extends Error {}



// ---------------- KIT BAHAN PER TUGAS ----------------

/**
 * Setting: bahan pendukung yang ikut dikirim per TUGAS (bukan per titik), mis. Assembling = kondimen; Cat Giftbox =
 * cat 5 warna; Cat Plastik = cat merah/biru/kuning + plastik klip. { [taskId]: itemId[] }. Diatur di Tugas & Tarif.
 * Bahan resep tugas (per pcs) selalu ikut otomatis, jadi tidak perlu dimasukkan ke kit.
 */
export const TASK_KIT_KEY = "borongan_kit_tugas";
export type TaskKits = Record<string, string[]>;

export async function taskKits(db: DB): Promise<TaskKits> {
  const s = await db.setting.findUnique({ where: { key: TASK_KIT_KEY } });
  if (!s) return {};
  try {
    const v = JSON.parse(s.value);
    return v && typeof v === "object" ? (v as TaskKits) : {};
  } catch {
    return {};
  }
}

export async function saveTaskKit(db: DB, taskId: string, itemIds: string[]) {
  const all = await taskKits(db);
  all[taskId] = [...new Set(itemIds.filter(Boolean))];
  await db.setting.upsert({ where: { key: TASK_KIT_KEY }, create: { key: TASK_KIT_KEY, value: JSON.stringify(all) }, update: { value: JSON.stringify(all) } });
}

/**
 * Isi awal kit per tugas (aman diulang; pratinjau dulu, lalu `-- --jalankan`):
 *  - Assembling (semua jenis): plastik OPP, cotton bud, piring plastik, isi staples, background & klip per varian,
 *    dan klip cat plastik merah/biru/kuning (hasil Beringin, bagian kit Single Pack);
 *  - Cat Giftbox: cat merah/biru/kuning/putih/hitam (pot cat giftbox sudah bahan resep);
 *  - Cat Plastik (semua warna): cat merah/biru/kuning + plastik klip 2x3.
 * Tugas yang kit-nya sudah diatur tidak ditimpa. Barang yang tidak ditemukan dilaporkan, tidak dibuat.
 */
export async function setupTaskKits(db: PrismaClient, apply: boolean): Promise<string[]> {
  const log: string[] = [];
  const [tasks, cur] = await Promise.all([db.pieceTask.findMany({ where: { active: true }, orderBy: { name: "asc" } }), taskKits(db)]);
  const find = async (names: string[]) => {
    const ids: string[] = [];
    for (const n of names) {
      const it = await db.item.findFirst({ where: { name: { equals: n, mode: "insensitive" }, active: true }, orderBy: { sku: "asc" } });
      if (it) ids.push(it.id);
      else log.push(`! Barang "${n}" tidak ditemukan (tambahkan di Master data bila perlu)`);
    }
    return ids;
  };
  const assembling = await find(["Plastik OPP", "Cotton bud", "Piring plastik", "Isi staples", ...VARIANTS.map((v) => `Background ${v.toLowerCase()}`), ...VARIANTS.map((v) => `Klip ${v.toLowerCase()}`), ...COLORS.map((c) => `Cat plastik ${c}`)]);
  const catGiftbox = await find(["Cat merah", "Cat biru", "Cat kuning", "Cat putih", "Cat hitam"]);
  const catPlastik = await find(["Cat merah", "Cat biru", "Cat kuning", "Plastik klip 2x3"]);
  const next: TaskKits = { ...cur };
  for (const t of tasks) {
    const kit = /^assembling\b/i.test(t.name) ? assembling : /cat giftbox/i.test(t.name) ? catGiftbox : /^cat plastik/i.test(t.name) ? catPlastik : null;
    if (!kit) continue;
    if (cur[t.id]?.length) {
      log.push(`= ${t.name}: kit sudah diatur (${cur[t.id].length} bahan), tidak ditimpa`);
      continue;
    }
    next[t.id] = kit;
    log.push(`+ ${t.name}: ${kit.length} bahan pendukung`);
  }
  if (apply) await db.setting.upsert({ where: { key: TASK_KIT_KEY }, create: { key: TASK_KIT_KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  return [...new Set(log)];
}
