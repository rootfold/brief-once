import { reliabilityEventStoreSchema, type ReliabilityEventStore } from "./event-schema.js";

export function parseReliabilityEventStore(input: unknown): ReliabilityEventStore {
  return reliabilityEventStoreSchema.parse(input);
}

export function serializeReliabilityEventStore(store: ReliabilityEventStore): string {
  return `${JSON.stringify(parseReliabilityEventStore(store), undefined, 2)}\n`;
}

export function compactReliabilityEventStore(
  store: ReliabilityEventStore,
  maximumEvents: number,
  retainClosedSessions = 100,
): { readonly store: ReliabilityEventStore; readonly compacted: boolean } {
  const validated = parseReliabilityEventStore(store);
  const closedSessionIds = validated.events
    .filter((event) => event.eventType === "session_closed" && event.sessionId !== undefined)
    .map((event) => event.sessionId as string);
  const retainedClosedSessionIds = new Set(
    closedSessionIds.slice(Math.max(0, closedSessionIds.length - retainClosedSessions)),
  );
  const expiredClosedSessionIds = new Set(
    closedSessionIds.filter((sessionId) => !retainedClosedSessionIds.has(sessionId)),
  );
  const retainedBySession = validated.events.filter(
    (event) => event.sessionId === undefined || !expiredClosedSessionIds.has(event.sessionId),
  );
  const events =
    retainedBySession.length <= maximumEvents
      ? retainedBySession
      : retainedBySession.slice(retainedBySession.length - maximumEvents);
  return {
    store: parseReliabilityEventStore({ ...validated, events }),
    compacted: events.length !== validated.events.length,
  };
}
