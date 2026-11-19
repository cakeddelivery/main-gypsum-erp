import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { addMonths, canonical, contractEnd, contractNumber, documentHash, fillClauses, parseClauses, DEFAULT_CLAUSES } from "@/lib/contractTemplate";
import { createAddendum, createContract, employeeSign, hrdSign, updateDraft, verifyContract, voidContract } from "@/lib/contract";
import { effectivePermissions } from "@/lib/rbac";
import { dateOnly } from "@/lib/time";

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const PNG = "data:image/png;base64," + "iVBORw0KGgo".repeat(200);

describe("Kontrak digital: bagian murni", () => {
  it("nomor surat {urut 3 digit}/MG-HRD/{jenis}/{bulan romawi}/{tahun}", () => {
    expect(contractNumber(12, "PKWT", "2026-11-20")).toBe("012/MG-HRD/PKWT/XI/2026");
    expect(contractNumber(1, "ADD", "2027-01-05")).toBe("001/MG-HRD/ADD/I/2027");
    expect(contractNumber(1234, "PKWT", "2026-12-01")).toBe("1234/MG-HRD/PKWT/XII/2026");
  });
  it("tanggal selesai = mulai + n bulan − 1 hari", () => {
    expect(contractEnd("2026-12-01", 6)).toBe("2027-05-31");
    expect(contractEnd("2026-12-01", 2)).toBe("2027-01-31");
    expect(contractEnd("2026-12-15", 12)).toBe("2027-12-14");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
  });
  it("hash stabil terhadap urutan kunci; berubah bila isi berubah", () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
    const d = { number: "001/MG-HRD/PKWT/XI/2026", kind: "PKWT", startDate: "2026-12-01", endDate: "2027-05-31", snapshot: { pay: { gaji: 1000000 }, x: 1 } };
    expect(documentHash(d)).toBe(documentHash({ ...d, snapshot: { x: 1, pay: { gaji: 1000000 } } }));
    expect(documentHash(d)).not.toBe(documentHash({ ...d, snapshot: { x: 1, pay: { gaji: 1000001 } } }));
  });
  it("penanda pasal diisi; template tidak valid ditolak", () => {
    const f = fillClauses([{ title: "Pasal {nama}", body: "{masa} / {tidak_ada}" }], { nama: "Budi", masa: "6 bulan" });
    expect(f[0]).toEqual({ title: "Pasal Budi", body: "6 bulan / {tidak_ada}" });
    expect(parseClauses(DEFAULT_CLAUSES)).toHaveLength(DEFAULT_CLAUSES.length);
    expect(parseClauses([{ title: "", body: "x" }])).toBeNull();
    expect(parseClauses([])).toBeNull();
  });
  it("izin hrd.manage: Owner & Finance punya; role lapangan tidak", () => {
    expect(effectivePermissions("OWNER", []).has("hrd.manage")).toBe(true);
    expect(effectivePermissions("FINANCE", []).has("hrd.manage")).toBe(true);
    expect(effectivePermissions("OPERATOR", []).has("hrd.manage")).toBe(false);
    expect(effectivePermissions("SUPERVISOR", []).has("hrd.manage")).toBe(false);
  });
});

describe("Kontrak digital: alur dengan database", () => {
  async function emp(code: string) {
    const div = await prisma.division.findFirstOrThrow({ where: { active: true } });
    const e = await prisma.employee.create({ data: { code: `KTR-${code}-${tag}`, name: `Kontrak ${code} ${tag}`, divisionId: div.id, joinDate: dateOnly("2026-10-10"), monthlySalary: BigInt(1_000_000), address: "Lamongan", nik: "3524010101010001" } });
    await prisma.employeeAllowance.create({ data: { employeeId: e.id, name: "transport", amount: BigInt(150_000), payDay: 15 } });
    const u = await prisma.user.create({ data: { username: `ktr-${code.toLowerCase()}-${tag.toLowerCase()}`, name: e.name, role: "OPERATOR", passwordHash: "x", employeeId: e.id } });
    return { e, actor: { id: u.id, name: u.name, role: u.role, employeeId: e.id } };
  }
  const hrd = { id: "hrd-test", name: "Nur HRD", role: "FINANCE" as const, employeeId: null };
  const draft = { months: 6, start: "2026-12-01" };

  it("draf → TTD HRD → TTD karyawan → TERKUNCI; verifikasi publik; tidak bisa diubah/dibatalkan/ditandatangani ulang", async () => {
    const { e, actor } = await emp("A");
    const c = await createContract(hrd, { employeeId: e.id, ...draft });
    expect(c.number).toMatch(/^\d{3,}\/MG-HRD\/PKWT\/[IVX]+\/\d{4}$/);
    expect(c.status).toBe("DRAFT");
    const snap = c.snapshot as { pay: { baseSalary: number; allowances: { name: string; amount: number; payDay: number }[]; bpjs: { covered: boolean } }; term: { end: string } };
    expect(snap.pay.baseSalary).toBe(1_000_000);
    expect(snap.pay.allowances).toEqual([{ name: "transport", amount: 150000, payDay: 15 }]);
    expect(snap.pay.bpjs.covered).toBe(true);
    expect(snap.term.end).toBe("2027-05-31");
    expect(await verifyContract(c.verifyCode)).toBeNull(); // draf belum bisa diverifikasi

    await expect(employeeSign(actor, c.id, { signature: PNG })).rejects.toThrow(/belum ditandatangani HRD/);
    await updateDraft(hrd, c.id, { ...draft, months: 12 });
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).months).toBe(12);
    const hash = await hrdSign(hrd, c.id);
    await expect(updateDraft(hrd, c.id, draft)).rejects.toThrow(/Hanya draf/);
    await expect(hrdSign(hrd, c.id)).rejects.toThrow(/sudah ditandatangani/);

    const v1 = await verifyContract(c.verifyCode);
    expect(v1).toMatchObject({ status: "HRD_TTD", intact: true, contentHash: hash });
    await expect(employeeSign({ ...actor, employeeId: "lain" }, c.id, { signature: PNG })).rejects.toThrow(/yang bersangkutan/);
    await expect(employeeSign(actor, c.id, { signature: "data:image/png;base64,AAAA" })).rejects.toThrow(/terlalu singkat/);
    await expect(employeeSign(actor, c.id, { signature: "javascript:alert(1)" })).rejects.toThrow(/tidak valid/);

    const finalHash = await employeeSign(actor, c.id, { signature: PNG, device: "Chrome HP" });
    const locked = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect([locked.status, locked.finalHash, !!locked.lockedAt, locked.employeeDevice]).toEqual(["AKTIF", finalHash, true, "Chrome HP"]);
    await expect(employeeSign(actor, c.id, { signature: PNG })).rejects.toThrow(/terkunci/);
    await expect(voidContract(hrd, c.id, "salah")).rejects.toThrow(/terkunci/);
    await expect(updateDraft(hrd, c.id, draft)).rejects.toThrow(/Hanya draf/);
    expect(await verifyContract(c.verifyCode)).toMatchObject({ status: "AKTIF", intact: true, finalHash });

    // snapshot diubah langsung di DB (pemalsuan) → verifikasi mendeteksi
    await prisma.contract.update({ where: { id: c.id }, data: { snapshot: { ...(locked.snapshot as object), pay: { baseSalary: 9_999_999 } } } });
    expect((await verifyContract(c.verifyCode))!.intact).toBe(false);
  });

  it("nomor unik walau dibuat bersamaan (pencacah atomik)", async () => {
    const people = await Promise.all(["B1", "B2", "B3", "B4", "B5", "B6"].map(emp));
    const made = await Promise.all(people.map((p) => createContract(hrd, { employeeId: p.e.id, ...draft })));
    const nums = made.map((c) => c.number);
    expect(new Set(nums).size).toBe(nums.length);
    const seqs = made.map((c) => c.seq).sort((a, b) => a - b);
    expect(seqs[seqs.length - 1] - seqs[0]).toBe(seqs.length - 1); // berurutan tanpa celah
  });

  it("tidak boleh dobel draf / tumpang tindih kontrak berlaku; validasi NIK, gaji, lama kontrak", async () => {
    const { e, actor } = await emp("C");
    await expect(createContract(hrd, { employeeId: e.id, months: 5, start: "2026-12-01" })).rejects.toThrow(/Lama kontrak/);
    await expect(createContract(hrd, { employeeId: e.id, ...draft, nik: "123" })).rejects.toThrow(/NIK/);
    await expect(createContract(hrd, { employeeId: e.id, ...draft, baseSalary: 0 })).rejects.toThrow(/Gaji pokok/);
    const c = await createContract(hrd, { employeeId: e.id, ...draft });
    await expect(createContract(hrd, { employeeId: e.id, ...draft })).rejects.toThrow(/belum selesai/);
    await hrdSign(hrd, c.id);
    await employeeSign(actor, c.id, { signature: PNG });
    await expect(createContract(hrd, { employeeId: e.id, months: 6, start: "2027-03-01" })).rejects.toThrow(/masih berlaku/);
    // setelah berakhir → boleh perpanjang
    const next = await createContract(hrd, { employeeId: e.id, months: 6, start: "2027-06-01" });
    expect(next.number).not.toBe(c.number);
  });

  it("addendum bernomor untuk kontrak terkunci; kontrak sendiri tidak boleh ditandatangani HRD yang sama", async () => {
    const { e, actor } = await emp("D");
    const c = await createContract(hrd, { employeeId: e.id, ...draft });
    await expect(createAddendum(hrd, c.id, { text: "ubah gaji", start: "2027-01-01" })).rejects.toThrow(/terkunci/);
    await expect(hrdSign({ ...actor, role: "FINANCE" }, c.id)).rejects.toThrow(/HRD lain/);
    await hrdSign(hrd, c.id);
    await employeeSign(actor, c.id, { signature: PNG });
    const a = await createAddendum(hrd, c.id, { text: "Gaji pokok naik.", start: "2027-01-01", baseSalary: 1_200_000 });
    expect(a.number).toMatch(/\/MG-HRD\/ADD\//);
    expect(a.parentId).toBe(c.id);
    expect((a.snapshot as { pay: { baseSalary: number } }).pay.baseSalary).toBe(1_200_000);
    await expect(createAddendum(hrd, c.id, { text: "Perubahan lagi.", start: "2027-02-01" })).rejects.toThrow(/belum selesai/);
    await hrdSign(hrd, a.id);
    await employeeSign(actor, a.id, { signature: PNG });
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("AKTIF");
  });
});
