import { useEffect, useRef } from "react";
import { createStore } from "zustand/vanilla";
import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import type { HubConnection, IHttpConnectionOptions } from "@microsoft/signalr";
import { refreshSubscriptions, stopSubscriptions } from "./subscriptions.ts";

export interface UseEntityTrackerOptions {
  backendUrl: string;
  hubPath?: string;
  headers?: Record<string, string>;
  httpConnectionOptions?: IHttpConnectionOptions;
  configureBuilder?: (builder: HubConnectionBuilder) => HubConnectionBuilder;
  configurationKey?: string | number;
  onError?: (error: unknown) => void;
}

interface TrackerState {
  configuration: UseEntityTrackerOptions | undefined;
  connection: HubConnection | undefined;
  listeners: ReadonlyMap<symbol, { types: Set<string> }>;
  subscriptionCounts: ReadonlyMap<string, number>;
}

// Internal: subscriptions and connection acquisition belong to the consumer-hook stage.
export const trackerStore = createStore<TrackerState>(() => ({
  configuration: undefined,
  connection: undefined,
  listeners: new Map(),
  subscriptionCounts: new Map(),
}));
let owner: symbol | undefined;
let revision = 0;
let transition = Promise.resolve();
let errorHandler: ((error: unknown) => void) | undefined;
export function reportError(error: unknown) {
  try {
    if (errorHandler) errorHandler(error);
    else console.error(error);
  } catch (reportingError) {
    console.error(reportingError);
  }
}

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
  const stopped = stopSubscriptions();
  trackerStore.setState({ configuration: undefined, connection: undefined });
  transition = transition.then(async () => {
    await stopped;
    if (current === revision) {
      trackerStore.setState({ configuration: options });
      refreshSubscriptions();
    }
  });
}

/** Install shared configuration; change configurationKey to apply new options. */
export function useEntityTracker(options: UseEntityTrackerOptions): void {
  const latest = useRef(options);
  const identity = useRef(Symbol("EntityTracker owner"));
  useEffect(() => {
    latest.current = options;
    if (!owner || owner === identity.current) errorHandler = options.onError;
  });
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
        errorHandler = undefined;
      }
    };
  }, [options.backendUrl, options.configurationKey]);
}
