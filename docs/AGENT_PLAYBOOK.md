# Figma Agent Bridge — agent playbook

Use this playbook when an agent must inspect or edit a live Figma document through the local **Figma Agent Bridge**.

## Non-negotiable boundary

Use only the MCP server named `figma-agent-bridge` and its `mcp__figma_agent_bridge__*` tools.

Do **not** substitute the official Figma MCP, `get_design_context`, Figma REST, direct HTTP, browser/devtools automation, `curl`, a Node inspector, or an internal inspection of the bridge process. If the bridge is unavailable, report that bridge error and stop; do not work around it.

The plugin is the authority for the open file. It must remain open in Figma Desktop while an agent works.

## Human setup (once per Figma session)

1. Start/restart Codex so its configured `figma-agent-bridge` stdio server is available.
2. Open the target Figma Design file in Figma Desktop.
3. Run **Figma Agent Bridge** from Figma's development plugins and leave its window open.
4. If the plugin asks to pair, an agent obtains the current six-digit code from `bridge_status`; enter it in the plugin UI.

The bridge is loopback-only on `127.0.0.1:3874`. Codex owns that listener. Do not launch `bridge/server.mjs` manually while Codex is open, and do not kill a bridge process unless fixing a confirmed stale duplicate.

### Local checks

`npm run check` is safe while Codex is connected. `npm test` starts its own bridge process, so run it only when no live Codex bridge owns port 3874; an `EADDRINUSE` failure in that situation is expected and is not a plugin failure.

## Required first calls

Every agent begins with:

1. `bridge_status`
2. `figma_context`

Report, before any mutation:

- whether a plugin client is connected;
- current file and page;
- current selection (or that it is empty);
- bridge version;
- any pairing, queue, or error state.

If the task refers to the current selection and the selection is empty, ask the user to select the intended frame/layer. Do not guess a node ID.

## Read workflow

Use the smallest read capable of answering the question.

```text
figma_context
  -> figma_search (if the node is not selected)
  -> targeted figma_inspect
  -> figma_snapshot or figma_render when visual truth matters
```

- Use `figma_context` for file/page/selection/viewport.
- Use `figma_search` with `currentPage` first. Narrow with `within` after locating a frame.
- Use `figma_inspect` only on the relevant IDs. Request geometry, styles, CSS, text segments, or components only when required.
- Use `figma_snapshot` when both node structure and a Figma-rendered PNG are needed.
- Use `figma_render` to visually verify a known node after an edit.
- Prefer `delivery: "file"` for large renders; inspect the returned local export path instead of flooding context.

Never infer pixel values from a screenshot when `figma_inspect` can supply the actual Figma geometry, fills, text runs, opacity, and effects.

## Write workflow

Mutations must be narrow and reversible.

```text
figma_inspect
  -> retain the node fingerprint
  -> figma_history commit (for material edits)
  -> named mutation tool or small figma_batch with assertion
  -> figma_render
  -> visually verify
```

Rules:

- For existing text, use `figma_text`, never a generic whole-text write unless a style reset is explicitly intended.
- For instances/variants, use `figma_components`.
- For variables, use `figma_variables`; for styles, use `figma_styles`.
- Use `figma_batch` only when multiple dependent operations need atomic success/failure. Assert the current `fingerprint` first so concurrent edits do not get overwritten.
- For a material or multi-node change, create a `figma_history` checkpoint before editing.
- Render the exact affected frame/node afterwards. If it differs from the requested result, fix it or undo through `figma_history`.
- Respect the plugin's write kill-switch. If writes are paused, report it; do not bypass it.

`figma_invoke` is an exception: it requires `unsafe: true` **and** the user enabling Unsafe API invoke in the plugin UI. Use it only when a named bridge tool cannot perform a user-authorised operation.

## Design-to-code workflow

When implementing live Figma in an app:

1. Snapshot the target frame.
2. Inspect only the nodes that determine layout, type, fills/gradients, effects, and assets.
3. Treat `absoluteRenderBounds` / the render AABB as the placement truth for baked or blurred effects—not a raw node bounding box.
4. Implement the smallest faithful change.
5. Render the Figma frame again and compare against an on-device/app screenshot at the same dimensions.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Server is not callable | Report an MCP registration/configuration issue; do not use another Figma integration. |
| `connectedClients: 0` | Ask the user to open/run the Figma Agent Bridge plugin. |
| Pairing required/expired | Call `bridge_status`, give the current code, and have the user pair in the plugin UI. |
| Empty selection | Ask the user to select the intended frame/layer, or use a user-provided node ID. |
| Timeout/queue error | Retry one narrow bridge request; if it recurs, report the bridge error and stop. |
| Visual mismatch after edit | Use `figma_render`, inspect the changed node, correct or undo—never claim parity without a render. |

## Available bridge tools

`bridge_status`, `bridge_doctor`, `figma_context`, `figma_search`, `figma_inspect`, `figma_analyse`, `figma_recent_events`, `figma_snapshot`, `figma_render`, `figma_batch`, `figma_text`, `figma_components`, `figma_prototype`, `figma_motion`, `figma_variables`, `figma_styles`, `figma_assets`, `figma_history`, `figma_library`, `figma_fonts`, `figma_dev`, `figma_capabilities`, and `figma_invoke`.

See [TOOLING.md](TOOLING.md) for the compact tool-family list, [ARCHITECTURE.md](ARCHITECTURE.md) for transport architecture, and [PRODUCTION.md](PRODUCTION.md) for release/security details.
