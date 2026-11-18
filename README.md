# @entity-tracker/react-client

TypeScript contract generation and shared React setup for EntityTracker.AspNetCore version 3.

```sh
npm install @entity-tracker/react-client react zustand @microsoft/signalr
npx entity-tracker generate --input ./entity-tracker-spec.json --output ./src/generated/entities
```

Input may also be an HTTP(S) URL. Both `--input=value` and `--input value` work. Paths resolve from the current working directory (TypeSynth also supports tsconfig aliases). The CLI replaces `contracts.ts`, `useEntityChanges.ts`, and `index.ts`; keep hand-written code in other files. Only trusted backend specifications should be used: their property types are TypeScript expressions.

Generated contracts include `EntityType`, `EntityPayloadMap`, `PayloadFor`, payload DTOs, `EventMetadata`, `EntityChange`, and the discriminated `EntityChangeEvent` union. IDs are strings. Payloads may be omitted; metadata is typed directly from the spec.

```tsx
import { useEntityTracker } from "@entity-tracker/react-client";

export function Root() {
  useEntityTracker({
    backendUrl: "https://localhost:7777",
    headers: { "x-my-header": "value" },
  });
  return <App />;
}
```

Mount exactly one setup hook per application. Setup installs configuration in an internal Zustand store. The first active consumer opens a shared connection; the last consumer leaving stops it.

Import the single consumer hook from your generated module:

```tsx
import { EntityType, useEntityChanges } from "./generated/entities";

useEntityChanges(
  EntityType.Note,
  (event) => {
    // event.changes contains string IDs and typed payloads.
    // event.metadata has the type declared by your backend spec.
    refreshNotes(event.changes);
  },
  {
    disable: !noteId,
    extraConditions: { [EntityType.Note]: (change) => change.id === noteId },
  },
);

useEntityChanges([EntityType.Note, EntityType.Comment], (event) => {
  if (event.entityType === EntityType.Note) refreshNotes(event.changes);
  else refreshComments(event.changes);
});
```

Both input forms receive one event per backend notification. Per-type predicates filter changes locally, and empty results do not call the handler. Updating handlers or predicates uses the latest committed callbacks without resubscribing. Empty arrays and disabled hooks make no subscriptions. Entity types are reference-counted across consumers.

Reconnect restores subscriptions, but notifications missed while disconnected are not replayed. Initial connection failures and exhausted reconnects retry at capped delays. Subscription invocation failures are reported and retried on a later subscription change or reconnect. An optional `onError` on `useEntityTracker` receives connection, subscription, predicate, and handler errors; by default they go to `console.error`. Updating `onError` takes effect without changing the configuration key.

`backendUrl` and optional `configurationKey` (string or number) control configuration replacement. Change the key to apply updated headers, authentication options, hub path, or builder callbacks. Without a key, ordinary rerenders retain the initial options until the backend URL changes. Unmounting clears configuration and stops an owned connection.

`hubPath` defaults to `/hubs/EntityTracker`. `httpConnectionOptions` accepts SignalR transport/authentication options; credentials default to enabled. Top-level `headers` override duplicate entries in `httpConnectionOptions.headers`. `configureBuilder` runs last, after automatic reconnect and disabled logging are configured. Browser transport restrictions on custom headers still apply; use SignalR's `accessTokenFactory` where appropriate.

React 18/19, Zustand 5, and SignalR 10 are peers. The CLI requires Node 22 or later. Runtime imports do not include TypeSynth or Node modules. Tokyo and SignalSpec are not dependencies.

```sh
npm run check
npm test
npm run build
```
