"use server";
import { action, int, optStr, str } from "@/lib/action";
import { redirect } from "next/navigation";
import { createTermination, issueTermination, voidTermination } from "@/lib/termination";
import { MAX_PROOF_BYTES, MAX_PROOF_TEXT, saveProof } from "@/lib/storage";
import { sniffMime } from "@/lib/imageCompress";

const actor = (u: { id: string; name: string; role: import("@prisma/client").Role; employeeId: string | null }) => ({ id: u.id, name: u.name, role: u.role, employeeId: u.employeeId });

export const createTerminationAction = action(
  "hrd.manage",
  async (fd, user) => {
    const file = fd.get("evidence");
    let evidencePath: string | null = null;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_PROOF_BYTES) throw new Error(MAX_PROOF_TEXT);
      const buf = Buffer.from(await file.arrayBuffer());
      const mime = sniffMime(buf);
      if (!mime || (!mime.startsWith("image/") && mime !== "application/pdf")) throw new Error("Lampiran harus foto atau PDF");
      evidencePath = await saveProof(buf, mime);
    }
    const t = await createTermination(actor(user), { employeeId: str(fd, "employeeId"), reason: str(fd, "reason"), effective: str(fd, "effective"), damage: int(fd, "damage"), note: optStr(fd, "note"), evidencePath });
    redirect(`/kontrak/pengakhiran/${t.id}`);
  },
  ["/kontrak"],
);

export const issueTerminationAction = action(
  "hrd.manage",
  async (fd, user) => {
    await issueTermination(actor(user), str(fd, "id"), { confirmValue: str(fd, "confirmValue") === "1" });
    return "Surat diterbitkan (ditandatangani HRD dengan QR). Tanggal berhenti karyawan sudah diatur.";
  },
  ["/kontrak"],
);

export const voidTerminationAction = action(
  "hrd.manage",
  async (fd, user) => {
    await voidTermination(actor(user), str(fd, "id"), str(fd, "reason"));
    return "Pengakhiran dibatalkan";
  },
  ["/kontrak"],
);
