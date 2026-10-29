import { describe, expect, it } from "vitest";
import { checkGeofence, distanceMeters, readGeo } from "@/lib/attendance";
import { effectivePermissions } from "@/lib/rbac";

const pabrik = { id: "s1", name: "Pabrik", latitude: -7.1167, longitude: 112.4167, radiusM: 100 };
// ~0,0009° lintang ≈ 100 m
const near = { lat: -7.1167 + 0.0005, lng: 112.4167, accuracy: 10 };
const far = { lat: -7.1167 + 0.002, lng: 112.4167, accuracy: 10 };

describe("Geofence absensi", () => {
  it("menghitung jarak haversine", () => {
    expect(Math.round(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }))).toBe(111);
    expect(distanceMeters(near, { lat: pabrik.latitude, lng: pabrik.longitude })).toBeGreaterThan(50);
  });
  it("izinkan di dalam radius, tolak di luar", () => {
    const ok = checkGeofence(near, [pabrik]);
    expect(ok.ok && ok.site?.id).toBe("s1");
    const no = checkGeofence(far, [pabrik]);
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.error).toMatch(/di luar lokasi kerja/);
  });
  it("pilih titik mana pun yang memuat posisi", () => {
    const gudang = { ...pabrik, id: "s2", name: "Gudang", latitude: far.lat, longitude: far.lng };
    const r = checkGeofence(far, [pabrik, gudang]);
    expect(r.ok && r.site?.id).toBe("s2");
  });
  it("wajib GPS & akurasi cukup bila lokasi sudah diatur", () => {
    expect(checkGeofence(null, [pabrik]).ok).toBe(false);
    expect(checkGeofence({ ...near, accuracy: 500 }, [pabrik]).ok).toBe(false);
  });
  it("belum ada lokasi = absen bebas", () => {
    expect(checkGeofence(null, []).ok).toBe(true);
  });
  it("membaca koordinat dari form", () => {
    const fd = new FormData();
    fd.set("lat", "-7.1");
    fd.set("lng", "112.4");
    fd.set("accuracy", "12");
    expect(readGeo(fd)).toEqual({ lat: -7.1, lng: 112.4, accuracy: 12 });
    fd.set("lat", "");
    expect(readGeo(fd)).toBeNull();
    fd.set("lat", "120");
    expect(readGeo(fd)).toBeNull();
  });
});

describe("Hak akses lokasi absen", () => {
  it("hanya Owner, Admin, Supervisor", () => {
    for (const r of ["OWNER", "ADMIN", "SUPERVISOR"] as const) expect(effectivePermissions(r, []).has("attendance.location")).toBe(true);
    for (const r of ["FINANCE", "ADMIN_PRODUKSI", "KAPTEN_DIVISI", "OPERATOR"] as const)
      expect(effectivePermissions(r, [{ role: r, permission: "attendance.location", allowed: true }]).has("attendance.location")).toBe(false);
  });
});
