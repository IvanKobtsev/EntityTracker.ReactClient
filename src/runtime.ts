import { useEffect, useRef } from "react";
import { createStore } from "zustand/vanilla";
import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import type { HubConnection, IHttpConnectionOptions } from "@microsoft/signalr";

export interface UseEntityTrackerOptions {
  backendUrl: string;
  hubPath?: string;
  headers?: Record<string, string>;
  httpConnectionOptions?: IHttpConnectionOptions;
  configureBuilder?: (builder: HubConnectionBuilder) => HubConnectionBuilder;
  configurationKey?: string | number;
}

interface TrackerState {
  configuration: UseEntityTrackerOptions | undefined;
  connection: HubConnection | undefined;
}

// Internal: subscriptions and connection acquisition belong to the consumer-hook stage.
export const trackerStore = createStore<TrackerState>(() => ({
  configuration: undefined,
  connection: undefined,
}));
let owner: symbol | undefined;
let revision = 0;
let transition = Promise.resolve();

export function createConnectionBuilder(options: UseEntityTrackerOptions): HubConnectionBuilder {
  const url =
    options.backendUrl.replace(/\/+$/, "") +
    "/" +
    (options.hubPath ?? "/hubs/EntityTracker").replace(/^\/+/, "");
  const builder = new HubConnectionBuilder()
    .withUrl(url, {
      withCredentials: true,
      ...options.httpConnectionOptions,
      headers: { ...options.httpConnectionOptions?.headers, ...options.headers },
    })
    .configureLogging(LogLevel.None)
    .withAutomaticReconnect();
  return options.configureBuilder?.(builder) ?? builder;
}

function replaceConfiguration(options: UseEntityTrackerOptions | undefined) {
  const current = ++revision;
  const old = trackerStore.getState().connection;
  trackerStore.setState({ configuration: undefined, connection: undefined });
  transition = transition.then(async () => {
    if (old) await old.stop().catch((error: unknown) => console.error(error));
    if (current === revision) trackerStore.setState({ configuration: options });
  });
}

/** Install shared configuration; change configurationKey to apply new options. */
export function useEntityTracker(options: UseEntityTrackerOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const identity = useRef(Symbol("EntityTracker owner"));
  useEffect(() => {
    if (owner && owner !== identity.current)
      throw new Error("Only one useEntityTracker configuration owner may be mounted.");
    owner = identity.current;
    const configuration = latest.current;
    replaceConfiguration({
      ...configuration,
      headers: { ...configuration.headers },
      httpConnectionOptions: configuration.httpConnectionOptions && {
        ...configuration.httpConnectionOptions,
        headers: { ...configuration.httpConnectionOptions.headers },
      },
    });
    return () => {
      if (owner === identity.current) {
        owner = undefined;
        replaceConfiguration(undefined);
      }
    };
  }, [options.backendUrl, options.configurationKey]);
}
