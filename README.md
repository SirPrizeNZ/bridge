<p align="center">
  <img src="assets/logo.gif" alt="Bridge" width="100%" />
</p>

# Bridge

> Free, local Model Context Protocol (MCP) server for live Figma documents. Inspect, reason about, render, and edit active designs with AI agents directly in Figma Desktop without Dev Mode or paid REST API quotas.

---

## Overview

Bridge connects your AI coding assistant directly to the live Figma Plugin API inside your open Figma Desktop session via a fast, local loopback connection (`127.0.0.1:3874`).

Unlike traditional Figma REST integrations that read static cloud files, Bridge works directly on the canvas in real time. Your active document is the immediate source of truth, enabling agents to inspect exact geometry, typography runs, components, variables, and styles, and verify visual edits instantly.

---

## Why Bridge

- **100% free and local**: No Figma Dev Mode subscription, no cloud seat requirements, and no REST API rate limits.
- **Effortless 30-second setup**: Import the local manifest into Figma Desktop, add the server to your agent configuration, and pair with a 6-digit code.
- **Live canvas fidelity**: Reads and writes execute directly in the active Figma tab with full access to variables, components, vectors, and typography.
- **Visual verification**: Agents export authoritative PNG, JPG, SVG, and PDF renders directly from the canvas to verify mutations before finalizing.
- **Safe and reversible**: Built-in fingerprint assertions, rollback support, and an instant write kill-switch in the plugin interface.

---

## Architecture

Bridge consists of two lightweight components:

1. **Local MCP server (`bridge/server.mjs`)**: A dependency-free Node.js stdio MCP server that exposes tools to AI clients and manages an authenticated loopback HTTP long-poll transport.
2. **Figma Desktop plugin (`plugin/`)**: A local manifest plugin that runs inside Figma Desktop, executes API operations within the Figma document sandbox, and streams results back to the local server.

```
+-------------------+             stdio              +----------------------+
|                   | <============================> |                      |
|     AI agent      |   Model Context Protocol (MCP) |    Local bridge      |
| (Antigravity/     |                                |    Node server       |
|  Claude/Cursor/   |                                |  (127.0.0.1:3874)    |
|  Codex)           |                                +----------+-----------+
+-------------------+                                           ^
                                                                | HTTP long-poll
                                                                | (Authenticated)
                                                                v
                                                     +----------+-----------+
                                                     |                      |
                                                     |    Figma Desktop     |
                                                     |    Plugin sandbox    |
                                                     |                      |
                                                     +----------------------+
```

---

## Prerequisites

- **Node.js**: Version 18.0.0 or higher.
- **Figma Desktop**: macOS or Windows application with Developer Mode enabled for local plugin loading.

---

## Installation and setup

Setting up Bridge takes less than a minute.

### 1. Load the plugin in Figma Desktop

1. Open Figma Desktop and open any design file.
2. Go to **Plugins** -> **Development** -> **Import plugin from manifest...**.
3. Select the `manifest.json` file in this repository.
4. Launch **Bridge** from your development plugins menu and leave the plugin window open.

### 2. Add Bridge to your agent configuration

Add Bridge to your client configuration file.

#### Antigravity (`~/.gemini/config/mcp_config.json`)

```json
{
  "mcpServers": {
    "figma-agent-bridge": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/bridge/bridge/server.mjs"
      ]
    }
  }
}
```

#### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "figma-agent-bridge": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/bridge/bridge/server.mjs"
      ]
    }
  }
}
```

#### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "figma-agent-bridge": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/bridge/bridge/server.mjs"
      ]
    }
  }
}
```

---

## Pairing workflow

1. Open the Bridge plugin in Figma Desktop and click **Copy prompt**.
2. Paste the prompt to your AI assistant. If Bridge is not already configured, the agent will self-configure and request an environment reload.
3. Once running, the agent calls `bridge_status` and returns a fresh 6-digit code.
4. Paste the 6-digit code into the first OTP box in the plugin window.
5. The plugin connects immediately, enabling full live inspection and mutation tools.

---

## Available tools

### Inspection and context
- `bridge_status`: Returns daemon health, active pairing code, and connected file sessions.
- `bridge_doctor`: Diagnostic health check for transport and environment state.
- `figma_context`: Returns current file name, active page, selection, and viewport bounds.
- `figma_search`: Searches nodes on the current page or across all pages by name, type, or parent.
- `figma_inspect`: Deep inspection of node geometry, fills, strokes, effects, layout, and text segments.
- `figma_analyse`: Structural and statistical summary of subtrees, variants, and styles.
- `figma_recent_events`: Retrieves real-time selection and document modification events.

### Visual verification
- `figma_snapshot`: Single round-trip returning node hierarchy data along with an authoritative Figma PNG render.
- `figma_render`: Exports authoritative PNG, JPG, SVG, PDF, or JSON_REST_V1 representations of target nodes.

### Mutations
- `figma_batch`: Atomic ordered mutations with rollback support and fingerprint verification.
- `figma_text`: Precise typography edits with style-preserving run modifications.
- `figma_components`: Component instance creation, swapping, overrides, variant switching, and detachment.
- `figma_variables`: Local variable creation, collection management, mode values, and bindings.
- `figma_styles`: Paint, text, effect, and grid style creation and updates.
- `figma_assets`: Image byte management and server-side URL asset imports.
- `figma_history`: Checkpoint commits, version requests, and undo operations.

### Design systems and developer data
- `figma_library`: Published library variable and component discovery and import.
- `figma_fonts`: Font family listing, font weight searching, and async font loading.
- `figma_dev`: CSS code generation, measurements, and dev resource attachment.
- `figma_prototype`: Interactive prototype triggers, navigation, and reactions.
- `figma_motion`: Timeline animation and keyframe track operations.

### Extensibility
- `figma_capabilities`: Introspects available runtime methods in the active Figma client.
- `figma_invoke`: Controlled API method invocation (requires explicit user toggle in plugin UI).

---

## Security model

- **Loopback isolation**: Network listener binds strictly to `127.0.0.1:3874`. No external connections are accepted.
- **Per-installation credentials**: Installation tokens are derived locally from a random master secret (`~/.figma-agent-bridge/secret.json`).
- **Short-lived codes**: Pairing codes expire after 15 minutes and invalidate immediately upon successful pairing.
- **Hardware kill-switch**: The plugin window includes a toggle to pause write permissions at any time while keeping read access active.
- **Unsafe invoke gate**: Direct runtime invocation is disabled by default and requires both agent opt-in and manual plugin toggle activation.

---

## Contributor

- **SirPrize** ([GitHub Profile](https://github.com/SirPrizeNZ))

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
