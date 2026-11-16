import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { buildReminders, dueSlot, onDuty, planReminders, type Att, type DivStatus, type Member } from "@/lib/pushReminders";
import { safeUrl, saveSubscription, sendPush } from "@/lib/push";
import { jakartaDateTime } from "@/lib/time";


describe("Jadwal pengingat push", () => {
  it("12.00 dan 15.00 WIB, masing-masing jendela 3 jam", () => {
    expect(dueSlot(11 * 60 + 59)).toBeNull();
    expect(dueSlot(12 * 60)?.label).toBe("12.00");
    expect(dueSlot(14 * 60 + 59)?.label).toBe("12.00");
    expect(dueSlot(15 * 60)?.label).toBe("15.00");
    expect(dueSlot(17 * 60 + 59)?.label).toBe("15.00");
    expect(dueSlot(18 * 60)).toBeNull();
    expect(dueSlot(12 * 60)?.key).not.toBe(dueSlot(15 * 60)?.key);
  });
});

describe("Penerima pengingat push", () => {
  const at = new Date("2027-03-01T03:00:00Z");
  const members: Member[] = [
    { userId: "g1", role: "OPERATOR", divisionId: "GB", employeeId: "e1" }, // sudah absen masuk
    { userId: "g2", role: "OPERATOR", divisionId: "GB", employeeId: "e2" }, // sudah pulang
    { userId: "g3", role: "KAPTEN_DIVISI", divisionId: "GB", employeeId: "e3" }, // belum absen / libur
    { userId: "p1", role: "OPERATOR", divisionId: "PK", employeeId: "e4" },
    { userId: "x1", role: "OPERATOR", divisionId: "PK", employeeId: null }, // akun tanpa data karyawan
    { userId: "spv", role: "SUPERVISOR", divisionId: null, employeeId: "e9" },
  ];
  const atts: Att[] = [
    { employeeId: "e1", checkIn: at, checkOut: null },
    { employeeId: "e2", checkIn: at, checkOut: at },
    { employeeId: "e4", checkIn: at, checkOut: null },
    { employeeId: "e9", checkIn: at, checkOut: null },
  ];
  const divisions: DivStatus[] = [
    { id: "GB", name: "Giftbox", receives: true, receipts: 0, setoran: 3, setoranQty: 120, diterima: 0 },
    { id: "PK", name: "Packing", receives: false, receipts: 2, setoran: 0, setoranQty: 0, diterima: 0 },
  ];

  it("hanya anggota yang sudah absen masuk dan belum pulang; Supervisor/Owner tidak dihitung sebagai anggota", () => {
    expect(onDuty(members, atts).map((m) => m.userId)).toEqual(["g1", "p1"]);
  });

  it("barang masuk ke semua divisi laporan; penerimaan borongan hanya divisi penerima; ringkasan ke Supervisor & Owner", () => {
    const plans = planReminders({ slot: "12.00", divisions, members, atts, managers: ["spv", "own"] });
    const by = (tag: string, ids: string[]) => plans.find((p) => p.payload.tag === tag && p.userIds.join() === ids.join());
    const gbBarang = by("ingat-barang-masuk", ["g1"])!;
    expect(gbBarang.payload.body).toContain("Belum ada barang masuk tercatat hari ini di Giftbox");
    expect(gbBarang.payload.url).toBe("/laporan/buka?f=masuk");
    const gbTerima = by("ingat-penerimaan-borongan", ["g1"])!;
    expect(gbTerima.payload.body).toContain("setoran koordinator 3 catatan (120 pcs), penerimaan divisi 0 → cek selisih");
    expect(gbTerima.payload.url).toBe("/borongan?tab=kiriman");
    expect(by("ingat-barang-masuk", ["p1"])!.payload.body).toContain("Sudah 2 barang masuk");
    expect(by("ingat-penerimaan-borongan", ["p1"])).toBeUndefined();
    const mgr = plans.filter((p) => p.userIds.join() === "spv,own");
    expect(mgr.map((p) => p.payload.tag)).toEqual(["ingat-barang-masuk", "ingat-penerimaan-borongan"]);
    expect(mgr[0].payload.body).toBe("Giftbox: 0 · Packing: 2");
    // Tidak ada yang libur/pulang/tanpa absen yang dikirimi
    const all = new Set(plans.flatMap((p) => p.userIds));
    for (const u of ["g2", "g3", "x1"]) expect(all.has(u)).toBe(false);
  });

  it("divisi tanpa anggota bertugas tidak dikirimi", () => {
    const plans = planReminders({ slot: "15.00", divisions, members, atts: [], managers: [] });
    expect(plans).toEqual([]);
  });

  it("data dari database: Owner menerima ringkasan; tanpa kunci VAPID tidak ada yang dikirim", async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const plans = await buildReminders(jakartaDateTime("2027-03-01", "12:05"), "12.00");
    expect(plans.some((p) => p.userIds.includes(owner.id) && p.payload.tag === "ingat-barang-masuk")).toBe(true);
    await saveSubscription(owner.id, { endpoint: "https://push.example.test/abc", keys: { p256dh: "x", auth: "y" } }, "tes");
    const r = await sendPush([owner.id], { title: "x", body: "y" });
    expect(r.sent).toBe(0);
    await expect(saveSubscription(owner.id, { endpoint: "http://bukan-https", keys: { p256dh: "x", auth: "y" } })).rejects.toThrow(/tidak valid/);
    await prisma.pushSubscription.deleteMany({ where: { endpoint: "https://push.example.test/abc" } });
  });

  it("notifikasi hanya membuka halaman di dalam ERP", () => {
    expect(safeUrl("/laporan/buka?f=masuk")).toBe("/laporan/buka?f=masuk");
    expect(safeUrl("https://evil.example")).toBe("/");
    expect(safeUrl("//evil.example")).toBe("/");
    expect(safeUrl(undefined)).toBe("/");
  });
});
