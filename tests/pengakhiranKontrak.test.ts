import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { finalPay, fullMonths } from "@/lib/terminationCalc";
import { createContract, employeeSign, hrdSign } from "@/lib/contract";
import { createTermination, issueTermination, verifyTermination, voidTermination } from "@/lib/termination";
import { dateOnly } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const PNG = "data:image/png;base64," + "iVBORw0KGgo".repeat(200);
const base = { baseSalary: 1_000_000, allowanceTotal: 150_000, joinDate: "2026-10-10", contractStart: "2026-11-01", contractEnd: "2027-04-30", alpaDays: 0 };
const line = (r: ReturnType<typeof finalPay>, k: string) => r.lines.find((l) => l.key === k);

describe("Slip akhir pengakhiran kontrak (murni)", () => {
  it("bulan penuh masa kerja", () => {
    expect(fullMonths("2026-11-01", "2027-04-30")).toBe(6);
    expect(fullMonths("2026-11-01", "2026-11-29")).toBe(0);
    expect(fullMonths("2026-11-01", "2027-01-15")).toBe(2);
  });
  it("resign sebelum kontrak habis: ganti rugi = gaji pokok, dikompensasi dengan upah terutang (bukan dihapus diam-diam)", () => {
    const r = finalPay({ ...base, reason: "RESIGN", effective: "2026-11-19" });
    expect(r.worked).toBe(10);
    expect(line(r, "upah")!.amount).toBe(333_333);
    expect(line(r, "ganti_rugi")).toMatchObject({ amount: 1_000_000, kind: "info" });
    expect(line(r, "kompensasi")).toMatchObject({ amount: 333_333, kind: "minus" });
    expect(r.net).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/Sisa ganti rugi Rp 666\.667/);
  });
  it("Alpa mengurangi upah hari kerja", () => {
    const r = finalPay({ ...base, reason: "KONTRAK_HABIS", effective: "2027-04-30", alpaDays: 2 });
    expect(line(r, "alpa")!.amount).toBe(66_667);
  });
  it("pelanggaran berat: potongan kerugian terbukti maksimal 50% upah", () => {
    const r = finalPay({ ...base, reason: "PELANGGARAN_BERAT", effective: "2026-11-19", damage: 500_000 });
    expect(line(r, "kerusakan")!.amount).toBe(166_666);
    expect(r.net).toBe(166_667);
    expect(r.warnings.join(" ")).toMatch(/melebihi batas 50%/);
    expect(finalPay({ ...base, reason: "PELANGGARAN_BERAT", effective: "2026-11-19", damage: 100_000 }).net).toBe(233_333);
  });
  it("kontrak habis: kompensasi PKWT = bulan ÷ 12 × (gaji pokok + tunjangan)", () => {
    const r = finalPay({ ...base, reason: "KONTRAK_HABIS", effective: "2027-04-30" });
    expect(line(r, "kompensasi_pkwt")!.amount).toBe(575_000);
    expect(r.net).toBe(700_000 + 575_000);
    // kurang dari 1 bulan: tidak ada kompensasi
    expect(line(finalPay({ ...base, reason: "KONTRAK_HABIS", effective: "2026-11-20" }), "kompensasi_pkwt")).toBeUndefined();
  });
  it("diputus tanpa kesalahan: kompensasi PKWT + ganti rugi sisa kontrak (Pasal 62) + peringatan nilai", () => {
    const r = finalPay({ ...base, reason: "DIPUTUS_PERUSAHAAN", effective: "2027-01-15" });
    expect(line(r, "kompensasi_pkwt")!.amount).toBe(191_667);
    expect(line(r, "sisa_kontrak")!.amount).toBe(3_500_000);
    expect(r.warnings.join(" ")).toMatch(/periksa nilainya/);
  });
});

describe("Pengakhiran kontrak: alur database", () => {
  const hrd = { id: "hrd-t", name: "HRD Uji", role: "FINANCE" as const, employeeId: null };
  async function signedEmployee(code: string) {
    const div = await prisma.division.findFirstOrThrow({ where: { active: true } });
    const e = await prisma.employee.create({ data: { code: `PHK-${code}-${tag}`, name: `Phk ${code} ${tag}`, divisionId: div.id, joinDate: dateOnly("2026-10-10"), monthlySalary: BigInt(1_000_000), address: "Lamongan", nik: "3524010101010001" } });
    const u = await prisma.user.create({ data: { username: `phk-${code.toLowerCase()}-${tag.toLowerCase()}`, name: e.name, role: "OPERATOR", passwordHash: "x", employeeId: e.id } });
    const c = await createContract(hrd, { employeeId: e.id, months: 6, start: "2026-11-01" });
    await hrdSign(hrd, c.id);
    await employeeSign({ id: u.id, name: u.name, role: u.role, employeeId: e.id }, c.id, { signature: PNG });
    return e;
  }

  it("draf → terbitkan (hash, QR, tanggal berhenti) → verifikasi publik; konfirmasi nilai wajib untuk diputus perusahaan; batal", async () => {
    const e = await signedEmployee("A");
    await expect(createTermination(hrd, { employeeId: e.id, reason: "PELANGGARAN_BERAT", effective: "2026-11-19" })).rejects.toThrow(/wajib disertai bukti/);
    const t = await createTermination(hrd, { employeeId: e.id, reason: "DIPUTUS_PERUSAHAAN", effective: "2027-01-15", note: "Efisiensi" });
    expect(t.number).toMatch(/\/MG-HRD\/PHK\/[IVX]+\/\d{4}$/);
    await expect(createTermination(hrd, { employeeId: e.id, reason: "RESIGN", effective: "2027-01-15" })).rejects.toThrow(/Sudah ada pengakhiran/);
    expect(await verifyTermination(t.verifyCode)).toBeNull(); // draf belum bisa diverifikasi
    await expect(issueTermination(hrd, t.id)).rejects.toThrow(/centang konfirmasi/);
    const hash = await issueTermination(hrd, t.id, { confirmValue: true });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).resignDate?.toISOString().slice(0, 10)).toBe("2027-01-15");
    expect(await verifyTermination(t.verifyCode)).toMatchObject({ status: "DITERBITKAN", intact: true, contentHash: hash, employee: e.name });
    await expect(issueTermination(hrd, t.id, { confirmValue: true })).rejects.toThrow(/sudah diterbitkan/);
    await voidTermination(hrd, t.id, "salah input");
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).resignDate).toBeNull();
    expect((await verifyTermination(t.verifyCode))!.status).toBe("BATAL");
  });

  it("nomor unik bersamaan dengan kontrak; karyawan tanpa kontrak terkunci ditolak", async () => {
    const div = await prisma.division.findFirstOrThrow({ where: { active: true } });
    const none = await prisma.employee.create({ data: { code: `PHK-N-${tag}`, name: `Tanpa Kontrak ${tag}`, divisionId: div.id } });
    await expect(createTermination(hrd, { employeeId: none.id, reason: "RESIGN", effective: "2026-12-01" })).rejects.toThrow(/belum punya kontrak/);
    const es = await Promise.all(["B1", "B2", "B3"].map(signedEmployee));
    const ts = await Promise.all(es.map((e) => createTermination(hrd, { employeeId: e.id, reason: "RESIGN", effective: "2026-12-01" })));
    expect(new Set(ts.map((t) => t.number)).size).toBe(3);
  });
});
