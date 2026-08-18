# Architecture — v0.2

## Source of truth

Figma itself remains the `.fig` parser, layout engine and renderer. The plugin operates on Figma's live object model.

## Execution lanes

The plugin has a writer-priority scheduler:

- up to four read-only commands may run concurrently;
- exactly one mutation runs at a time;
- once a writer is waiting, newer reads do not jump ahead of it;
- a UI kill-switch can reject every write;
- generic invoke has a separate UI gate.

This prevents mutation interleaving while retaining throughput for inspection/render/search.

## Dynamic pages

The manifest uses `documentAccess: dynamic-page`.

- current-page work touches only the current page;
- targeted node access loads the containing page if necessary;
- all-page search calls `PageNode.loadAsync()` one page at a time;
- traversal stops as soon as the requested result window is full;
- the bridge never calls `loadAllPagesAsync()` as a normal search strategy.

## Event model

The plugin watches:

- global `selectionchange`;
- global `currentpagechange`;
- global `stylechange`;
- `nodechange` only on the currently active `PageNode`.

On page switch the old callback is detached and a callback is attached to the new current page. Node events are coalesced before transport.

## Transport

MCP is stdio JSON-RPC. The plugin UI talks to an HTTP service bound to `127.0.0.1` using authenticated batched long-polling.

Long polling was retained over WebSockets because it keeps the implementation dependency-free and gives predictable request/response semantics inside Figma's plugin iframe. Polls can deliver up to eight queued commands at once.

## Authentication

The Node service stores one random master secret locally. Each plugin installation is assigned an `installId`; its bearer token is derived with HMAC from the master secret and that install id.

Pairing codes:
- are six digits;
- expire after 15 minutes;
- are invalidated immediately after successful use;
- are rate-limited after repeated failure.

Runtime `clientId`s are ephemeral, which allows multiple concurrently open Figma files without credential collisions.

## Context control

Heavy payloads are opt-in or bounded:

- vector geometry;
- styled text runs;
- image bytes;
- descendant recursion;
- property counts;
- string/array/object serialisation;
- event batches;
- binary render payloads.

Search deliberately omits fingerprints by default because computing a stale-state fingerprint for every search hit is unnecessary overhead. Deep inspect includes them for mutation preconditions.

## Mutation integrity

`figma_batch` creates undo boundaries and, by default, triggers undo if an operation fails. Within-batch symbolic references eliminate fragile round trips. `assert` supports node type/name/parent/property checks and a compact fingerprint.

Text is special-cased: generic `.characters` writes are blocked for existing text unless style reset is intentional. `figma_text` uses insert/delete/range APIs to preserve styled runs.

## Network boundary

The stable plugin manifest only permits loopback access to the bridge. Arbitrary HTTP(S) image imports are downloaded in Node, capped, converted to bytes and sent to `figma.createImage`. Private-network URL targets are blocked unless explicitly allowed.

## Extensibility

High-frequency capabilities receive named tools. `figma_capabilities` inspects the current object's prototype surface and `figma_invoke` can call exposed methods without JavaScript `eval`, allowing new Plugin API methods to be used before the bridge ships a dedicated wrapper.
