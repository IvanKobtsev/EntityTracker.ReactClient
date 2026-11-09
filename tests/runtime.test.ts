import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { createElement, StrictMode } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createConnectionBuilder, trackerStore, useEntityTracker } from "../src/runtime.ts";
import { HubConnectionBuilder } from "@microsoft/signalr";
import type { HubConnection } from "@microsoft/signalr";
import type { UseEntityTrackerOptions } from "../src/runtime.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReactTestRenderer | undefined;
function Setup(props: UseEntityTrackerOptions) {
  useEntityTracker(props);
  return null;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
});
it("configures lazily and applies options only when identity changes", async () => {
  const builder = vi.fn();
  await act(async () => {
    root = create(
      createElement(Setup, {
        backendUrl: "https://example.test",
        headers: { a: "1" },
        configureBuilder: builder,
      }),
    );
  });
  expect(trackerStore.getState().connection).toBeUndefined();
  expect(builder).not.toHaveBeenCalled();
  await act(async () =>
    root!.update(createElement(Setup, { backendUrl: "https://example.test", headers: { a: "2" } })),
  );
  expect(trackerStore.getState().configuration?.headers).toEqual({ a: "1" });
  await act(async () =>
    root!.update(
      createElement(Setup, {
        backendUrl: "https://example.test",
        headers: { a: "2" },
        configurationKey: 1,
      }),
    ),
  );
  expect(trackerStore.getState().configuration?.headers).toEqual({ a: "2" });
});
it("survives Strict Mode and clears configuration on unmount", async () => {
  await act(async () => {
    root = create(
      createElement(StrictMode, null, createElement(Setup, { backendUrl: "https://example.test" })),
    );
  });
  expect(trackerStore.getState().configuration?.backendUrl).toBe("https://example.test");
  await act(async () => root!.unmount());
  root = undefined;
  expect(trackerStore.getState().configuration).toBeUndefined();
});
it("merges connection options and customizes the builder last", () => {
  const withUrl = vi.spyOn(HubConnectionBuilder.prototype, "withUrl");
  const callback = vi.fn((builder: HubConnectionBuilder) => builder);
  try {
    const builder = createConnectionBuilder({
      backendUrl: "https://example.test/base/",
      hubPath: "/custom",
      headers: { a: "top" },
      httpConnectionOptions: { headers: { a: "nested", b: "keep" }, withCredentials: false },
      configureBuilder: callback,
    });
    expect(withUrl).toHaveBeenCalledWith(
      "https://example.test/base/custom",
      expect.objectContaining({ headers: { a: "top", b: "keep" }, withCredentials: false }),
    );
    expect(callback).toHaveBeenCalledWith(builder);
  } finally {
    withUrl.mockRestore();
  }
});
it("ignores stale configuration while an old connection stops", async () => {
  await act(async () => {
    root = create(createElement(Setup, { backendUrl: "https://first.test" }));
  });
  let finish!: () => void;
  const stopped = new Promise<void>((done) => {
    finish = done;
  });
  const stop = vi.fn(() => stopped);
  trackerStore.setState({ connection: { stop } as unknown as HubConnection });
  await act(async () => root!.update(createElement(Setup, { backendUrl: "https://second.test" })));
  await act(async () => root!.update(createElement(Setup, { backendUrl: "https://third.test" })));
  expect(trackerStore.getState().configuration).toBeUndefined();
  await act(async () => {
    finish();
    await stopped;
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(trackerStore.getState().configuration?.backendUrl).toBe("https://third.test");
});
it("rejects multiple owners", async () => {
  await act(async () => {
    root = create(createElement(Setup, { backendUrl: "https://first.test" }));
  });
  await expect(
    act(async () => {
      create(createElement(Setup, { backendUrl: "https://second.test" }));
    }),
  ).rejects.toThrow("Only one");
});
