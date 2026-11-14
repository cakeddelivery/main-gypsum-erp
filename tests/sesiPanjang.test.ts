import { describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { prisma } from "@/lib/db";
import { createSessionToken, loadUser, revokeAllSessions, verifySessionToken } from "@/lib/auth";
import { RENEW_WHEN_LEFT_DAYS, SESSION_DAYS, needsRenewal, sessionCookieOptions } from "@/lib/session";

const DAY = 86_400;

describe("Sesi login panjang (rolling)", () => {
  it("token & cookie berlaku 90 hari, cookie httpOnly + SameSite=Lax", async () => {
    const t = await createSessionToken("u-uji", 3);
    const p = decodeJwt(t);
    expect(p.exp! - p.iat!).toBe(SESSION_DAYS * DAY);
    expect(await verifySessionToken(t)).toEqual({ userId: "u-uji", sv: 3 });
    expect(sessionCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_DAYS * DAY });
  });

  it("diperpanjang hanya bila sisa < 30 hari", () => {
    const now = 1_800_000_000;
    expect(needsRenewal(now + 89 * DAY, now)).toBe(false);
    expect(needsRenewal(now + (RENEW_WHEN_LEFT_DAYS + 1) * DAY, now)).toBe(false);
    expect(needsRenewal(now + (RENEW_WHEN_LEFT_DAYS - 1) * DAY, now)).toBe(true);
    expect(needsRenewal(undefined, now)).toBe(false);
  });

  it("Keluarkan semua perangkat: token lama ditolak, password tetap; akun nonaktif juga ditolak", async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "operator" } });
    expect(await loadUser(u.id, u.sessionVersion)).not.toBeNull();
    const after = await revokeAllSessions(u.id, { id: owner.id, name: owner.name });
    expect(after.sessionVersion).toBe(u.sessionVersion + 1);
    expect(after.passwordHash).toBe(u.passwordHash);
    expect(await loadUser(u.id, u.sessionVersion)).toBeNull();
    expect(await loadUser(u.id, after.sessionVersion)).not.toBeNull();
    await prisma.user.update({ where: { id: u.id }, data: { active: false } });
    expect(await loadUser(u.id, after.sessionVersion)).toBeNull();
    await prisma.user.update({ where: { id: u.id }, data: { active: true } });
    expect((await loadUser(u.id, after.sessionVersion))?.email).toBeDefined();
  });
});
