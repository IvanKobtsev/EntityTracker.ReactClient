import { createElement, Fragment, StrictMode } from "react";
import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HubConnectionBuilder, HubConnectionState } from "@microsoft/signalr";
import { useEntityTracker } from "../src/runtime.ts";
import { useEntityChangesRuntime } from "../src/index.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class Connection {
  state = HubConnectionState.Disconnected;
  event!: (event: any) => void;
  reconnecting!: () => void;
  reconnected!: () => void;
  closed!: (error?: Error) => void;
  on = vi.fn((_name, handler) => {
    this.event = handler;
  });
  onreconnecting = vi.fn((handler) => {
    this.reconnecting = handler;
  });
  onreconnected = vi.fn((handler) => {
    this.reconnected = handler;
  });
  onclose = vi.fn((handler) => {
    this.closed = handler;
  });
  start = vi.fn(async () => {
    this.state = HubConnectionState.Connected;
  });
  stop = vi.fn(async () => {
    this.state = HubConnectionState.Disconnected;
  });
  invoke = vi.fn(async (_method: string, _names: string[]) => {});
}
let roots: ReactTestRenderer[] = [];
let connections: Connection[];
let onError = vi.fn();
function Setup({ configurationKey = 0 }: { configurationKey?: number }) {
  useEntityTracker({ backendUrl: "https://example.test", configurationKey, onError });
  return null;
}
function Consumer({
  types = ["Note"],
  handler = vi.fn(),
  disable = false,
  predicate,
}: {
  types?: string[];
  handler?: (event: any) => unknown;
  disable?: boolean;
  predicate?: (change: any) => boolean;
}) {
  useEntityChangesRuntime(types, handler, { disable, extraConditions: { Note: predicate } });
  return null;
}
async function mount(element: ReturnType<typeof createElement>) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(element);
  });
  roots.push(root);
  return root;
}
beforeEach(() => {
  connections = [];
  onError = vi.fn();
  vi.spyOn(HubConnectionBuilder.prototype, "build").mockImplementation(() => {
    const connection = new Connection();
    connections.push(connection);
    return connection as any;
  });
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("shares memberships, normalizes inline arrays, and releases only the final reference", async () => {
  await mount(createElement(Setup));
  const first = await mount(createElement(Consumer, { types: ["Note", "Note", "Other"] }));
  const second = await mount(createElement(Consumer));
  const connection = connections[0]!;
  expect(connections).toHaveLength(1);
  expect(connection.invoke).toHaveBeenCalledWith("Subscribe", ["Note", "Other"]);
  await act(async () => first.update(createElement(Consumer, { types: ["Other", "Note"] })));
  expect(connection.invoke).toHaveBeenCalledTimes(1);
  await act(async () => first.update(createElement(Consumer, { disable: true })));
  expect(connection.invoke).toHaveBeenLastCalledWith("Unsubscribe", ["Other"]);
  await act(async () => second.update(createElement(Consumer, { types: [] })));
  expect(connection.stop).toHaveBeenCalledOnce();
});
it("uses latest callbacks and independent filtered arrays without subscription churn", async () => {
  await mount(createElement(Setup));
  const firstHandler = vi.fn();
  const latest = vi.fn();
  const other = vi.fn();
  const first = await mount(createElement(Consumer, { handler: firstHandler }));
  await mount(createElement(Consumer, { handler: other }));
  const connection = connections[0]!;
  await act(async () =>
    first.update(createElement(Consumer, { handler: latest, predicate: (c) => c.id === "2" })),
  );
  const event = {
    entityType: "Note",
    changes: [{ id: "1" }, { id: "2" }],
    metadata: { user: "a" },
  };
  connection.event(event);
  expect(firstHandler).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledWith({ ...event, changes: [{ id: "2" }] });
  expect(other).toHaveBeenCalledWith(event);
  expect(other.mock.calls[0]![0].changes).not.toBe(event.changes);
  expect(connection.invoke).toHaveBeenCalledTimes(1);
});
it("restores subscriptions after reconnect and replaces connections on configuration changes", async () => {
  const setup = await mount(createElement(Setup));
  await mount(createElement(Consumer));
  const old = connections[0]!;
  await act(async () => {
    old.reconnecting();
    old.reconnected();
  });
  expect(old.invoke).toHaveBeenCalledTimes(2);
  await act(async () => setup.update(createElement(Setup, { configurationKey: 1 })));
  expect(old.stop).toHaveBeenCalledOnce();
  expect(connections[1]!.invoke).toHaveBeenCalledWith("Subscribe", ["Note"]);
});
it("isolates predicate errors and rejected handler promises", async () => {
  await mount(createElement(Setup));
  await mount(
    createElement(Consumer, {
      predicate: () => {
        throw new Error("predicate");
      },
    }),
  );
  await mount(
    createElement(Consumer, {
      handler: async () => {
        throw new Error("handler");
      },
    }),
  );
  const good = vi.fn();
  await mount(createElement(Consumer, { handler: good }));
  await act(async () =>
    connections[0]!.event({ entityType: "Note", changes: [{ id: "1" }], metadata: null }),
  );
  expect(onError).toHaveBeenCalledTimes(2);
  expect(good).toHaveBeenCalledOnce();
});
it("works when consumer effects precede setup, including Strict Mode", async () => {
  await mount(
    createElement(
      StrictMode,
      null,
      createElement(Fragment, null, createElement(Consumer), createElement(Setup)),
    ),
  );
  expect(connections.at(-1)!.invoke).toHaveBeenCalledWith("Subscribe", ["Note"]);
});
it("retries a failed start and cancels retries after cleanup", async () => {
  vi.useFakeTimers();
  vi.mocked(HubConnectionBuilder.prototype.build).mockImplementationOnce(() => {
    const connection = new Connection();
    connection.start.mockRejectedValueOnce(new Error("start"));
    connections.push(connection);
    return connection as any;
  });
  await mount(createElement(Setup));
  const consumer = await mount(createElement(Consumer));
  expect(onError).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(connections).toHaveLength(2);
  await act(async () => {
    connections[1]!.closed(new Error("closed"));
  });
  await act(async () => consumer.update(createElement(Consumer, { disable: true })));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(connections).toHaveLength(2);
});
it("reconciles changes made while a Subscribe invocation is pending", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((done) => {
    finish = done;
  });
  vi.mocked(HubConnectionBuilder.prototype.build).mockImplementationOnce(() => {
    const connection = new Connection();
    connection.invoke.mockImplementationOnce(() => pending);
    connections.push(connection);
    return connection as any;
  });
  await mount(createElement(Setup));
  const first = await mount(createElement(Consumer));
  await mount(createElement(Consumer, { types: ["Other"] }));
  await act(async () => first.update(createElement(Consumer, { disable: true })));
  await act(async () => {
    finish();
    await pending;
  });
  expect(connections[0]!.invoke.mock.calls).toEqual([
    ["Subscribe", ["Note"]],
    ["Unsubscribe", ["Note"]],
    ["Subscribe", ["Other"]],
  ]);
});
it("reports invocation failures without looping and retries after demand changes", async () => {
  vi.mocked(HubConnectionBuilder.prototype.build).mockImplementationOnce(() => {
    const connection = new Connection();
    connection.invoke.mockRejectedValueOnce(new Error("subscription"));
    connections.push(connection);
    return connection as any;
  });
  await mount(createElement(Setup));
  await mount(createElement(Consumer));
  expect(onError).toHaveBeenCalledOnce();
  expect(connections[0]!.invoke).toHaveBeenCalledTimes(1);
  await mount(createElement(Consumer, { types: ["Other"] }));
  expect(connections[0]!.invoke).toHaveBeenLastCalledWith("Subscribe", ["Note", "Other"]);
});
it("uses the latest setup error callback without replacing the connection", async () => {
  const setup = await mount(createElement(Setup));
  await mount(
    createElement(Consumer, {
      handler: () => {
        throw new Error("handler");
      },
    }),
  );
  const previous = onError;
  onError = vi.fn();
  await act(async () => setup.update(createElement(Setup)));
  connections[0]!.event({ entityType: "Note", changes: [{ id: "1" }], metadata: null });
  expect(previous).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledOnce();
  expect(connections).toHaveLength(1);
});
