import { Prisma, type BoronganRole, type HandoverKind, type ItemType } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { COA, postJournal, reverseJournal } from "./accounting";
import { nextNumber } from "./numbering";
import { INVENTORY_COA, StockError, locationSettings, recordMovement } from "./stock";
import { bomStockQty } from "./unitcost";

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

export type Scope = { all: boolean; pointIds: string[]; personId: string | null };
type ScopeUser = { id: string; can: (p: "borongan.manage") => boolean };

/** Pengelola melihat semua titik; koordinator hanya titiknya sendiri */
export async function boronganScope(db: DB, user: ScopeUser): Promise<Scope> {
  if (user.can("borongan.manage")) return { all: true, pointIds: [], personId: null };
  const p = await db.boronganPerson.findFirst({ where: { userId: user.id, role: "KOORDINATOR", active: true } });
  return { all: false, pointIds: p?.pointId ? [p.pointId] : [], personId: p?.id ?? null };
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

/** Penerima mengonfirmasi: barang pindah dari driver ke titik (KIRIM) atau ke gudang (KEMBALI) */
export async function receiveHandover(id: string, actor: Actor, scope: Scope) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BoronganHandover" WHERE id = ${id} FOR UPDATE`;
    const h = await tx.boronganHandover.findUniqueOrThrow({ where: { id }, include: { lines: true, point: true } });
    if (h.status !== "DIKIRIM") throw new BoronganError("Serah terima ini sudah diproses");
    // Bahan diterima koordinator titik; hasil diterima pengelola gudang
    if (h.kind === "KIRIM") assertPoint(scope, h.pointId);
    else if (!scope.all) throw new BoronganError("Hasil borongan diterima oleh pengelola gudang");
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
    if (h.kind === "KIRIM" ? !scope.all : !canPoint(scope, h.pointId)) throw new BoronganError("Hanya pembuat serah terima yang bisa membatalkan");
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
  assertPoint(scope, input.pointId);
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new BoronganError("Jumlah hasil harus bilangan bulat lebih dari 0");
  return prisma.$transaction(async (tx) => {
    const point = await tx.boronganPoint.findUniqueOrThrow({ where: { id: input.pointId } });
    const worker = await tx.boronganPerson.findUniqueOrThrow({ where: { id: input.workerId } });
    if (worker.role !== "PEKERJA" || worker.pointId !== point.id || !worker.active) throw new BoronganError("Pekerja tidak terdaftar aktif di titik ini");
    const task = await tx.pieceTask.findUniqueOrThrow({ where: { id: input.taskId }, include: { inputs: { include: { item: true } }, outputItem: true } });
    if (!task.active) throw new BoronganError("Tugas ini sudah nonaktif");
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
        note: input.note ?? null, createdBy: actor.name,
      },
    });
    const when = new Date(`${input.date.toISOString().slice(0, 10)}T05:00:00.000Z`);
    const outType: ItemType = task.outputItem?.type ?? "BARANG_DALAM_PROSES";
    const byType = new Map<ItemType, number>();
    let material = 0;
    for (const inp of task.inputs) {
      const q = bomStockQty(inp.qty, inp.item) * input.qty;
      if (q <= 0) continue;
      await recordMovement(tx, { type: "KONSUMSI_PRODUKSI", itemId: inp.itemId, qty: q, fromLocationId: point.locationId, ref: `HSB:${r.id}`, note: `${task.name} ${worker.name}`, date: when, allowNegative: true }, actor);
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
  });
}

/** Hapus setoran yang belum dibayar: stok & jurnal dibalik */
export async function deleteResult(id: string, actor: Actor, scope: Scope) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.boronganResult.findUniqueOrThrow({ where: { id } });
    assertPoint(scope, r.pointId);
    if (r.settlementId) throw new BoronganError("Upah setoran ini sudah dibayar, tidak bisa dihapus");
    const moves = await tx.stockMovement.findMany({ where: { ref: `HSB:${id}` } });
    for (const mv of moves) {
      await tx.stockMovement.create({ data: { date: new Date(), type: "PENYESUAIAN", itemId: mv.itemId, fromLocationId: mv.toLocationId, toLocationId: mv.fromLocationId, qty: mv.qty, unitCost: mv.unitCost, ref: `BATAL-HSB:${id}`, note: "Setoran borongan dihapus", createdBy: actor.name } });
    }
    const journals = await tx.journal.findMany({ where: { source: "BORONGAN", sourceId: id, reversalOfId: null } });
    for (const j of journals) await reverseJournal(tx, j.id, new Date(), actor, "Setoran borongan dihapus");
    await tx.boronganResult.delete({ where: { id } });
    await audit(actor, "HASIL_BORONGAN_DIHAPUS", "BoronganResult", id, { number: r.number }, tx);
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

// ---------------- ORANG ----------------

export type PersonInput = { id?: string | null; name: string; phone?: string | null; role: BoronganRole; pointId?: string | null; active?: boolean; note?: string | null };

/** Koordinator hanya boleh menambah/mengubah pekerja di titiknya sendiri */
export async function savePerson(input: PersonInput, actor: Actor, scope: Scope) {
  const name = input.name.trim();
  if (!name) throw new BoronganError("Nama wajib diisi");
  const pointId = input.role === "DRIVER" ? null : input.pointId || null;
  if (input.role !== "DRIVER" && !pointId) throw new BoronganError("Pilih titik borongan");
  if (!scope.all) {
    if (input.role !== "PEKERJA") throw new BoronganError("Koordinator hanya bisa menambah pekerja");
    assertPoint(scope, pointId!);
  }
  const data = { name, phone: input.phone || null, role: input.role, pointId, active: input.active ?? true, note: input.note || null };
  if (input.id) {
    const cur = await prisma.boronganPerson.findUniqueOrThrow({ where: { id: input.id } });
    if (!scope.all && (cur.role !== "PEKERJA" || !canPoint(scope, cur.pointId ?? ""))) throw new BoronganError("Anda hanya bisa mengubah pekerja di titik Anda");
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
