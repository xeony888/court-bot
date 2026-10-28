import nodemailer from "nodemailer";
import { RESERVATION_URL } from "./crs.js";
import { env } from "./env.js";

const transport = nodemailer.createTransport({
  service: "gmail",
  auth: { user: env.gmailUser, pass: env.gmailAppPassword },
});

export interface AlertGroup {
  label: string;
  location: string;
  reservationType: string;
  slots: { startsAt: string; available: number }[];
}

// Slot times are Los Angeles wall-clock values. Formatting them as UTC keeps the wall-clock value unchanged.
const slotFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export async function sendSlotAlert(recipients: string[], groups: AlertGroup[]): Promise<void> {
  const total = groups.reduce((n, g) => n + g.slots.length, 0);
  const sections = groups.map((g) =>
    [
      g.label,
      `${g.location} | ${g.reservationType}`,
      ...g.slots.map((s) => `  - ${slotFormat.format(new Date(`${s.startsAt}:00Z`))} (${s.available} available)`),
    ].join("\n"),
  );
  await transport.sendMail({
    from: env.gmailUser,
    to: recipients,
    subject: `${total} new court date${total === 1 ? "" : "s"} open (LASC CRS)`,
    text: `${sections.join("\n\n")}\n\nReserve at ${RESERVATION_URL}\n`,
  });
}

export async function sendTestEmail(recipients: string[]): Promise<void> {
  await transport.sendMail({
    from: env.gmailUser,
    to: recipients,
    subject: "Court bot test email",
    text: "Court bot email alerts are configured correctly.\n",
  });
}
