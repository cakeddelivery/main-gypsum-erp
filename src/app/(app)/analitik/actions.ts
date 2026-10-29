"use server";
import { action, optStr } from "@/lib/action";
import { audit } from "@/lib/audit";
import { askAdvisor } from "@/lib/advisor";
import { businessSnapshot } from "@/lib/analytics";

export const requestAdvice = action(
  "dashboard.finance",
  async (fd, user) => {
    if (!user.can("accounting.view")) throw new Error("Butuh izin melihat akuntansi");
    const question = optStr(fd, "question");
    await askAdvisor(await businessSnapshot(), question);
    await audit(user, "SARAN_AI_DIMINTA", "Advisor", null, { question });
    return "Saran AI diperbarui";
  },
  ["/analitik"],
);
