-- Form pendaftaran karyawan oleh calon karyawan (tautan undangan Owner) + data diri karyawan
CREATE TYPE "Gender" AS ENUM ('L', 'P');
CREATE TYPE "RegistrationStatus" AS ENUM ('MENUNGGU', 'DISETUJUI', 'DITOLAK');

ALTER TABLE "Employee" ADD COLUMN "nickname" TEXT;
ALTER TABLE "Employee" ADD COLUMN "birthPlace" TEXT;
ALTER TABLE "Employee" ADD COLUMN "birthDate" DATE;
ALTER TABLE "Employee" ADD COLUMN "address" TEXT;
ALTER TABLE "Employee" ADD COLUMN "gender" "Gender";
ALTER TABLE "Employee" ADD COLUMN "email" TEXT;
ALTER TABLE "Employee" ADD COLUMN "seabankNo" TEXT;
ALTER TABLE "Employee" ADD COLUMN "seabankName" TEXT;

CREATE TABLE "RegistrationInvite" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistrationInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegistrationInvite_code_key" ON "RegistrationInvite"("code");

CREATE TABLE "EmployeeRegistration" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "birthPlace" TEXT NOT NULL,
    "birthDate" DATE NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "startDate" DATE NOT NULL,
    "seabankNo" TEXT NOT NULL,
    "seabankName" TEXT NOT NULL,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'MENUNGGU',
    "rejectReason" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "employeeId" TEXT,
    "ip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeRegistration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeRegistration_number_key" ON "EmployeeRegistration"("number");
CREATE UNIQUE INDEX "EmployeeRegistration_employeeId_key" ON "EmployeeRegistration"("employeeId");
CREATE INDEX "EmployeeRegistration_status_createdAt_idx" ON "EmployeeRegistration"("status", "createdAt");
CREATE INDEX "EmployeeRegistration_ip_createdAt_idx" ON "EmployeeRegistration"("ip", "createdAt");
ALTER TABLE "EmployeeRegistration" ADD CONSTRAINT "EmployeeRegistration_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "RegistrationInvite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RegistrationAttempt" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RegistrationAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RegistrationAttempt_ip_createdAt_idx" ON "RegistrationAttempt"("ip", "createdAt");
