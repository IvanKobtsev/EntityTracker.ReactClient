import { useEffect, useRef } from "react";
import { HubConnectionState } from "@microsoft/signalr";
import type { HubConnection } from "@microsoft/signalr";
import { createConnectionBuilder, trackerStore, reportError } from "./runtime.ts";

export interface Change {
  id: string;
  payload?: unknown;
}
export interface ChangeEvent {
  entityType: string;
  changes: Change[];
  metadata: unknown;
}
interface Listener {
  types: Set<string>;
  dispatch: (event: ChangeEvent) => void;
}
export const listeners = new Map<symbol, Listener>();
interface Session {
  connection: HubConnection;
  acknowledged: Set<string>;
  epoch: number;
  running: boolean;
  pending: boolean;
}
let session: Session | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let stopping = Promise.resolve();
const delays = [1000, 2000, 5000, 10000, 30000];
function desired() {
  return new Set([...listeners.values()].flatMap((l) => [...l.types]));
}
function active(s: Session) {
  return session === s;
}
function cancelRetry() {
  if (retry !== undefined) clearTimeout(retry);
  retry = undefined;
}
function scheduleRetry() {
  if (retry !== undefined || !listeners.size || !trackerStore.getState().configuration) return;
  retry = setTimeout(
    () => {
      retry = undefined;
      refreshSubscriptions();
    },
    delays[Math.min(failures++, delays.length - 1)],
  );
}
export function stopSubscriptions() {
  cancelRetry();
  failures = 0;
  const old = session;
  const connection = old?.connection ?? trackerStore.getState().connection;
  session = undefined;
  if (connection) {
    trackerStore.setState({ connection: undefined });
    // Stop immediately so a pending start/invocation cannot block configuration replacement.
    const stopped = connection.stop().catch(reportError);
    stopping = Promise.all([stopping, stopped]).then(() => {});
  }
  return stopping;
}
async function reconcile(s: Session) {
  s.pending = true;
  if (s.running) return;
  s.running = true;
  try {
    while (active(s) && s.pending && s.connection.state === HubConnectionState.Connected) {
      s.pending = false;
      const epoch = s.epoch;
      const wanted = desired();
      const remove = [...s.acknowledged].filter((t) => !wanted.has(t));
      const add = [...wanted].filter((t) => !s.acknowledged.has(t));
      const method = remove.length ? "Unsubscribe" : "Subscribe";
      const names = remove.length ? remove : add;
      if (!names.length) break;
      try {
        await s.connection.invoke(method, names);
      } catch (error) {
        if (active(s) && epoch === s.epoch) reportError(error);
        if (active(s) && (s.pending || epoch !== s.epoch)) continue;
        break;
      }
      if (!active(s)) break;
      if (epoch !== s.epoch) {
        s.pending = true;
        continue;
      }
      for (const name of names)
        method === "Subscribe" ? s.acknowledged.add(name) : s.acknowledged.delete(name);
      s.pending = true;
    }
  } finally {
    s.running = false;
  }
}
export function refreshSubscriptions() {
  const counts = new Map<string, number>();
  for (const listener of listeners.values())
    for (const name of listener.types) counts.set(name, (counts.get(name) ?? 0) + 1);
  trackerStore.setState({ listeners: new Map(listeners), subscriptionCounts: counts });
  if (!listeners.size || !trackerStore.getState().configuration) {
    void stopSubscriptions();
    return;
  }
  if (session) {
    void reconcile(session);
    return;
  }
  if (retry !== undefined) return;
  const configuration = trackerStore.getState().configuration!;
  let connection: HubConnection;
  try {
    connection = createConnectionBuilder(configuration).build();
  } catch (error) {
    reportError(error);
    scheduleRetry();
    return;
  }
  const s: Session = {
    connection,
    acknowledged: new Set(),
    epoch: 0,
    running: false,
    pending: false,
  };
  session = s;
  trackerStore.setState({ connection });
  connection.on("EntitiesChanged", (event: ChangeEvent) => {
    if (!active(s)) return;
    for (const [id, listener] of [...listeners]) {
      if (listeners.get(id) !== listener || !listener.types.has(event.entityType)) continue;
      listener.dispatch(event);
    }
  });
  connection.onreconnecting(() => {
    if (active(s)) {
      s.epoch++;
      s.acknowledged.clear();
    }
  });
  connection.onreconnected(() => {
    if (!active(s)) return;
    failures = 0;
    s.epoch++;
    s.acknowledged.clear();
    void reconcile(s);
  });
  connection.onclose((error) => {
    if (!active(s)) return;
    session = undefined;
    trackerStore.setState({ connection: undefined });
    if (error) reportError(error);
    scheduleRetry();
  });
  void stopping.then(async () => {
    if (!active(s)) return;
    try {
      await connection.start();
    } catch (error) {
      if (!active(s)) return;
      session = undefined;
      trackerStore.setState({ connection: undefined });
      reportError(error);
      scheduleRetry();
      return;
    }
    if (active(s)) {
      failures = 0;
      await reconcile(s);
    }
  });
}

/** Runtime bridge used by generated useEntityChanges wrappers. */
export function useEntityChangesRuntime(
  types: string | readonly string[],
  handler: (event: any) => unknown,
  options?: {
    disable?: boolean;
    extraConditions?: Record<string, ((change: any) => boolean) | undefined>;
  },
): void {
  const committed = useRef({ handler, options });
  useEffect(() => {
    committed.current = { handler, options };
  });
  const key = JSON.stringify([...new Set(typeof types === "string" ? [types] : types)].sort());
  useEffect(() => {
    const names = JSON.parse(key) as string[];
    if (options?.disable || !names.length) return;
    const id = Symbol();
    listeners.set(id, {
      types: new Set(names),
      dispatch(event) {
        try {
          const current = committed.current;
          const predicate = current.options?.extraConditions?.[event.entityType];
          const changes = predicate ? event.changes.filter(predicate) : [...event.changes];
          if (changes.length)
            void Promise.resolve(current.handler({ ...event, changes })).catch(reportError);
        } catch (error) {
          reportError(error);
        }
      },
    });
    refreshSubscriptions();
    return () => {
      listeners.delete(id);
      refreshSubscriptions();
    };
  }, [key, options?.disable]);
}
