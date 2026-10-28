import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { CrsError, CrsSession, type Option, ProbeCaseError } from "./crs.js";
import { getSettings, prisma } from "./db.js";
import { env } from "./env.js";
import { dateWindow, laToday, slotMatches } from "./filter.js";
import { sendTestEmail } from "./mailer.js";
import { errorMessage, poller } from "./poller.js";
import type { RangeMode } from "./generated/prisma/enums.js";

const SESSION_COOKIE = "court_bot_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_POLL_MINUTES = 2;
const MAX_POLL_MINUTES = 24 * 60;
// Changing DASHBOARD_PASSWORD changes this token and signs out every browser.
const sessionToken = createHmac("sha256", env.dashboardPassword).update("court-bot-dashboard-session").digest("hex");

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function hasSession(req: Request): boolean {
  const prefix = `${SESSION_COOKIE}=`;
  const cookie = req.headers.cookie
    ?.split(/;\s*/)
    .find((c) => c.startsWith(prefix))
    ?.slice(prefix.length);
  return cookie !== undefined && sameSecret(cookie, sessionToken);
}

// Portal catalog data. Reservation types depend on the probe case, so a probe change clears both caches.
let catalogCache: { caseName: string; courthouses: Option[]; reservationTypes: Option[] } | undefined;
const departmentCache = new Map<string, Option[]>();

const openSession = (caseNumber: string) => CrsSession.open(env.crsUsername, env.crsPassword, caseNumber);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${key} is required`);
  return value.trim();
}

function optionalPattern(body: Record<string, unknown>, key: string, pattern: RegExp): string | null {
  const value = body[key];
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !pattern.test(value)) throw new HttpError(400, `${key} is invalid`);
  return value;
}

function optionalDayCount(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isInteger(value) || (value as number) < 0) throw new HttpError(400, `${key} must be a whole number of days`);
  return value as number;
}

function parseWatch(body: Record<string, unknown>) {
  const rangeMode = body.rangeMode;
  if (rangeMode !== "ABSOLUTE" && rangeMode !== "RELATIVE") throw new HttpError(400, "rangeMode is invalid");
  if (typeof body.active !== "boolean") throw new HttpError(400, "active must be true or false");
  const weekdays = body.weekdays;
  if (!Array.isArray(weekdays) || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new HttpError(400, "weekdays must contain numbers from 0 (Sunday) to 6 (Saturday)");
  }

  const watch = {
    label: requireString(body, "label"),
    active: body.active,
    courthouseCode: requireString(body, "courthouseCode"),
    courthouseName: requireString(body, "courthouseName"),
    departmentCode: requireString(body, "departmentCode"),
    departmentName: requireString(body, "departmentName"),
    reservationTypeCode: requireString(body, "reservationTypeCode"),
    reservationTypeName: requireString(body, "reservationTypeName"),
    rangeMode: rangeMode as RangeMode,
    dateFrom: null as string | null,
    dateTo: null as string | null,
    minDaysOut: null as number | null,
    maxDaysOut: null as number | null,
    weekdays: [...new Set(weekdays as number[])].sort((a, b) => a - b),
    timeFrom: optionalPattern(body, "timeFrom", TIME_RE),
    timeTo: optionalPattern(body, "timeTo", TIME_RE),
  };

  if (rangeMode === "ABSOLUTE") {
    watch.dateFrom = optionalPattern(body, "dateFrom", DATE_RE);
    watch.dateTo = optionalPattern(body, "dateTo", DATE_RE);
    if (!watch.dateFrom || !watch.dateTo) throw new HttpError(400, "dateFrom and dateTo are required");
    if (watch.dateFrom > watch.dateTo) throw new HttpError(400, "dateFrom must not be after dateTo");
  } else {
    watch.minDaysOut = optionalDayCount(body, "minDaysOut");
    watch.maxDaysOut = optionalDayCount(body, "maxDaysOut");
    if (watch.minDaysOut === null || watch.maxDaysOut === null) {
      throw new HttpError(400, "minDaysOut and maxDaysOut are required");
    }
    if (watch.minDaysOut > watch.maxDaysOut) throw new HttpError(400, "minDaysOut must not exceed maxDaysOut");
  }
  if (watch.timeFrom && watch.timeTo && watch.timeFrom > watch.timeTo) {
    throw new HttpError(400, "timeFrom must not be after timeTo");
  }
  return watch;
}

function parseId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, "Invalid watch id");
  return id;
}

export function createServer() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public")));

  app.post("/api/login", (req, res) => {
    if (typeof req.body?.password !== "string" || !sameSecret(req.body.password, env.dashboardPassword)) {
      throw new HttpError(401, "Incorrect password");
    }
    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.json({ ok: true });
  });

  app.post("/api/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.use("/api", (req, _res, next) => {
    if (!hasSession(req)) throw new HttpError(401, "Not signed in");
    next();
  });

  app.get("/api/state", async (_req, res) => {
    const [settings, watches, slots] = await Promise.all([
      getSettings(),
      prisma.watch.findMany({ orderBy: { id: "asc" } }),
      prisma.openSlot.findMany({ orderBy: [{ watchId: "asc" }, { startsAt: "asc" }] }),
    ]);
    res.json({ settings, watches, slots, status: poller.status });
  });

  app.put("/api/settings", async (req, res) => {
    const body = req.body ?? {};
    const probeCaseNumber = requireString(body, "probeCaseNumber").toUpperCase();
    const { pollIntervalMinutes, recipients, paused } = body;
    if (
      !Number.isInteger(pollIntervalMinutes) ||
      pollIntervalMinutes < MIN_POLL_MINUTES ||
      pollIntervalMinutes > MAX_POLL_MINUTES
    ) {
      throw new HttpError(400, `Poll interval must be ${MIN_POLL_MINUTES} to ${MAX_POLL_MINUTES} minutes`);
    }
    if (!Array.isArray(recipients) || recipients.some((r) => typeof r !== "string" || !EMAIL_RE.test(r))) {
      throw new HttpError(400, "Recipients must be valid email addresses");
    }
    if (typeof paused !== "boolean") throw new HttpError(400, "paused must be true or false");

    const current = await getSettings();
    if (probeCaseNumber !== current.probeCaseNumber) {
      try {
        await openSession(probeCaseNumber);
      } catch (e) {
        if (e instanceof ProbeCaseError) throw new HttpError(400, e.message);
        throw e;
      }
      catalogCache = undefined;
      departmentCache.clear();
    }
    const settings = await prisma.settings.update({
      where: { id: 1 },
      data: { probeCaseNumber, pollIntervalMinutes, recipients: [...new Set(recipients as string[])], paused },
    });
    await poller.schedule();
    res.json({ settings, status: poller.status });
  });

  app.get("/api/catalog", async (_req, res) => {
    if (!catalogCache) {
      const session = await openSession((await getSettings()).probeCaseNumber);
      catalogCache = {
        caseName: session.caseName,
        courthouses: session.courthouses,
        reservationTypes: session.reservationTypes,
      };
    }
    res.json(catalogCache);
  });

  app.get("/api/catalog/departments/:courthouse", async (req, res) => {
    const courthouse = req.params.courthouse;
    let departments = departmentCache.get(courthouse);
    if (!departments) {
      const session = await openSession((await getSettings()).probeCaseNumber);
      departments = await session.departments(courthouse);
      departmentCache.set(courthouse, departments);
    }
    res.json(departments);
  });

  // Creates one watch per listed department. With several departments, each label gets the department name appended.
  app.post("/api/watches", async (req, res) => {
    const body = req.body ?? {};
    const departments = body.departments;
    if (
      !Array.isArray(departments) ||
      departments.length === 0 ||
      departments.some((d) => typeof d?.code !== "string" || typeof d?.name !== "string")
    ) {
      throw new HttpError(400, "Choose at least one department");
    }
    const label = requireString(body, "label");
    const data = (departments as { code: string; name: string }[]).map((d) =>
      parseWatch({
        ...body,
        label: departments.length === 1 ? label : `${label} – ${d.name}`,
        departmentCode: d.code,
        departmentName: d.name,
      }),
    );
    const watches = await prisma.watch.createManyAndReturn({ data });
    res.json({ watches });
  });

  app.put("/api/watches/:id", async (req, res) => {
    const id = parseId(req);
    const data = parseWatch(req.body ?? {});
    const before = await prisma.watch.findUnique({ where: { id } });
    if (!before) throw new HttpError(404, "Watch not found");
    const watch = await prisma.watch.update({ where: { id }, data });

    // Keep only open slots that the new criteria still match, so they do not trigger a second alert.
    const targetChanged =
      before.courthouseCode !== watch.courthouseCode ||
      before.departmentCode !== watch.departmentCode ||
      before.reservationTypeCode !== watch.reservationTypeCode;
    const window = dateWindow(watch, laToday());
    if (!watch.active || targetChanged || !window) {
      await prisma.openSlot.deleteMany({ where: { watchId: id } });
    } else {
      const existing = await prisma.openSlot.findMany({ where: { watchId: id } });
      const stale = existing.filter((s) => !slotMatches(watch, window, s.startsAt)).map((s) => s.id);
      await prisma.openSlot.deleteMany({ where: { id: { in: stale } } });
    }
    const slots = await prisma.openSlot.findMany({ where: { watchId: id }, orderBy: { startsAt: "asc" } });
    res.json({ watch, slots });
  });

  app.delete("/api/watches/:id", async (req, res) => {
    const id = parseId(req);
    const { count } = await prisma.watch.deleteMany({ where: { id } });
    if (count === 0) throw new HttpError(404, "Watch not found");
    res.json({ id });
  });

  app.post("/api/run", async (_req, res) => {
    await poller.run();
    const slots = await prisma.openSlot.findMany({ orderBy: [{ watchId: "asc" }, { startsAt: "asc" }] });
    res.json({ status: poller.status, slots });
  });

  app.post("/api/test-email", async (_req, res) => {
    const { recipients } = await getSettings();
    if (recipients.length === 0) throw new HttpError(400, "Add at least one recipient first");
    await sendTestEmail(recipients);
    res.json({ sentTo: recipients });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof CrsError) {
      res.status(502).json({ error: err.message });
    } else {
      console.error(err);
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return app;
}
