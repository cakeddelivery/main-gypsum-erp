import { prisma } from "@/lib/db";
import { boronganScope, coordinatorsAt } from "@/lib/borongan";
import { canRequestClaim } from "@/lib/boronganClaim";
import { isCoordinatorOf } from "@/lib/boronganFlow";

type User = Parameters<typeof boronganScope>[1] & { can: (p: "borongan.pay" | "borongan.manage") => boolean };

/** Rincian klaim: Finance/Owner (borongan.pay), pengelola, koordinator titik itu, atau tim yang boleh mengajukan klaim titik itu */
export async function canSeeClaim(user: User, pointId: string) {
  if (user.can("borongan.pay")) return true;
  const scope = await boronganScope(prisma, user);
  if (scope.all || isCoordinatorOf(scope, pointId)) return true;
  const hasCoordinator = (await prisma.boronganPerson.count({ where: coordinatorsAt(pointId) })) > 0;
  return canRequestClaim(scope, pointId, hasCoordinator);
}
