import { prisma } from "./db";
import { boronganScope, canTask, pointCapacity } from "./borongan";
import { pointConfig } from "./boronganSetup";

type User = Parameters<typeof boronganScope>[1];

/** Data form setoran borongan (#93) untuk satu divisi: titik, pekerja, dan tugas yang boleh dicatat user ini */
export async function setoranData(user: User, divisionId: string) {
  const scope = await boronganScope(prisma, user);
  const [points, cfg, tasks] = await Promise.all([
    prisma.boronganPoint.findMany({ where: { active: true, ...(scope.all ? {} : { id: { in: scope.pointIds } }) }, orderBy: { code: "asc" }, select: { id: true, name: true, locationId: true } }),
    pointConfig(prisma),
    prisma.pieceTask.findMany({ where: { active: true, divisionId }, orderBy: { name: "asc" } }),
  ]);
  const workers = await prisma.boronganPerson.findMany({ where: { role: "PEKERJA", active: true, pointId: { in: points.map((p) => p.id) } }, orderBy: { name: "asc" }, select: { id: true, name: true, pointId: true, taskIds: true } });
  const allowed = tasks.filter((t) => canTask(scope, t.id));
  return {
    points: points.map((p) => ({ id: p.id, name: p.name })),
    capacity: await pointCapacity(points, allowed.map((t) => t.id)),
    workers: workers.map((w) => ({ id: w.id, name: w.name, pointId: w.pointId!, taskIds: w.taskIds })),
    tasks: allowed.map((x) => ({ id: x.id, name: x.name, workerRate: Number(x.workerRate), coordinatorRate: Number(x.coordinatorRate), driverRate: Number(x.driverRate) })),
    pointTasks: Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, v.tasks])),
  };
}
