import { appointmentTitle } from "./mailTypes";
import type { Appointment, IcsEvent, MailSender, MailVerdict } from "./mailTypes";
import { domainOf } from "./mailParse";
import { textKey } from "./text";

export function icsKey(ics: IcsEvent): string {
  return `ics:${ics.uid}`;
}

export function appointmentKey(appointment: Appointment, ics: IcsEvent | null): string {
  if (ics !== null) return icsKey(ics);
  return `appt:${appointment.date}:${appointment.time}:${textKey(appointmentTitle(appointment.kind, appointment.time))}`;
}

export function linkDomain(sender: MailSender): string | null {
  return sender.authenticated ? domainOf(sender.address) : null;
}

function appointmentOf(verdict: MailVerdict): Appointment | null {
  return verdict.kind === "appointment" && verdict.change !== "cancel" ? verdict.appointment : null;
}

export function linkKey(verdict: MailVerdict, ics: IcsEvent | null): string | null {
  if (ics !== null) return icsKey(ics);
  const appointment = appointmentOf(verdict);
  return appointment === null ? null : appointmentKey(appointment, null);
}
