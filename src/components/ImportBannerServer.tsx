import { runningJob } from "@/lib/marketplace/job";
import { ImportBanner } from "./ImportBanner";

export async function ImportBannerServer() {
  const r = await runningJob();
  return <ImportBanner initial={r ? { by: r.by, total: r.total, done: r.done, label: r.label } : null} />;
}
