## v0.2.9
- Rewrote the agent-facing guidance for fidelity work. The previous advice was to
  "start narrow and widen" on figma_inspect, which optimises for context safety at
  the cost of correctness: a narrow read only surfaces the properties you thought
  to ask for, so node-level opacity, gradient direction and style bindings are
  routinely missed. Reading cheaply is a filtering problem, not a "request less"
  problem -- a 136-node screen is ~3.4M chars raw but ~35k once per-node
  boilerplate is stripped.
- figma_inspect results now carry a `note` explaining, at the point of use, that
  x/y are parent-relative (deriving padding from them is the most common cause of
  wrong spacing), that absoluteRenderBounds is ink where absoluteBoundingBox is
  the node box, and that opacity/visible/blendMode are node fields not fully
  mirrored in css. Oversized payloads additionally advise filtering the spilled
  file rather than retrying at a smaller depth.
- figma_snapshot is now described as the tool to prefer when matching an
  implementation to a design: structure states intent, the render proves it.
- Made the smoke suite runnable and self-consistent: it hardcoded port 3874 and
  ignored FIGMA_AGENT_BRIDGE_PORT, so it could not run while a bridge was live,
  and it asserted the literal version '0.2.7' -- meaning it was pinned to the
  stale constant and would fail on any release bump. It now takes the port from
  the environment (passing it to the spawned server) and asserts against the
  version declared in package.json.
- Fixed the reported server version: bridge/server.mjs still hard-coded 0.2.7,
  so a v0.2.8 install introduced itself as 0.2.7 in bridge_status and to pairing
  clients.

## v0.2.8
- Rounded the plugin surface on the bottom corners only.
- Preserved the v0.2.7 progressive Step 2 reveal and control styling.

# Changelog

## 0.2.7 — 2026-08-18

- Step 2 is now progressive and stays hidden until the user copies the agent prompt.
- Clarified Step 2 to “Paste the 6-digit code your agent gives you”.
- Restyled the prompt field and OTP cells with dark-grey fills and subtly lighter edges.

## 0.2.6 — 2026-08-18

- Added a rounded visible plugin surface using a transparent host background, 4px inset shell, 18px corner radius and clipped content.
- Keeps the existing BRIDGE setup, connected, settings and live-stat behaviour unchanged.

## 0.2.5 — 2026-08-18

- Clarified first-run Step 2 copy to “Paste the 6-digit code from your agent”.
- Connected-state energy mark now uses the exact supplied green-star bitmap rather than an approximated SVG/CSS star.
- Preserved the source glow pixel-for-pixel at rest, with only a restrained brightness/scale pulse while connected.
- Simplified the plugin shell to pure black so the exact star bitmap blends cleanly into the UI.

## 0.2.4 — 2026-08-18

- Rebuilt the plugin shell around the final black BRIDGE visual system.
- First-time setup is now a single two-step view: copy the agent prompt, then enter the six-digit OTP.
- The sixth OTP digit submits automatically; successful pairing removes setup completely.
- Connected state now uses a small animated green energy star aligned above the I in BRIDGE.
- Connected state is cardless and reduced to CONNECTED plus live Latency, Commands, and Errors metrics.
- Settings remain available from the top-right gear, with the raw unsafe invoke control relabelled as Experimental API.
- Added a fixed, subtle version label at the bottom edge.

## 0.2.3 — 2026-08-18

- Rebuilt the plugin UI around a minimal black BRIDGE shell.
- Added first-launch copy-to-AI flow, automatic bridge detection, six-digit OTP paste, and auto-connect on the sixth digit.
- Simplified the connected state to a single `1 connected` status with file/page context.
- Preserved advanced controls inside Settings and removed operational/debug clutter from the main surface.
- Added automatic reconnect/probe behaviour so restarting the MCP bridge does not require manual refresh.


## 0.2.2 — 2026-08-14

### Reliability
- Added writer-priority scheduling with parallel reads and serial writes.
- Added UI write kill-switch and separate unsafe-invoke gate.
- Added batch stale-state fingerprints and assertions.
- Preserved styled text by default; generic destructive `.characters` writes are blocked.
- Added asynchronous property setters required by dynamic-page style/reaction/paint/vector APIs.

### Performance
- Replaced full-document event handling with current-page `nodechange` + `stylechange`.
- Replaced all-page eager loading with lazy `PageNode.loadAsync()` traversal and early exit.
- Search temporarily skips invisible instance descendants and omits fingerprints by default.
- Added font-load caching.
- Batched up to eight commands per poll.
- Added binary spill-to-disk for large renders/assets.

### Security
- Per-install HMAC-derived credentials.
- Short-lived one-time pairing codes and failure throttling.
- Bounded client queues and global pending command limits.
- Stable manifest restricted to loopback network access.
- Remote asset fetch moved into Node with protocol/private-network/size checks.

### Agent capability
- Expanded from 13 to 23 MCP tools, including a combined structure + render snapshot tool.
- Added rich text, components, prototype, Motion, design analysis, developer resources/CSS, team library and font tools.
- Expanded variable modes and explicit node-mode control.
- Added component, style, CSS and dev-resource enrichments to deep inspection.
- Expanded runtime capability discovery targets.

### Product/UI
- Rebuilt plugin window with connection state, command count, latency, errors, write/unsafe/event controls and cleaner pairing flow.
- Added `bridge_doctor` diagnostics.
- Reworked documentation and automated tests.

### Distribution hardening
- Added `npm run configure -- <figma-plugin-id> [max-id]` so development/published manifests use IDs actually assigned by Figma instead of relying on portable placeholders.
- Added `docs/PRODUCTION.md` with Stable/Max release guidance, security gates, commercialisation principles and manual Figma release matrix.
- Added `npm run bench` transport benchmark to make bridge throughput regressions measurable.
