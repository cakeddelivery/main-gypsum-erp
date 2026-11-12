import { beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { approveRegistration, createInvite, disableInvite, normalizePhone, registrationLoginHint, rejectRegistration, REG_BAD_CODE_MAX, submitRegistration, validInvite } from "@/lib/registration";

let actor: { id: string; name: string };
let divisionId: string;
const tag = Date.now().toString(36).slice(-5);
const form = (n: string, extra: Record<string, string> = {}) => ({
  fullName: `Calon Karyawan ${n}`, nickname: `Calon${n}`, birthPlace: "Lamongan", birthDate: "2001-05-17", address: "Jl. Uji No. 1 RT 01 RW 02, Lamongan",
  phone: "0812-3456-7890", email: `calon${n}${tag}@contoh.id`, username: `calon${n}${tag}`, password: "rahasia123", gender: "P" as const,
  startDate: "2027-01-02", bankName: "BCA", bankAccountNo: "9012 3456 7890", bankAccountName: `Calon ${n}`, ...extra,
});

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  divisionId = (await prisma.division.findFirstOrThrow({ where: { active: true } })).id;
});

describe("Pendaftaran karyawan", () => {
  it("nomor WhatsApp dirapikan ke 62…", () => {
    expect(normalizePhone("0812-3456-7890")).toBe("6281234567890");
    expect(normalizePhone("+62 812 3456 7890")).toBe("6281234567890");
    expect(() => normalizePhone("12345")).toThrow(/WhatsApp/);
  });

  it("tanpa tautan valid ditolak, IP dibatasi; tautan dimatikan tidak berlaku", async () => {
    const ip = `10.9.${tag.length}.1`;
    for (let i = 0; i < REG_BAD_CODE_MAX; i++) await expect(submitRegistration("salah", form("x"), ip)).rejects.toThrow(/tidak berlaku/);
    await expect(submitRegistration("salah", form("x"), ip)).rejects.toThrow(/Terlalu banyak/);
    const { invite, code } = await createInvite(7, "uji", actor);
    expect(await validInvite(code)).not.toBeNull();
    await disableInvite(invite.id, actor);
    expect(await validInvite(code)).toBeNull();
  });

  it("daftar → menunggu (belum bisa login) → disetujui: karyawan + akun aktif dengan password pendaftar", async () => {
    const { code } = await createInvite(7, null, actor);
    const r = await submitRegistration(code, form("a"), "10.1.1.1");
    expect(r.status).toBe("MENUNGGU");
    expect(r.phone).toBe("6281234567890");
    expect(r.bankAccountNo).toBe("901234567890");
    expect(r.bankName).toBe("BCA");
    expect(await registrationLoginHint(r.username)).toMatch(/menunggu verifikasi/);
    // Username & email tidak boleh dobel dengan pendaftaran yang masih menunggu
    await expect(submitRegistration(code, form("b", { username: r.username }), "10.1.1.2")).rejects.toThrow(/Username sudah dipakai/);
    await expect(submitRegistration(code, form("b", { email: r.email }), "10.1.1.2")).rejects.toThrow(/Email sudah terdaftar/);
    await expect(submitRegistration(code, form("b", { username: "owner" }), "10.1.1.2")).rejects.toThrow(/Username sudah dipakai/);

    await expect(approveRegistration(r.id, { divisionId, role: "OPERATOR", wageType: "BULANAN", monthlySalary: 0, dailyRate: 0, joinDate: "2027-01-02", bpjsTk: false, bpjsTkAmount: null }, actor)).rejects.toThrow(/gaji bulanan/);
    const ok = await approveRegistration(r.id, { divisionId, role: "OPERATOR", wageType: "HARIAN", monthlySalary: 0, dailyRate: 60_000, joinDate: "2027-01-03", bpjsTk: true, bpjsTkAmount: null }, actor);
    expect(ok.employee.nickname).toBe("Calona");
    expect(ok.employee.bpjsTk).toBe(true);
    expect(ok.employee.bankName).toBe("BCA");
    expect(ok.user.active).toBe(true);
    expect(await bcrypt.compare("rahasia123", ok.user.passwordHash)).toBe(true);
    expect(await registrationLoginHint(r.username)).toBeNull();
    await expect(approveRegistration(r.id, { divisionId, role: "OPERATOR", wageType: "HARIAN", monthlySalary: 0, dailyRate: 60_000, joinDate: "2027-01-03", bpjsTk: false, bpjsTkAmount: null }, actor)).rejects.toThrow(/sudah disetujui/);
  });

  it("ditolak dengan alasan; data tetap tersimpan", async () => {
    const { code } = await createInvite(3, null, actor);
    const r = await submitRegistration(code, form("c"), "10.1.1.3");
    await expect(rejectRegistration(r.id, " ", actor)).rejects.toThrow(/Alasan/);
    await rejectRegistration(r.id, "Lowongan sudah terisi", actor);
    expect((await prisma.employeeRegistration.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("DITOLAK");
    expect(await registrationLoginHint(r.username)).toMatch(/ditolak/);
  });
});
