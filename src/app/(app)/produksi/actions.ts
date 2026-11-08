"use server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { action, str, int, optStr, bool } from "@/lib/action";
import { STAGES } from "@/lib/stock";
import { EntryForbidden, deleteProductionEntry, recordProductionEntry } from "@/lib/productionEntry";
import { REJECT_REASONS } from "@/lib/reject";
import { audit } from "@/lib/audit";
import { ForbiddenError } from "@/lib/auth";

export const createEntry = action(
  "production.create",
  async (fd, user) => {
    try {
      await recordProductionEntry(
        {
          date: str(fd, "date"),
          shiftId: str(fd, "shiftId"),
          divisionId: str(fd, "divisionId"),
          employeeId: str(fd, "employeeId"),
          stage: str(fd, "stage"),
          productId: str(fd, "productId"),
          qtyGood: int(fd, "qtyGood"),
          qtyReject: int(fd, "qtyReject"),
          rejectReason: (optStr(fd, "rejectReason") ?? null) as (typeof REJECT_REASONS)[number] | null,
          note: optStr(fd, "note"),
        },
        user,
      );
    } catch (e) {
      if (e instanceof EntryForbidden) throw new ForbiddenError();
      throw e;
    }
    return "Hasil produksi tersimpan";
  },
  ["/produksi", "/"],
);

export const deleteEntry = action(
  "production.edit",
  async (fd, user) => {
    const id = str(fd, "id");
    await deleteProductionEntry(id, user);
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
