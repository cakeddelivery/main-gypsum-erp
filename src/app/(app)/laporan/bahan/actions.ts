"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, bool, dec, int, optStr, str } from "@/lib/action";
import { audit } from "@/lib/audit";
import { isTemplate, materialSku, type ChecklistTask } from "@/lib/shiftReport";

const PATHS = ["/laporan", "/stok"];

/** Tambah / ubah bahan baku divisi beserta limit order-nya */
export const saveMaterial = action(
  "material.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const divisionId = str(fd, "divisionId");
    const division = await prisma.division.findUniqueOrThrow({ where: { id: divisionId } });
    const name = z.string().min(2, "Nama bahan wajib").max(80).parse(str(fd, "name"));
    const limit = dec(fd, "limit");
    if (limit < 0) throw new Error("Limit tidak boleh negatif");
    const data = { name, unit: str(fd, "unit") || "pcs", minStock: limit, divisionId, sortOrder: int(fd, "sortOrder") };
    let item;
    if (id) {
      item = await prisma.item.update({ where: { id }, data });
    } else {
      // SKU otomatis, diberi akhiran bila nama yang sama pernah dipakai
      const base = materialSku(division.code, name);
      let sku = base;
      for (let i = 2; await prisma.item.findUnique({ where: { sku } }); i++) sku = `${base}-${i}`;
      const last = await prisma.item.aggregate({ where: { divisionId }, _max: { sortOrder: true } });
      item = await prisma.item.create({ data: { ...data, sku, type: "BAHAN_BAKU", sortOrder: str(fd, "sortOrder") ? data.sortOrder : (last._max.sortOrder ?? -1) + 1 } });
    }
    await audit(user, id ? "BAHAN_DIUBAH" : "BAHAN_DIBUAT", "Item", item.id, { name, unit: data.unit, limit, division: division.name });
    return `Bahan ${name} tersimpan`;
  },
  PATHS,
);

/** Hapus bahan: yang sudah punya riwayat stok/pembelian dinonaktifkan agar jejak tetap utuh */
export const deleteMaterial = action(
  "material.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    const it = await prisma.item.findUniqueOrThrow({ where: { id }, include: { _count: { select: { movements: true, bomLines: true, requests: true, purchaseLines: true } } } });
    const used = it._count.movements + it._count.bomLines + it._count.requests + it._count.purchaseLines > 0;
    if (used) await prisma.item.update({ where: { id }, data: { active: false } });
    else await prisma.item.delete({ where: { id } });
    await audit(user, used ? "BAHAN_DINONAKTIFKAN" : "BAHAN_DIHAPUS", "Item", id, { name: it.name });
    return used ? `${it.name} dihapus dari daftar (riwayat stoknya tetap tersimpan)` : `${it.name} dihapus`;
  },
  PATHS,
);

/** Checklist penutupan shift divisi: label_i + photo_i (wajib foto) */
export const saveChecklist = action(
  "material.manage",
  async (fd, user) => {
    const divisionId = str(fd, "divisionId");
    const n = Math.min(int(fd, "n"), 40);
    const tasks: ChecklistTask[] = [];
    for (let i = 0; i < n; i++) {
      const label = str(fd, `label_${i}`).slice(0, 120);
      if (label) tasks.push({ label, photo: bool(fd, `photo_${i}`) });
    }
    if (!tasks.length) throw new Error("Checklist minimal satu tugas");
    await prisma.division.update({ where: { id: divisionId }, data: { checklist: tasks } });
    await audit(user, "CHECKLIST_DIUBAH", "Division", divisionId, { tasks });
    return "Checklist tersimpan (berlaku untuk laporan baru)";
  },
  PATHS,
);

export const saveDivision = action(
  "material.manage",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const tpl = str(fd, "reportTemplate");
    const data = {
      name: z.string().min(2, "Nama divisi wajib").parse(str(fd, "name")),
      reportTemplate: isTemplate(tpl) ? tpl : null,
      shiftCount: Math.min(Math.max(int(fd, "shiftCount", 1), 1), 3),
      active: id ? bool(fd, "active") : true,
    };
    const d = id
      ? await prisma.division.update({ where: { id }, data })
      : await prisma.division.create({ data: { ...data, code: z.string().regex(/^[A-Z0-9]{2,8}$/, "Kode 2-8 huruf besar/angka").parse(str(fd, "code").toUpperCase()) } });
    await audit(user, id ? "DIVISI_DIUBAH" : "DIVISI_DIBUAT", "Division", d.id, data);
    return "Divisi tersimpan";
  },
  PATHS,
);
