import { z } from "zod";
import { warsawDate, warsawLocalToUtc } from "./time";

export const IntakeSchema = z.object({
  eventName: z.string().trim().min(2).max(120),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD"),
  deliverBy: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "use YYYY-MM-DDTHH:MM (Warsaw time)"),
  deliveryPlace: z.string().trim().min(3).max(200),
  contactName: z.string().trim().min(1).max(80),
  contactEmail: z.email().max(200),
  request: z.string().trim().min(10).max(4000),
  designPending: z.boolean().optional(),
});

export type Intake = z.infer<typeof IntakeSchema>;

export function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

/** Returns a problem description, or null when the dates make sense. */
export function checkIntakeDates(intake: Intake, now: Date): string | null {
  let deliverBy: Date;
  try {
    deliverBy = warsawLocalToUtc(intake.deliverBy);
  } catch {
    return "deliverBy is not a real date and time";
  }
  const eventOk = /^\d{4}-\d{2}-\d{2}$/.test(intake.eventDate) &&
    !Number.isNaN(Date.parse(`${intake.eventDate}T00:00:00Z`)) &&
    new Date(`${intake.eventDate}T00:00:00Z`).toISOString().slice(0, 10) === intake.eventDate;
  if (!eventOk) return "eventDate is not a real date";
  if (intake.eventDate < warsawDate(now)) return "the event date has passed";
  if (deliverBy.getTime() <= now.getTime()) return "deliverBy must be in the future";
  if (warsawDate(deliverBy) > intake.eventDate) return "deliverBy must be on or before the event day";
  return null;
}
