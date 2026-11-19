"use server";
import { action, int, optStr, str } from "@/lib/action";
import { addendumArgs } from "./args";
import { createAddendum, createContract, employeeSign, hrdSign, saveContractSettings, updateDraft, voidContract } from "@/lib/contract";

const actor = (u: { id: string; name: string; role: import("@prisma/client").Role; employeeId: string | null }) => ({ id: u.id, name: u.name, role: u.role, employeeId: u.employeeId });

const draftInput = (fd: FormData) => ({
  months: int(fd, "months"),
  start: str(fd, "start"),
  baseSalary: str(fd, "baseSalary") ? int(fd, "baseSalary") : undefined,
  nik: optStr(fd, "nik"),
  address: optStr(fd, "address"),
});

export const createContractAction = action(
  "hrd.manage",
  async (fd, user) => {
    const c = await createContract(actor(user), { employeeId: str(fd, "employeeId"), ...draftInput(fd) });
    return `Draf kontrak ${c.number} dibuat`;
  },
  ["/kontrak"],
);

export const updateDraftAction = action(
  "hrd.manage",
  async (fd, user) => {
    await updateDraft(actor(user), str(fd, "id"), draftInput(fd));
    return "Draf kontrak diperbarui";
  },
  ["/kontrak"],
);

export const hrdSignAction = action(
  "hrd.manage",
  async (fd, user) => {
    await hrdSign(actor(user), str(fd, "id"));
    return "Kontrak ditandatangani HRD. Menunggu tanda tangan karyawan.";
  },
  ["/kontrak"],
);

export const employeeSignAction = action(
  "payroll.self",
  async (fd, user) => {
    await employeeSign(actor(user), str(fd, "id"), { signature: str(fd, "signature"), device: str(fd, "device") });
    return "Kontrak ditandatangani dan terkunci. Terima kasih.";
  },
  ["/kontrak"],
);

export const voidContractAction = action(
  "hrd.manage",
  async (fd, user) => {
    await voidContract(actor(user), str(fd, "id"), str(fd, "reason"));
    return "Kontrak dibatalkan";
  },
  ["/kontrak"],
);

export const addendumAction = action(
  "hrd.manage",
  async (fd, user) => {
    const a = addendumArgs(fd);
    const c = await createAddendum(actor(user), str(fd, "id"), a);
    return `Draf addendum ${c.number} dibuat`;
  },
  ["/kontrak"],
);

export const saveContractSettingsAction = action(
  "hrd.manage",
  async (fd, user) => {
    const titles = fd.getAll("clauseTitle").map(String);
    const bodies = fd.getAll("clauseBody").map(String);
    const clauses = titles.map((title, i) => ({ title, body: bodies[i] ?? "" })).filter((c) => c.title.trim() || c.body.trim());
    await saveContractSettings(actor(user), { clauses, durations: str(fd, "durations"), resignDays: int(fd, "resignDays", 30), hrdName: str(fd, "hrdName"), hrdTitle: str(fd, "hrdTitle"), bpjsSince: str(fd, "bpjsSince") });
    return "Pengaturan kontrak tersimpan";
  },
  ["/kontrak"],
);
