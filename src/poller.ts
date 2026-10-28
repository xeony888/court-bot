import { CrsSession, type Slot } from "./crs.js";
import { getSettings, prisma } from "./db.js";
import { env } from "./env.js";
import { dateWindow, laToday, slotMatches } from "./filter.js";
import { sendSlotAlert, type AlertGroup } from "./mailer.js";

export interface PollStatus {
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  /** Errors from the latest run, keyed by watch id. */
  watchErrors: Record<number, string>;
  nextRunAt: string | null;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function syncSlots(watchId: number, matched: Slot[]): Promise<void> {
  await prisma.$transaction([
    prisma.openSlot.deleteMany({ where: { watchId, startsAt: { notIn: matched.map((s) => s.startsAt) } } }),
    ...matched.map((s) =>
      prisma.openSlot.upsert({
        where: { watchId_startsAt: { watchId, startsAt: s.startsAt } },
        create: { watchId, startsAt: s.startsAt, available: s.available },
        update: { available: s.available },
      }),
    ),
  ]);
}

class Poller {
  status: PollStatus = {
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastError: null,
    watchErrors: {},
    nextRunAt: null,
  };
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  /**
   * Schedules the next automatic run. Paused settings cancel automatic runs.
   * The default delay is the configured poll interval.
   */
  async schedule(delayMs?: number): Promise<void> {
    clearTimeout(this.timer);
    const settings = await getSettings();
    if (settings.paused) {
      this.status.nextRunAt = null;
      return;
    }
    const delay = delayMs ?? settings.pollIntervalMinutes * 60_000;
    this.status.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.run().finally(() => this.schedule().catch((e) => console.error("Failed to schedule poll", e)));
    }, delay);
  }

  /** Runs one check. Concurrent callers share the run that is in flight. */
  run(): Promise<void> {
    this.inFlight ??= this.execute().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async execute(): Promise<void> {
    this.status = {
      ...this.status,
      running: true,
      lastStartedAt: new Date().toISOString(),
      lastError: null,
      watchErrors: {},
    };
    try {
      await this.check();
    } catch (e) {
      this.status.lastError = errorMessage(e);
      console.error("Poll failed", e);
    } finally {
      this.status.running = false;
      this.status.lastFinishedAt = new Date().toISOString();
    }
  }

  private async check(): Promise<void> {
    const settings = await getSettings();
    const watches = await prisma.watch.findMany({ where: { active: true }, orderBy: { id: "asc" } });
    if (watches.length > 0) {
      const session = await CrsSession.open(env.crsUsername, env.crsPassword, settings.probeCaseNumber);
      const today = laToday();
      for (const watch of watches) {
        try {
          const window = dateWindow(watch, today);
          const matched = window
            ? (await session.slots(watch, window.from, window.to)).filter((s) => slotMatches(watch, window, s.startsAt))
            : [];
          await syncSlots(watch.id, matched);
        } catch (e) {
          this.status.watchErrors[watch.id] = errorMessage(e);
        }
      }
    }

    const pending = await prisma.openSlot.findMany({
      where: { notifiedAt: null, watch: { active: true } },
      include: { watch: true },
      orderBy: [{ watchId: "asc" }, { startsAt: "asc" }],
    });
    if (pending.length === 0) return;
    if (settings.recipients.length === 0) {
      this.status.lastError = "Matching slots are open, but no alert recipients are configured.";
      return;
    }
    const groups = new Map<number, AlertGroup>();
    for (const slot of pending) {
      let group = groups.get(slot.watchId);
      if (!group) {
        group = {
          label: slot.watch.label,
          location: `${slot.watch.courthouseName} - ${slot.watch.departmentName}`,
          reservationType: slot.watch.reservationTypeName,
          slots: [],
        };
        groups.set(slot.watchId, group);
      }
      group.slots.push(slot);
    }
    await sendSlotAlert(settings.recipients, [...groups.values()]);
    await prisma.openSlot.updateMany({
      where: { id: { in: pending.map((s) => s.id) } },
      data: { notifiedAt: new Date() },
    });
  }
}

export const poller = new Poller();
