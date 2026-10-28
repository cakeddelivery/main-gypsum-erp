"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, int, optStr, bool } from "@/lib/action";
import { postProductionStock, reverseProductionStock, STAGES } from "@/lib/stock";
import { audit } from "@/lib/audit";
import { dateOnly } from "@/lib/time";
import { ForbiddenError } from "@/lib/auth";

const entrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal wajib"),
  shiftId: z.string().min(1, "Pilih shift"),
  divisionId: z.string().min(1, "Pilih divisi"),
  employeeId: z.string().min(1, "Pilih karyawan"),
  stage: z.enum(STAGES as [string, ...string[]]),
  productId: z.string().min(1, "Pilih produk"),
  qtyGood: z.number().int().min(0).max(100000),
  qtyReject: z.number().int().min(0).max(100000),
});

export const createEntry = action(
  "production.create",
  async (fd, user) => {
    const data = entrySchema.parse({
      date: str(fd, "date"),
      shiftId: str(fd, "shiftId"),
      divisionId: str(fd, "divisionId"),
      employeeId: str(fd, "employeeId"),
      stage: str(fd, "stage"),
      productId: str(fd, "productId"),
      qtyGood: int(fd, "qtyGood"),
      qtyReject: int(fd, "qtyReject"),
    });
    if (data.qtyGood + data.qtyReject === 0) throw new Error("Isi jumlah hasil atau reject");
    // Operator hanya boleh mencatat hasil dirinya; kapten hanya divisinya
    if (user.role === "OPERATOR" && data.employeeId !== user.employeeId) throw new ForbiddenError();
    if (user.role === "KAPTEN_DIVISI" && user.divisionId && data.divisionId !== user.divisionId) throw new ForbiddenError();
    const emp = await prisma.employee.findUniqueOrThrow({ where: { id: data.employeeId } });
    if (emp.status === "NONAKTIF") throw new Error("Karyawan nonaktif");
    await prisma.$transaction(async (tx) => {
      const e = await tx.productionEntry.create({ data: { ...data, stage: data.stage as (typeof STAGES)[number], date: dateOnly(data.date), note: optStr(fd, "note"), createdBy: user.name } });
      await postProductionStock(tx, e.id, user);
      await audit(user, "PRODUKSI_DICATAT", "ProductionEntry", e.id, data, tx);
    });
    return "Hasil produksi tersimpan";
  },
  ["/produksi", "/"],
);

export const deleteEntry = action(
  "production.edit",
  async (fd, user) => {
    const id = str(fd, "id");
    await prisma.$transaction(async (tx) => {
      const e = await tx.productionEntry.findUniqueOrThrow({ where: { id } });
      if (e.stockPosted) await reverseProductionStock(tx, id, user);
      await tx.productionEntry.delete({ where: { id } });
      await audit(user, "PRODUKSI_DIHAPUS", "ProductionEntry", id, e, tx);
    });
    return "Entri dihapus dan stok/jurnal dibalik";
  },
  ["/produksi"],
);

export const saveTarget = action(
  "production.target",
  async (fd, user) => {
    const id = optStr(fd, "id");
    const data = {
      divisionId: str(fd, "divisionId"),
      employeeId: optStr(fd, "employeeId"),
      stage: z.enum(STAGES as [string, ...string[]]).parse(str(fd, "stage")) as (typeof STAGES)[number],
      dailyQty: z.number().int().min(1, "Target minimal 1").parse(int(fd, "dailyQty")),
      active: id ? bool(fd, "active") : true,
    };
    if (user.role === "KAPTEN_DIVISI" && user.divisionId && data.divisionId !== user.divisionId) throw new ForbiddenError();
    const t = id ? await prisma.productionTarget.update({ where: { id }, data }) : await prisma.productionTarget.create({ data });
    await audit(user, id ? "TARGET_DIUBAH" : "TARGET_DIBUAT", "ProductionTarget", t.id, data);
    return "Target tersimpan";
  },
  ["/produksi"],
);
