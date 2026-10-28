-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RangeMode" AS ENUM ('ABSOLUTE', 'RELATIVE');

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "probeCaseNumber" TEXT NOT NULL DEFAULT '26STCP04050',
    "pollIntervalMinutes" INTEGER NOT NULL DEFAULT 10,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "paused" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watch" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "courthouseCode" TEXT NOT NULL,
    "courthouseName" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "departmentName" TEXT NOT NULL,
    "reservationTypeCode" TEXT NOT NULL,
    "reservationTypeName" TEXT NOT NULL,
    "rangeMode" "RangeMode" NOT NULL,
    "dateFrom" TEXT,
    "dateTo" TEXT,
    "minDaysOut" INTEGER,
    "maxDaysOut" INTEGER,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "timeFrom" TEXT,
    "timeTo" TEXT,

    CONSTRAINT "Watch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpenSlot" (
    "id" SERIAL NOT NULL,
    "watchId" INTEGER NOT NULL,
    "startsAt" TEXT NOT NULL,
    "available" INTEGER NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "OpenSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpenSlot_watchId_startsAt_key" ON "OpenSlot"("watchId", "startsAt");

-- AddForeignKey
ALTER TABLE "OpenSlot" ADD CONSTRAINT "OpenSlot_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "Watch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
