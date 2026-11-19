"use server";
import { action, optStr, str } from "@/lib/action";
import { prisma } from "@/lib/db";
import { boronganScope, BoronganError, type Scope } from "@/lib/borongan";
import { isCoordinatorOf } from "@/lib/boronganFlow";
import { correctPointStock, reportMaterialReject, requestPointMaterials } from "@/lib/boronganPointStock";

const PERMS = ["borongan.manage", "borongan.point"] as const;

/** Hanya koordinator titik itu sendiri atau pengelola borongan */
function guard(scope: Scope, pointId: string) {
  if (!scope.all && !isCoordinatorOf(scope, pointId)) throw new BoronganError("Hanya koordinator titik ini yang boleh");
}

export const mintaBahan = action(
  [...PERMS],
  async (fd, user) => {
    const pointId = str(fd, "pointId");
    guard(await boronganScope(prisma, user), pointId);
    const r = await requestPointMaterials(pointId, fd.getAll("itemId").map(String), optStr(fd, "note"), user);
    return `Permintaan ${r.count} bahan terkirim ke Supervisor & tim Assembling`;
  },
  ["/borongan"],
);

export const koreksiStokTitik = action(
  [...PERMS],
  async (fd, user) => {
    const pointId = str(fd, "pointId");
    guard(await boronganScope(prisma, user), pointId);
    const raw = str(fd, "counted").replace(/\./g, "").replace(",", ".");
    const r = await correctPointStock(pointId, str(fd, "itemId"), raw === "" ? NaN : Number(raw), str(fd, "reason"), user);
    return r.diff === 0 ? "Stok sudah sesuai, tidak ada perubahan" : `Stok dikoreksi ${r.diff > 0 ? "+" : ""}${r.diff.toLocaleString("id-ID")}`;
  },
  ["/borongan", "/stok"],
);

/** Reject bahan pendukung di titik (cat cair, plastik klip, plastik OPP): jumlah + alasan */
export const rejectBahanTitik = action(
  [...PERMS],
  async (fd, user) => {
    const pointId = str(fd, "pointId");
    guard(await boronganScope(prisma, user), pointId);
    const raw = str(fd, "qty").replace(/\./g, "").replace(",", ".");
    await reportMaterialReject(pointId, str(fd, "itemId"), raw === "" ? NaN : Number(raw), str(fd, "reason"), optStr(fd, "note"), user);
    return "Reject bahan tercatat, stok titik berkurang";
  },
  ["/borongan", "/stok"],
);
