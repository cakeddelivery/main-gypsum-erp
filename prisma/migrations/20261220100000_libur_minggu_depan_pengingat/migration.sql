-- Pengajuan libur minggu depan + penanda pengingat (aditif)
CREATE TABLE "DayOffRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "userId" TEXT,
    "weekStart" DATE NOT NULL,
    "dates" TEXT[],
    "reason" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'MENUNGGU',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DayOffRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DayOffRequest_employeeId_weekStart_idx" ON "DayOffRequest"("employeeId", "weekStart");
CREATE INDEX "DayOffRequest_status_createdAt_idx" ON "DayOffRequest"("status", "createdAt");
ALTER TABLE "DayOffRequest" ADD CONSTRAINT "DayOffRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ReminderLog" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("key")
);
