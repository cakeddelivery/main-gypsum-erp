import { Prisma, type BoronganRole, type HandoverKind, type ItemType } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { COA, assertPeriodOpen, postJournal, reverseJournal } from "./accounting";
import { nextNumber } from "./numbering";
import { INVENTORY_COA, StockError, locationSettings, qtyAt, recordMovement, reverseMovementsByRef } from "./stock";
import { bomStockQty } from "./unitcost";
import { pointConfig } from "./boronganSetup";

type Tx = Prisma.TransactionClient;
type DB = Tx | typeof prisma;
type Actor = { id: string; name: string };

/** Turunan StockError agar pesannya tampil apa adanya di form */
export class BoronganError extends StockError {}

export const BORONGAN_ROLE_LABEL: Record<BoronganRole, string> = { PEKERJA: "Pekerja", KOORDINATOR: "Koordinator", DRIVER: "Driver" };
export const HANDOVER_LABEL: Record<HandoverKind, string> = { KIRIM: "Kirim Bahan Ke Titik", KEMBALI: "Kirim Hasil Ke Gudang" };

export type Split = { workerRate: number; coordinatorRate: number; driverRate: number };

/** Budget per pcs harus habis dibagi ke pekerja, koordinator, dan driver */
export function checkSplit(total: number, s: Split) {
  if (total <= 0) throw new BoronganError("Budget per pcs harus lebih dari 0");
  if ([s.workerRate, s.coordinatorRate, s.driverRate].some((x) => x < 0)) throw new BoronganError("Bagian upah tidak boleh minus");
  const sum = s.workerRate + s.coordinatorRate + s.driverRate;
  if (sum !== total) throw new BoronganError(`Pembagian pekerja + koordinator + driver (Rp${sum}) harus sama dengan budget Rp${total}/pcs`);
}

/** Upah satu setoran per penerima */
export function resultShares(qty: number, s: Split) {
  return { worker: qty * s.workerRate, coordinator: qty * s.coordinatorRate, driver: qty * s.driverRate, total: qty * (s.workerRate + s.coordinatorRate + s.driverRate) };
}

// ---------------- AKSES ----------------

/**
 * all = pengelola borongan (semua titik, semua aksi).
 * warehouse = Kapten Assembling: semua titik, boleh kirim bahan & terima hasil ke gudang (tanpa tarif/upah/akun).
 * division = anggota divisi pencatat setoran (Kapten/Operator): hanya mencatat & membatalkan setoran TUGAS divisinya
 *   (taskIds), di titik yang mengerjakan tugas itu. Tidak mengatur tarif, pekerja, kirim bahan, atau bayar upah.
 *   captain = kapten boleh membatalkan semua setoran divisinya; anggota lain hanya setoran yang ia catat sendiri.
 * taskIds = null berarti semua tugas (pengelola, koordinator titik).
 */
export type Scope = {
  all: boolean;
  pointIds: string[];
  personId: string | null;
  warehouse?: boolean;
  taskIds?: string[] | null;
  division?: { id: string; captain: boolean } | null;
};
type ScopeUser = { id: string; can: (p: "borongan.manage") => boolean; role?: string; divisionId?: string | null };

/** Kapten divisi Assembling ikut mengurus borongan (Assembling & Cat Plastik: bahan dikirim & setoran masuk) */
export async function isBoronganDivisionCaptain(db: DB, user: { role?: string; divisionId?: string | null }) {
  if (user.role !== "KAPTEN_DIVISI" || !user.divisionId) return false;
  const d = await db.division.findUnique({ where: { id: user.divisionId }, select: { reportTemplate: true } });
  return d?.reportTemplate === "ASSEMBLING";
}

/** Anggota divisi (Kapten/Operator) yang divisinya punya tugas borongan aktif boleh mencatat setoran tugas itu */
export function isDivisionMemberRole(role?: string) {
  return role === "KAPTEN_DIVISI" || role === "OPERATOR";
}

export { assignDefaultTaskDivisions, defaultTaskTemplate } from "./taskDivision";

/** Pengelola melihat semua titik; Kapten Assembling & anggota divisi: titik yang mengerjakan tugas divisinya; koordinator hanya titiknya */
export async function boronganScope(db: DB, user: ScopeUser): Promise<Scope> {
  if (user.can("borongan.manage")) return { all: true, pointIds: [], personId: null, taskIds: null };
  const coord = await db.boronganPerson.findFirst({ where: { userId: user.id, role: "KOORDINATOR", active: true } });
  if (coord) return { all: false, pointIds: coord.pointId ? [coord.pointId] : [], personId: coord.id, taskIds: null };
  if (isDivisionMemberRole(user.role) && user.divisionId) {
    const tasks = await db.pieceTask.findMany({ where: { divisionId: user.divisionId, active: true }, select: { id: true } });
    const captain = user.role === "KAPTEN_DIVISI";
    const warehouse = await isBoronganDivisionCaptain(db, user);
    if (tasks.length || warehouse) {
      const taskIds = tasks.map((t) => t.id);
      const points = await db.boronganPoint.findMany({ where: { active: true }, select: { id: true } });
      // Titik yang mengerjakan tugas divisi (menurut pengaturan tugas per titik); tanpa pengaturan = semua titik aktif
      const cfg = await pointConfig(db);
      const pointIds = points.map((p) => p.id).filter((id) => warehouse || !cfg[id]?.tasks.length || cfg[id].tasks.some((t) => taskIds.includes(t)));
      return { all: false, pointIds, personId: null, warehouse, taskIds, division: { id: user.divisionId, captain } };
    }
  }
  return { all: false, pointIds: [], personId: null, taskIds: null };
}

/** Tugas boleh dicatat oleh scope ini */
export function canTask(scope: Scope, taskId: string) {
  return scope.all || scope.taskIds == null || scope.taskIds.includes(taskId);
}

/** Anggota divisi (bukan pengelola/Kapten Assembling): hanya setoran, tidak boleh serah terima, pekerja, tarif, upah */
export function isSetoranOnly(scope: Scope) {
  return !scope.all && !!scope.division && !scope.warehouse;
}

/** Boleh mengirim bahan dari gudang / menerima hasil ke gudang */
export function canWarehouse(scope: Scope) {
  return scope.all || !!scope.warehouse;
}

/** Kiriman hasil (KEMBALI) yang menunggu diterima dan memuat barang divisi ini (mis. pot cat giftbox untuk divisi Giftbox) */
export async function divisionPendingReturns(divisionId: string) {
  const d = await prisma.division.findUnique({ where: { id: divisionId }, select: { reportTemplate: true } });
  const list = await prisma.boronganHandover.findMany({ where: { status: "DIKIRIM", kind: "KEMBALI" }, include: { lines: { include: { item: true } }, point: true, driver: true }, orderBy: { date: "asc" } });
  return list.filter((h) => h.lines.some((l) => l.item.divisionId === divisionId || (d?.reportTemplate === "ASSEMBLING" && l.item.type !== "BAHAN_BAKU")));
}

export function canPoint(scope: Scope, pointId: string) {
  return scope.all || scope.pointIds.includes(pointId);
}

export function assertPoint(scope: Scope, pointId: string) {
  if (!canPoint(scope, pointId)) throw new BoronganError("Anda hanya bisa mengurus titik borongan Anda sendiri");
}

// ---------------- LOKASI ----------------

async function driverLocation(db: DB) {
  const s = await db.setting.findUnique({ where: { key: "loc_borongan_driver" } });
  if (s) return s.value;
  const l = await db.location.findUnique({ where: { code: "DRV" } });
  if (!l) throw new BoronganError("Lokasi driver borongan belum ada");
  return l.id;
}

/** Gudang asal/tujuan menurut jenis barang */
export async function warehouseFor(db: DB, type: ItemType) {
  const locs = await locationSettings(db);
  const id = type === "BAHAN_BAKU" ? locs.raw : type === "BARANG_DALAM_PROSES" ? locs.wip : locs.finished;
  if (!id) throw new BoronganError("Lokasi gudang belum diatur di Pengaturan");
  return id;
}

// ---------------- SERAH TERIMA LEWAT DRIVER ----------------

export type HandoverInput = { kind: HandoverKind; pointId: string; driverId?: string | null; date?: Date; note?: string | null; lines: { itemId: string; qty: number }[] };

/** Barang diserahkan ke driver: keluar dari gudang (KIRIM) atau titik (KEMBALI) ke lokasi driver */
export async function createHandover(input: HandoverInput, actor: Actor) {
  const lines = input.lines.filter((l) => l.itemId && l.qty > 0);
  if (!lines.length) throw new BoronganError("Isi minimal satu barang beserta jumlahnya");
  return prisma.$transaction(async (tx) => {
    const point = await tx.boronganPoint.findUniqueOrThrow({ where: { id: input.pointId } });
    const drv = await driverLocation(tx);
    const date = input.date ?? new Date();
    const number = await nextNumber(tx, "SRT", date);
    const items = await tx.item.findMany({ where: { id: { in: lines.map((l) => l.itemId) } } });
    const rows = [];
    for (const l of lines) {
      const item = items.find((i) => i.id === l.itemId);
      if (!item) throw new BoronganError("Barang tidak ditemukan");
      const warehouseId = await warehouseFor(tx, item.type);
      const from = input.kind === "KIRIM" ? warehouseId : point.locationId;
      await recordMovement(tx, { type: "TRANSFER", itemId: item.id, qty: l.qty, fromLocationId: from, toLocationId: drv, ref: `SRT:${number}`, note: `${HANDOVER_LABEL[input.kind]} ${point.name}`, date }, actor);
      rows.push({ itemId: item.id, qty: new Prisma.Decimal(l.qty), warehouseId });
    }
    const h = await tx.boronganHandover.create({
      data: { number, kind: input.kind, pointId: point.id, driverId: input.driverId || null, date, note: input.note ?? null, createdBy: actor.name, lines: { create: rows } },
    });
    await audit(actor, "SERAH_TERIMA_BORONGAN", "BoronganHandover", h.id, { number, kind: input.kind, point: point.code }, tx);
    return h;
  });
}

/**
 * Penerima mengonfirmasi: barang pindah dari driver ke titik (KIRIM) atau ke gudang (KEMBALI).
 * `divisionId`: kapten divisi boleh menerima kiriman hasil yang semua barangnya milik divisinya (mis. pot cat giftbox).
 */
export async function receiveHandover(id: string, actor: Actor, scope: Scope, opts: { divisionId?: string | null } = {}) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganHandover" WHERE id = ${id} FOR UPDATE`;
    const h = await tx.boronganHandover.findUniqueOrThrow({ where: { id }, include: { lines: true, point: true } });
    if (h.status !== "DIKIRIM") throw new BoronganError("Serah terima ini sudah diproses");
    // Bahan diterima koordinator titik; hasil diterima pengelola gudang
    if (h.kind === "KIRIM") {
      if (isSetoranOnly(scope)) throw new BoronganError("Bahan di titik diterima oleh koordinator titik");
      assertPoint(scope, h.pointId);
    } else if (!canWarehouse(scope)) {
      const items = opts.divisionId ? await tx.item.findMany({ where: { id: { in: h.lines.map((l) => l.itemId) } }, select: { divisionId: true } }) : [];
      if (!opts.divisionId || !items.length || items.some((i) => i.divisionId !== opts.divisionId)) throw new BoronganError("Hasil borongan diterima oleh pengelola gudang atau kapten divisi pemilik barang");
    }
    const drv = await driverLocation(tx);
    for (const l of h.lines) {
      const to = h.kind === "KIRIM" ? h.point.locationId : l.warehouseId;
      await recordMovement(tx, { type: "TRANSFER", itemId: l.itemId, qty: Number(l.qty), fromLocationId: drv, toLocationId: to, ref: `SRT:${h.number}`, note: `Diterima ${h.kind === "KIRIM" ? h.point.name : "gudang"}`, allowNegative: true }, actor);
    }
    await tx.boronganHandover.update({ where: { id }, data: { status: "DITERIMA", receivedAt: new Date(), receivedBy: actor.name } });
    await audit(actor, "SERAH_TERIMA_DITERIMA", "BoronganHandover", id, { number: h.number }, tx);
  });
}

/** Batalkan serah terima yang belum diterima: barang kembali ke asal */
export async function cancelHandover(id: string, actor: Actor, scope: Scope) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganHandover" WHERE id = ${id} FOR UPDATE`;
    const h = await tx.boronganHandover.findUniqueOrThrow({ where: { id }, include: { lines: true, point: true } });
    if (h.status !== "DIKIRIM") throw new BoronganError("Hanya serah terima yang belum diterima yang bisa dibatalkan");
    if (isSetoranOnly(scope) || (h.kind === "KIRIM" ? !canWarehouse(scope) : !canPoint(scope, h.pointId))) throw new BoronganError("Hanya pembuat serah terima yang bisa membatalkan");
    const drv = await driverLocation(tx);
    for (const l of h.lines) {
      const back = h.kind === "KIRIM" ? l.warehouseId : h.point.locationId;
      await recordMovement(tx, { type: "TRANSFER", itemId: l.itemId, qty: Number(l.qty), fromLocationId: drv, toLocationId: back, ref: `SRT:${h.number}`, note: "Serah terima dibatalkan", allowNegative: true }, actor);
    }
    await tx.boronganHandover.update({ where: { id }, data: { status: "DIBATALKAN" } });
    await audit(actor, "SERAH_TERIMA_DIBATALKAN", "BoronganHandover", id, { number: h.number }, tx);
  });
}

// ---------------- SETORAN HASIL ----------------

async function defaultStore(db: DB) {
  const s = await db.setting.findUnique({ where: { key: "default_store_id" } });
  if (!s) throw new BoronganError("Toko default belum diatur di Pengaturan");
  return s.value;
}

export type ResultInput = { pointId: string; workerId: string; taskId: string; date: Date; qty: number; note?: string | null };

/**
 * Catat hasil kerja satu pekerja:
 * - bahan per pcs (resep tugas) terpakai dari stok titik
 * - barang hasil bertambah di stok titik, nilai = bahan yang terpakai
 * - upah dicatat per pekerja/koordinator/driver, dibayar nanti lewat Bayar Upah
 */
export async function recordResult(input: ResultInput, actor: Actor, scope: Scope) {
  return prisma.$transaction((tx) => recordResultTx(tx, input, actor, scope));
}

/**
 * Setoran beberapa pekerja sekaligus dalam SATU transaksi: bila satu baris gagal
 * (mis. bahan tidak cukup), tidak ada setoran yang tersimpan sebagian.
 */
export async function recordResults(inputs: ResultInput[], actor: Actor, scope: Scope) {
  if (!inputs.length) throw new BoronganError("Isi jumlah hasil minimal satu pekerja");
  return prisma.$transaction(async (tx) => {
    const out = [];
    for (const input of inputs) out.push(await recordResultTx(tx, input, actor, scope));
    return out;
  }, { timeout: 30000 });
}

async function recordResultTx(tx: Tx, input: ResultInput, actor: Actor, scope: Scope) {
  assertPoint(scope, input.pointId);
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new BoronganError("Jumlah hasil harus bilangan bulat lebih dari 0");
  {
    const point = await tx.boronganPoint.findUniqueOrThrow({ where: { id: input.pointId } });
    const worker = await tx.boronganPerson.findUniqueOrThrow({ where: { id: input.workerId } });
    if (worker.role !== "PEKERJA" || worker.pointId !== point.id || !worker.active) throw new BoronganError("Pekerja tidak terdaftar aktif di titik ini");
    const task = await tx.pieceTask.findUniqueOrThrow({ where: { id: input.taskId }, include: { inputs: { include: { item: true } }, outputItem: true } });
    if (!task.active) throw new BoronganError("Tugas ini sudah nonaktif");
    if (!canTask(scope, task.id)) throw new BoronganError(`Setoran ${task.name} dicatat oleh divisi lain`);
    const cfg = (await pointConfig(tx))[point.id];
    if (cfg?.tasks.length && !cfg.tasks.includes(task.id)) throw new BoronganError(`Tugas ${task.name} tidak dikerjakan di titik ${point.name}`);
    const split = { workerRate: Number(task.workerRate), coordinatorRate: Number(task.coordinatorRate), driverRate: Number(task.driverRate) };
    const coordinator = await tx.boronganPerson.findFirst({ where: { role: "KOORDINATOR", pointId: point.id, active: true }, orderBy: { createdAt: "asc" } });
    const driver = await tx.boronganPerson.findFirst({ where: { role: "DRIVER", active: true }, orderBy: { createdAt: "asc" } });
    if (split.coordinatorRate > 0 && !coordinator) throw new BoronganError(`Titik ${point.name} belum punya koordinator aktif`);
    if (split.driverRate > 0 && !driver) throw new BoronganError("Belum ada driver borongan aktif");
    const number = await nextNumber(tx, "HSB", input.date);
    const r = await tx.boronganResult.create({
      data: {
        number, pointId: point.id, workerId: worker.id, coordinatorId: coordinator?.id ?? null, driverId: driver?.id ?? null, taskId: task.id,
        date: input.date, qty: input.qty, workerRate: BigInt(split.workerRate), coordinatorRate: BigInt(split.coordinatorRate), driverRate: BigInt(split.driverRate),
        note: input.note ?? null, createdBy: actor.name, createdById: actor.id,
      },
    });
    const when = new Date(`${input.date.toISOString().slice(0, 10)}T05:00:00.000Z`);
    const outType: ItemType = task.outputItem?.type ?? "BARANG_DALAM_PROSES";
    const byType = new Map<ItemType, number>();
    let material = 0;
    // Hasil tidak boleh melebihi bahan yang sudah diterima titik (cegah upah dari hasil yang tidak didukung bahan)
    await tx.$queryRaw`SELECT id FROM "BoronganPoint" WHERE id = ${point.id} FOR UPDATE`;
    for (const inp of task.inputs) {
      const per = bomStockQty(inp.qty, inp.item);
      if (per <= 0) continue;
      const avail = await qtyAt(tx, inp.itemId, point.locationId);
      if (per * input.qty > avail + 1e-6) {
        const cukup = Math.max(0, Math.floor((avail + 1e-6) / per));
        throw new BoronganError(`Bahan ${inp.item.name} di ${point.name} tinggal ${Number(avail.toFixed(3)).toLocaleString("id-ID")} ${inp.item.unit}, cukup untuk ${cukup} pcs (${worker.name} ${input.qty} pcs). Kirim bahan dulu lewat serah terima.`);
      }
    }
    for (const inp of task.inputs) {
      const q = bomStockQty(inp.qty, inp.item) * input.qty;
      if (q <= 0) continue;
      await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: inp.itemId, qty: q, fromLocationId: point.locationId, ref: `HSB:${r.id}`, note: `${task.name} ${worker.name}`, date: when }, actor);
      const v = Math.round(q * Number(inp.item.avgCost));
      material += v;
      byType.set(inp.item.type, (byType.get(inp.item.type) ?? 0) + v);
    }
    if (task.outputItemId) {
      await recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: task.outputItemId, qty: input.qty, toLocationId: point.locationId, unitCost: Math.round(material / input.qty), ref: `HSB:${r.id}`, note: `${task.name} ${worker.name}`, date: when }, actor);
    }
    // Nilai bahan pindah dari akun persediaan bahan ke akun persediaan barang hasil
    const lines = [...byType].filter(([t, v]) => t !== outType && v > 0).flatMap(([t, v]) => [{ accountCode: INVENTORY_COA[outType], debit: v }, { accountCode: INVENTORY_COA[t], credit: v }]);
    if (lines.length) {
      await postJournal(tx, { date: when, storeId: await defaultStore(tx), description: `Borongan ${point.name}: ${task.name} × ${input.qty} (${worker.name})`, source: "BORONGAN", sourceId: r.id, actor, lines });
    }
    await audit(actor, "HASIL_BORONGAN", "BoronganResult", r.id, { number, point: point.code, worker: worker.name, task: task.code, qty: input.qty }, tx);
    return r;
  }
}

/** Hapus setoran yang belum dibayar: stok & jurnal dibalik */
export async function deleteResult(id: string, actor: Actor, scope: Scope) {
  return prisma.$transaction(async (tx) => {
    // Kunci baris: dua permintaan hapus bersamaan tidak boleh membalik stok dua kali
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "BoronganResult" WHERE id = ${id} FOR UPDATE`;
    if (!locked.length) throw new BoronganError("Setoran sudah dihapus");
    const r = await tx.boronganResult.findUniqueOrThrow({ where: { id }, include: { task: { select: { name: true } } } });
    assertPoint(scope, r.pointId);
    if (!canTask(scope, r.taskId)) throw new BoronganError(`Setoran ${r.task.name} milik divisi lain`);
    // Anggota divisi hanya membatalkan setoran yang ia catat sendiri; kapten semua setoran divisinya
    if (scope.division && !scope.division.captain && !scope.warehouse && r.createdById !== actor.id) throw new BoronganError("Anda hanya bisa membatalkan setoran yang Anda catat sendiri. Minta kapten divisi.");
    if (r.settlementId) throw new BoronganError("Upah setoran ini sudah dibayar, tidak bisa dihapus");
    await reverseMovementsByRef(tx, `HSB:${id}`, `BATAL-HSB:${id}`, "Setoran borongan dihapus", actor);
    const journals = await tx.journal.findMany({ where: { source: "BORONGAN", sourceId: id, reversalOfId: null } });
    for (const j of journals) await reverseJournal(tx, j.id, new Date(), actor, "Setoran borongan dihapus");
    await tx.boronganResult.delete({ where: { id } });
    await audit(actor, "HASIL_BORONGAN_DIHAPUS", "BoronganResult", id, { number: r.number, task: r.task.name, qty: r.qty, pencatat: r.createdBy }, tx);
  });
}

// ---------------- UPAH ----------------

export type PayLine = { personId: string; name: string; role: BoronganRole; qty: number; amount: number };

/** Rekap upah per orang dari daftar setoran */
export function payLines(results: { qty: number; workerRate: bigint; coordinatorRate: bigint; driverRate: bigint; worker: { id: string; name: string }; coordinator: { id: string; name: string } | null; driver: { id: string; name: string } | null }[]): PayLine[] {
  const m = new Map<string, PayLine>();
  const add = (p: { id: string; name: string } | null, role: BoronganRole, qty: number, amount: number) => {
    if (!p || amount <= 0) return;
    const k = `${role}:${p.id}`;
    const cur = m.get(k) ?? { personId: p.id, name: p.name, role, qty: 0, amount: 0 };
    cur.qty += qty;
    cur.amount += amount;
    m.set(k, cur);
  };
  for (const r of results) {
    const s = resultShares(r.qty, { workerRate: Number(r.workerRate), coordinatorRate: Number(r.coordinatorRate), driverRate: Number(r.driverRate) });
    add(r.worker, "PEKERJA", r.qty, s.worker);
    add(r.coordinator, "KOORDINATOR", r.qty, s.coordinator);
    add(r.driver, "DRIVER", r.qty, s.driver);
  }
  const order: BoronganRole[] = ["PEKERJA", "KOORDINATOR", "DRIVER"];
  return [...m.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.name.localeCompare(b.name));
}

const resultPeople = { worker: true, coordinator: true, driver: true } as const;

export async function unpaidResults(db: DB, pointId: string, upTo?: Date) {
  return db.boronganResult.findMany({ where: { pointId, settlementId: null, ...(upTo ? { date: { lte: upTo } } : {}) }, include: { ...resultPeople, task: true }, orderBy: { date: "asc" } });
}

/**
 * Bayar upah satu titik sekaligus (pekerja, koordinator, dan jatah driver).
 * Jatah driver dibukukan sebagai beban transport borongan, terpisah dari Kompensasi Pengelola.
 */
export async function settlePoint(input: { pointId: string; upTo: Date; bankAccountId: string; date?: Date }, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganPoint" WHERE id = ${input.pointId} FOR UPDATE`;
    const point = await tx.boronganPoint.findUniqueOrThrow({ where: { id: input.pointId } });
    const results = await unpaidResults(tx, point.id, input.upTo);
    if (!results.length) throw new BoronganError("Tidak ada upah yang belum dibayar sampai tanggal itu");
    const lines = payLines(results);
    const driver = lines.filter((l) => l.role === "DRIVER").reduce((s, l) => s + l.amount, 0);
    const wages = lines.filter((l) => l.role !== "DRIVER").reduce((s, l) => s + l.amount, 0);
    const total = wages + driver;
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: input.bankAccountId } });
    const date = input.date ?? new Date();
    const number = await nextNumber(tx, "UPB", date);
    const st = await tx.boronganSettlement.create({ data: { number, pointId: point.id, date, upTo: input.upTo, bankAccountId: bank.id, total: BigInt(total), createdBy: actor.name } });
    const j = await postJournal(tx, {
      date,
      storeId: await defaultStore(tx),
      description: `Upah borongan ${point.name} s.d. ${input.upTo.toISOString().slice(0, 10)} (${number})`,
      source: "BORONGAN",
      sourceId: st.id,
      actor,
      lines: [
        ...(wages > 0 ? [{ accountCode: COA.BEBAN_GAJI_PRODUKSI, debit: wages, memo: "Upah borongan pekerja & koordinator" }] : []),
        ...(driver > 0 ? [{ accountCode: COA.BEBAN_TRANSPORT, debit: driver, memo: "Jatah driver borongan" }] : []),
        { accountId: bank.coaAccountId, credit: total },
      ],
    });
    const paid = await tx.boronganSettlement.update({ where: { id: st.id }, data: { journalId: j.id } });
    await tx.boronganResult.updateMany({ where: { id: { in: results.map((r) => r.id) } }, data: { settlementId: st.id } });
    await audit(actor, "UPAH_BORONGAN_DIBAYAR", "BoronganSettlement", st.id, { number, point: point.code, total }, tx);
    return paid;
  });
}

/** Batalkan pembayaran upah satu titik: jurnal dibalik, setorannya kembali menjadi belum dibayar */
export async function cancelSettlement(id: string, reason: string, actor: Actor, now: Date = new Date()) {
  if (!reason?.trim()) throw new BoronganError("Alasan pembatalan wajib diisi");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganSettlement" WHERE id = ${id} FOR UPDATE`;
    const st = await tx.boronganSettlement.findUniqueOrThrow({ where: { id } });
    if (st.cancelledAt) throw new BoronganError(`${st.number} sudah dibatalkan`);
    const date = await assertPeriodOpen(tx, st.date).then(() => st.date, () => now);
    if (st.journalId) await reverseJournal(tx, st.journalId, date, actor, `batal ${st.number} — ${reason.trim()}`.slice(0, 150));
    await tx.boronganResult.updateMany({ where: { settlementId: id }, data: { settlementId: null } });
    const out = await tx.boronganSettlement.update({ where: { id }, data: { cancelledAt: now, cancelReason: reason.trim().slice(0, 300) } });
    await audit(actor, "UPAH_BORONGAN_DIBATALKAN", "BoronganSettlement", id, { number: st.number, reason }, tx);
    return out;
  });
}

// ---------------- ORANG ----------------

export type PersonInput = { id?: string | null; name: string; phone?: string | null; role: BoronganRole; pointId?: string | null; active?: boolean; note?: string | null };

/** Koordinator hanya boleh menambah/mengubah pekerja di titiknya sendiri */
export async function savePerson(input: PersonInput, actor: Actor, scope: Scope) {
  const name = input.name.trim();
  if (!name) throw new BoronganError("Nama wajib diisi");
  const pointId = input.role === "DRIVER" ? null : input.pointId || null;
  if (input.role !== "DRIVER" && !pointId) throw new BoronganError("Pilih titik borongan");
  if (isSetoranOnly(scope)) throw new BoronganError("Data pekerja diatur pengelola borongan / koordinator titik");
  if (!scope.all) {
    if (input.role !== "PEKERJA") throw new BoronganError("Koordinator hanya bisa menambah pekerja");
    assertPoint(scope, pointId!);
  }
  const data = { name, phone: input.phone || null, role: input.role, pointId, active: input.active ?? true, note: input.note || null };
  // Pekerja baru dari koordinator menunggu persetujuan pengelola (diaktifkan pengelola), agar upah tidak dibayar ke nama fiktif
  if (!scope.all && !input.id) data.active = false;
  if (input.id) {
    const cur = await prisma.boronganPerson.findUniqueOrThrow({ where: { id: input.id } });
    if (!scope.all && (cur.role !== "PEKERJA" || !canPoint(scope, cur.pointId ?? ""))) throw new BoronganError("Anda hanya bisa mengubah pekerja di titik Anda");
    if (!scope.all && !cur.active) data.active = false;
    const p = await prisma.boronganPerson.update({ where: { id: input.id }, data });
    if (cur.userId && (!data.active || data.role !== "KOORDINATOR")) await prisma.user.update({ where: { id: cur.userId }, data: { active: false } });
    await audit(actor, "ORANG_BORONGAN_DIUBAH", "BoronganPerson", p.id, data);
    return p;
  }
  const p = await prisma.boronganPerson.create({ data });
  await audit(actor, "ORANG_BORONGAN_DITAMBAH", "BoronganPerson", p.id, data);
  return p;
}

/** Hapus orang; yang sudah punya riwayat setoran dinonaktifkan saja */
export async function removePerson(id: string, actor: Actor, scope: Scope) {
  if (isSetoranOnly(scope)) throw new BoronganError("Data pekerja diatur pengelola borongan / koordinator titik");
  const p = await prisma.boronganPerson.findUniqueOrThrow({ where: { id } });
  if (!scope.all && (p.role !== "PEKERJA" || !canPoint(scope, p.pointId ?? ""))) throw new BoronganError("Anda hanya bisa menghapus pekerja di titik Anda");
  const used = await prisma.boronganResult.count({ where: { OR: [{ workerId: id }, { coordinatorId: id }, { driverId: id }] } });
  if (used || p.userId) {
    await prisma.boronganPerson.update({ where: { id }, data: { active: false } });
    if (p.userId) await prisma.user.update({ where: { id: p.userId }, data: { active: false } });
    await audit(actor, "ORANG_BORONGAN_NONAKTIF", "BoronganPerson", id, { name: p.name });
    return "nonaktif" as const;
  }
  await prisma.boronganPerson.delete({ where: { id } });
  await audit(actor, "ORANG_BORONGAN_DIHAPUS", "BoronganPerson", id, { name: p.name });
  return "dihapus" as const;
}
