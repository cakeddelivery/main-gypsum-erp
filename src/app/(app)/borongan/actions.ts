"use server";
import type { BoronganRole, HandoverKind } from "@prisma/client";
import { action, int, optStr, str } from "@/lib/action";
import { hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { BoronganError, assertPoint, boronganScope, cancelHandover, checkSplit, createHandover, deleteResult, receiveHandover, recordResult, removePerson, savePerson, settlePoint } from "@/lib/borongan";
import { dateOnly, jakartaDateTime, todayStr } from "@/lib/time";

const PATHS = ["/borongan", "/stok"];
const num = (x: FormDataEntryValue) => Number(String(x).replace(/\./g, "").replace(",", ".")) || 0;
const lines = (fd: FormData) => {
  const qty = fd.getAll("qty").map(num);
  return fd.getAll("itemId").map((v, i) => ({ itemId: String(v), qty: qty[i] ?? 0 }));
};
const when = (fd: FormData) => jakartaDateTime(str(fd, "date") || todayStr(), "12:00");

export const sendHandover = action(
  ["borongan.manage", "borongan.point"],
  async (fd, user) => {
    const kind = str(fd, "kind") as HandoverKind;
    const scope = await boronganScope(prisma, user);
    const pointId = str(fd, "pointId");
    // Bahan dikirim dari gudang oleh pengelola; hasil dikirim balik oleh koordinator titik
    if (kind === "KIRIM" && !scope.all) throw new BoronganError("Pengiriman bahan dicatat oleh pengelola gudang");
    if (kind === "KEMBALI") assertPoint(scope, pointId);
    const h = await createHandover({ kind, pointId, driverId: optStr(fd, "driverId"), date: when(fd), note: optStr(fd, "note"), lines: lines(fd) }, user);
    return `Serah terima ${h.number} tercatat, menunggu dikonfirmasi penerima`;
  },
  PATHS,
);

export const confirmHandover = action(
  ["borongan.manage", "borongan.point"],
  async (fd, user) => {
    await receiveHandover(str(fd, "id"), user, await boronganScope(prisma, user));
    return "Barang diterima, stok sudah pindah";
  },
  PATHS,
);

export const voidHandover = action(
  ["borongan.manage", "borongan.point"],
  async (fd, user) => {
    await cancelHandover(str(fd, "id"), user, await boronganScope(prisma, user));
    return "Serah terima dibatalkan, barang kembali ke asal";
  },
  PATHS,
);

/** Satu form untuk beberapa pekerja sekaligus: kolom qty_<idPekerja> */
export const addResults = action(
  ["borongan.manage", "borongan.point"],
  async (fd, user) => {
    const scope = await boronganScope(prisma, user);
    const pointId = str(fd, "pointId");
    const taskId = str(fd, "taskId");
    const date = dateOnly(str(fd, "date") || todayStr());
    const rows = [...fd.entries()].filter(([k, v]) => k.startsWith("qty_") && String(v).trim()).map(([k, v]) => ({ workerId: k.slice(4), qty: num(v) }));
    if (!rows.length) throw new BoronganError("Isi jumlah hasil minimal satu pekerja");
    let total = 0;
    for (const r of rows) {
      await recordResult({ pointId, taskId, date, workerId: r.workerId, qty: r.qty, note: optStr(fd, "note") }, user, scope);
      total += r.qty;
    }
    return `Setoran ${rows.length} pekerja tercatat (${total.toLocaleString("id-ID")} pcs)`;
  },
  PATHS,
);

export const removeResult = action(
  ["borongan.manage", "borongan.point"],
  async (fd, user) => {
    await deleteResult(str(fd, "id"), user, await boronganScope(prisma, user));
    return "Setoran dihapus, stok dikembalikan";
  },
  PATHS,
);

export const savePersonAction = action(
  ["borongan.manage", "borongan.point"],
  async (fd, user) => {
    const scope = await boronganScope(prisma, user);
    const p = await savePerson({ id: optStr(fd, "id"), name: str(fd, "name"), phone: optStr(fd, "phone"), role: (str(fd, "role") || "PEKERJA") as BoronganRole, pointId: optStr(fd, "pointId") ?? scope.pointIds[0], active: fd.get("active") !== "off", note: optStr(fd, "note") }, user, scope);
    return `${p.name} tersimpan`;
  },
  PATHS,
);

export const removePersonAction = action(
  ["borongan.manage", "borongan.point"],
  async (fd, user) => {
    const r = await removePerson(str(fd, "id"), user, await boronganScope(prisma, user));
    return r === "nonaktif" ? "Sudah punya riwayat setoran, jadi dinonaktifkan" : "Dihapus";
  },
  PATHS,
);

/** Akun login untuk koordinator (role Koordinator Borongan, hanya melihat titiknya) */
export const saveCoordinatorLogin = action(
  "borongan.manage",
  async (fd, user) => {
    const person = await prisma.boronganPerson.findUniqueOrThrow({ where: { id: str(fd, "personId") } });
    if (person.role !== "KOORDINATOR") throw new BoronganError("Login hanya untuk koordinator");
    const username = str(fd, "username").toLowerCase();
    const password = str(fd, "password");
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new BoronganError("Username 3–30 huruf kecil/angka tanpa spasi");
    if (person.userId) {
      await prisma.user.update({ where: { id: person.userId }, data: { username, name: person.name, active: person.active, ...(password ? { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null } : {}) } });
    } else {
      if (!password) throw new BoronganError("Isi password untuk akun baru");
      const u = await prisma.user.create({ data: { username, name: person.name, role: "KOORDINATOR", passwordHash: await hashPassword(password) } });
      await prisma.boronganPerson.update({ where: { id: person.id }, data: { userId: u.id } });
    }
    await audit(user, "AKUN_KOORDINATOR", "BoronganPerson", person.id, { username });
    return `Login ${username} untuk ${person.name} tersimpan`;
  },
  PATHS,
);

export const saveTask = action(
  "borongan.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const split = { workerRate: int(fd, "workerRate"), coordinatorRate: int(fd, "coordinatorRate"), driverRate: int(fd, "driverRate") };
    const total = split.workerRate + split.coordinatorRate + split.driverRate;
    checkSplit(total, split);
    const name = str(fd, "name");
    if (!name) throw new BoronganError("Nama tugas wajib diisi");
    const inputs = lines(fd).filter((l) => l.itemId && l.qty > 0);
    const data = { name, ratePerPcs: BigInt(total), workerRate: BigInt(split.workerRate), coordinatorRate: BigInt(split.coordinatorRate), driverRate: BigInt(split.driverRate), outputItemId: optStr(fd, "outputItemId"), active: fd.get("active") !== "off" };
    const t = await prisma.$transaction(async (tx) => {
      const t = id
        ? await tx.pieceTask.update({ where: { id }, data })
        : await tx.pieceTask.create({ data: { ...data, code: `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 24)}_${Date.now().toString(36).slice(-4).toUpperCase()}` } });
      await tx.pieceTaskInput.deleteMany({ where: { taskId: t.id } });
      if (inputs.length) await tx.pieceTaskInput.createMany({ data: inputs.map((l) => ({ taskId: t.id, itemId: l.itemId, qty: l.qty })) });
      return t;
    });
    await audit(user, "TUGAS_BORONGAN", "PieceTask", t.id, { name, ...split, inputs: inputs.length });
    return `Tugas ${t.name} tersimpan (budget Rp${total}/pcs)`;
  },
  [...PATHS, "/gaji/borongan"],
);

export const payPoint = action(
  "borongan.pay",
  async (fd, user) => {
    const st = await settlePoint({ pointId: str(fd, "pointId"), upTo: dateOnly(str(fd, "upTo") || todayStr()), bankAccountId: str(fd, "bankAccountId") }, user);
    return `Upah ${st.number} dibayar Rp${Number(st.total).toLocaleString("id-ID")}`;
  },
  [...PATHS, "/akuntansi"],
);
