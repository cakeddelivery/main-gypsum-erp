import { prisma } from "./db";
import { boronganScope, canTask } from "./borongan";
import { pointConfig } from "./boronganSetup";

type User = Parameters<typeof boronganScope>[1];

/** Data form setoran borongan (#93) untuk satu divisi: titik, pekerja, dan tugas yang boleh dicatat user ini */
export async function setoranData(user: User, divisionId: string) {
  const scope = await boronganScope(prisma, user);
  const [points, cfg, tasks] = await Promise.all([
    prisma.boronganPoint.findMany({ where: { active: true, ...(scope.all ? {} : { id: { in: scope.pointIds } }) }, orderBy: { code: "asc" }, select: { id: true, name: true } }),
    pointConfig(prisma),
    prisma.pieceTask.findMany({ where: { active: true, divisionId }, orderBy: { name: "asc" } }),
  ]);
  const workers = await prisma.boronganPerson.findMany({ where: { role: "PEKERJA", active: true, pointId: { in: points.map((p) => p.id) } }, orderBy: { name: "asc" }, select: { id: true, name: true, pointId: true, taskIds: true } });
  return {
    points,
    workers: workers.map((w) => ({ id: w.id, name: w.name, pointId: w.pointId!, taskIds: w.taskIds })),
    tasks: tasks.filter((t) => canTask(scope, t.id)).map((x) => ({ id: x.id, name: x.name, workerRate: Number(x.workerRate), coordinatorRate: Number(x.coordinatorRate), driverRate: Number(x.driverRate) })),
    pointTasks: Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, v.tasks])),
  };
}
