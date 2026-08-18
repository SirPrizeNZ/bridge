# MCP tool surface — v0.2

## Bridge
- `bridge_status`
- `bridge_doctor`

## Understand / inspect
- `figma_context`
- `figma_search`
- `figma_inspect`
- `figma_analyse`
- `figma_recent_events`

## Render
- `figma_snapshot`
- `figma_render`

## Edit
- `figma_batch`
- `figma_text`
- `figma_components`
- `figma_prototype`
- `figma_motion`
- `figma_variables`
- `figma_styles`
- `figma_assets`
- `figma_history`

## Design systems / development
- `figma_library`
- `figma_fonts`
- `figma_dev`

## Escape hatch
- `figma_capabilities`
- `figma_invoke`

The bridge intentionally groups capabilities into 23 families instead of exposing hundreds of tiny property tools. Agents should prefer a narrow named tool, then `figma_batch`, and use generic invoke last.

### Inspect strategy

Start compact. Increase depth or opt into heavy properties only when the question requires them. `includeGeometry`, styled runs, CSS, resources and component enrichment can make results substantially larger.

### Search strategy

Use `currentPage` unless there is evidence the node is elsewhere. `pages` with explicit `pageIds` is cheaper than `allPages`. Use `within` after locating a relevant frame/component. Request `includeFingerprint` only when search results themselves will immediately become mutation preconditions.

### Editing strategy

Use `figma_text` for existing text. Use `figma_components` for instances/variants. Use `figma_variables` for variable modes and bindings. Use `figma_batch` when several edits must succeed or fail together.

### Generic invoke handles

Arguments can resolve live objects with:
- `{ "$node": "123:45" }`
- `{ "$style": "S:…" }`
- `{ "$variable": "VariableID:…" }`
- `{ "$variableAlias": "VariableID:…" }`
- `{ "$collection": "VariableCollectionId:…" }`
- `{ "$bytes": "base64…" }`
