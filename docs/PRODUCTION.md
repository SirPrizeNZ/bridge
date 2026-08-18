# Production and paid-plugin readiness

Figma Agent Bridge is deliberately local-first. A commercial build should preserve that property: a user's file contents and rendered assets should not leave the machine unless the user deliberately points an agent or asset operation at a remote service.

## 1. Use a Figma-assigned plugin ID

Figma's manifest `id` is assigned by Figma. The repository ships with development placeholders so the source is portable.

After creating/registering a development plugin in Figma, copy the assigned ID and run:

```bash
npm run configure -- YOUR_FIGMA_PLUGIN_ID
```

If Stable and Max are separately registered development plugins, pass two IDs:

```bash
npm run configure -- STABLE_ID MAX_ID
```

Do not publish the Max manifest. `enableProposedApi` is a development facility and proposed APIs are not a stable published-plugin contract.

## 2. Stable vs Max

- `manifest.json`: commercial/stable baseline. Loopback networking only; no proposed/private API flags.
- `manifest.max.json`: local R&D. Proposed/private API flags are opt-ins and only work where Figma permits them.

A paid product should make the Stable build the default and treat Max as an unsupported lab channel.

## 3. Security baseline

Before distribution:

- keep bridge binding on `127.0.0.1`, never `0.0.0.0` by default;
- retain per-install HMAC credentials and one-time pairing;
- keep write access and unsafe invoke as separate user-visible switches;
- keep the generic invocation deny-list and add to it when Figma introduces destructive APIs;
- preserve bounded queues, command deadlines and stale-client cleanup;
- perform a security review of any new network domain before adding it to the manifest;
- never upload canvas content, screenshots, tokens, fonts or image bytes for analytics;
- keep telemetry absent by default. If commercial telemetry is introduced, make it explicit, minimal and content-free.

## 4. Reliability baseline

A release candidate should pass four layers:

1. Node syntax/static tests (`npm run check`, `npm test`).
2. Transport benchmark (`npm run bench`).
3. Manual Figma matrix on current Desktop: small file, 10k+ node file, component-heavy file, variable-heavy file, rich-text file.
4. Agent destructive-edit torture test with rollback: deliberately fail assertions mid-batch and verify the document returns to the checkpoint.

## 5. Commercial product surfaces worth adding next

These are deliberately not coupled to the bridge core:

- signed auto-updater for the local bridge;
- release channel selection (Stable/Beta/Max);
- local encrypted audit log with user-controlled retention;
- named workspace profiles and per-agent permissions;
- capability policies (read-only, safe edit, full edit, unsafe API);
- optional organisation policy file checked into a repo;
- crash bundle exporter that redacts document content by default;
- visual regression suites for known design-system components;
- license/entitlement layer around convenience features, never around file recovery or undo.

## 6. Monetisation principle

Do not cripple the bridge to manufacture a paid tier. A credible paid version should charge for leverage: team policy, auditability, automated QA, deployment, update management, saved workflows, cross-file intelligence and support. Core local read/write should remain dependable.
