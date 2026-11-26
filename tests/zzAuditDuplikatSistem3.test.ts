import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), getUser: vi.fn(async () => ({ id: "u", name: "Uji", can: () => true })) }));
const enq: string[] = [];
vi.mock("@/lib/returnVideo", () => ({ enqueueVideo: vi.fn((id: string) => { enq.push(id); return Promise.resolve(); }) }));

import { prisma } from "@/lib/db";
import { mediaStore } from "@/lib/mediaStore";
import { POST as framePost } from "@/app/api/retur/[id]/frame/route";
import { POST as finishPost } from "@/app/api/retur/media/[mediaId]/route";

const R = Math.random().toString(36).slice(2, 8);
const jpeg = () => new Request("http://x", { method: "POST", body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]) });

describe("audit duplikat sistem 3 (retur media)", () => {
  it("frame paralel: hanya satu THUMB, FRAME maksimal 12", async () => {
    const ret = await prisma.returnCase.create({ data: { number: `RT-UJI-${R}`, receivedAt: new Date(), trackingNo: `T${R}`, createdBy: "uji" } });
    await Promise.all(Array.from({ length: 20 }, () => framePost(jpeg(), { params: Promise.resolve({ id: ret.id }) })));
    expect(await prisma.returnMedia.count({ where: { returnId: ret.id, kind: "THUMB" } })).toBe(1);
    expect(await prisma.returnMedia.count({ where: { returnId: ret.id, kind: "FRAME" } })).toBeLessThanOrEqual(12);
  });

  it("selesai rekam dikirim 2x paralel: pemrosesan dimulai sekali", async () => {
    const ret = await prisma.returnCase.create({ data: { number: `RT-UJI2-${R}`, receivedAt: new Date(), trackingNo: `U${R}`, createdBy: "uji" } });
    const key = mediaStore.newKey("retur", "webm");
    await mediaStore.append(key, Buffer.alloc(100, 1), 0);
    const m = await prisma.returnMedia.create({ data: { returnId: ret.id, kind: "VIDEO", status: "UPLOADING", storageKey: key, mime: "video/webm", createdBy: "uji" } });
    enq.length = 0;
    const call = () => finishPost(new Request("http://x", { method: "POST", body: JSON.stringify({ total: 100, durationSec: 3 }) }), { params: Promise.resolve({ mediaId: m.id }) });
    await Promise.all([call(), call(), call()]);
    expect(enq).toEqual([m.id]);
  });
});
