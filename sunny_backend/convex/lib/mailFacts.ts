import type {
  CalendarEventFact,
  Clock,
  IcsEvent,
  KnownInvite,
  LinkedEvent,
  MailHeader,
  PolicyFacts,
} from "./mailTypes";

export type LinkedEventState = { occurs: true } | { occurs: false; date: string; time: string };

export interface LinkFact {
  eventId: string;
  senderAddress: string;
  event: LinkedEventState;
}

export interface FactInputs {
  header: MailHeader;
  clock: Clock;
  ics: IcsEvent | null;
  events: CalendarEventFact[];
  link: LinkFact | null;
  calendarChangesToday: number;
  seniorNotesToday: number;
}

function linkedEvent(link: LinkFact, header: MailHeader): LinkedEvent {
  const { eventId, event } = link;
  if (event.occurs) return { eventId, occurs: true };
  return {
    eventId,
    occurs: false,
    date: event.date,
    time: event.time,
    madeBy: link.senderAddress === header.sender.address ? "this_address" : "another_address",
  };
}

export function policyFacts(inputs: FactInputs): PolicyFacts {
  const { header, clock, link } = inputs;
  return {
    now: clock.now,
    timezone: clock.timezone,
    sender: header.sender,
    subject: header.subject,
    receivedAt: header.receivedAt,
    ics: inputs.ics,
    events: inputs.events,
    linked: link === null ? null : linkedEvent(link, header),
    calendarChangesToday: inputs.calendarChangesToday,
    seniorNotesToday: inputs.seniorNotesToday,
  };
}

export function knownInvite(link: { sequence?: number } | null): KnownInvite | null {
  return link === null ? null : { sequence: link.sequence ?? 0 };
}
