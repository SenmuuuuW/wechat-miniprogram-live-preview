# WeChat Mini Program Live Preview

Build with AI agents.  
See your WeChat Mini Program instantly.  
No DevTools switching.

This VS Code extension keeps the real WeChat Mini Program runtime behind your editor. An agent (or a person) changes files in the workspace, the extension coalesces those changes, WeChat DevTools updates the project, and the current simulator screenshot appears in a sidebar or editor panel.

> **Real runtime, not a renderer.** The preview is sourced from WeChat DevTools through `miniprogram-automator`; this project does not translate WXML into HTML or attempt to emulate WXSS, `wx` APIs, navigation, lifecycle behavior, WXS, or native components.

## Status

This is the `0.1.0` open-source release. The extension code, unit-test seams, VSIX packaging, and runtime probe are implemented. The end-to-end DevTools session is **not yet verified on the development machine**: DevTools reached initialization but the host blocked writes to its Application Support state and localhost automation setup. See [docs/REALITY-CHECK.md](docs/REALITY-CHECK.md) for the evidence and exact status.

No fabricated simulator screenshot is included in this repository.

## Why

AI-assisted Mini Program development should not require an agent to pause while a developer switches between the editor and WeChat DevTools. This extension keeps the feedback loop in the IDE while preserving the behavior of the real WeChat runtime.

## Workflow

```text
Codex / Claude Code / Cursor Agent modifies Mini Program files
        |
        v
WeChat DevTools runtime recompiles or settles the project
        |
        v
Live simulator preview updates inside VS Code
```

The integration is filesystem-based, so the same flow applies to shell scripts and other coding harnesses. There is no agent SDK integration to install.

## Features

- Real WeChat DevTools simulator screenshots inside a VS Code sidebar and an editor-area preview panel.
- Filesystem-based, agent-agnostic change detection. It handles VS Code saves and writes made by shells, scripts, and coding agents outside the editor.
- Watches `.wxml`, `.wxss`, `.js`, `.ts`, `.json`, and `.wxs` files, while excluding `node_modules`, `.git`, `dist`, `build`, and `miniprogram_npm`.
- Debounced and coalesced refreshes, serialized runtime work, cooperative cancellation, and stale-result protection. A burst of edits produces one latest preview instead of a screenshot per write.
- Automatic project discovery from workspace roots, including nested monorepos. An explicit `projectPath` can select a directory or `project.config.json`.
- DevTools CLI discovery from configuration, conventional installation paths, and macOS application search.
- Bounded reconnect attempts after a runtime disconnect, actionable error messages, and in-memory preview timing.
- A read-only technical spike for checking the installed DevTools CLI and the observed Automator API surface.

## Requirements

- VS Code `1.85` or newer.
- A WeChat DevTools installation with an Automator-compatible CLI. The extension was developed and probed on macOS. Windows conventional CLI paths are included; Linux requires an explicit `miniProgramPreview.devtoolsPath`. Runtime behavior on each host and DevTools release must be checked locally.
- A Mini Program project containing `project.config.json`.
- For an already-running DevTools connection (`launchDevTools: false`), an enabled DevTools Service Port/automation endpoint listening on the configured port. The exact settings label can vary by DevTools release.

## Installation

### From a VSIX

Build the package from a checkout:

```bash
npm ci
npm run compile
npm test
npm run lint
npm run package
```

This creates a versioned `.vsix` file in the repository root (for `0.1.0`, normally `wechat-miniprogram-live-preview-0.1.0.vsix`). Install it with the VS Code command **Extensions: Install from VSIX...**, or with the `code` CLI:

```bash
code --install-extension wechat-miniprogram-live-preview-0.1.0.vsix
```

The `code` command is optional; the graphical VS Code command works when it is not on `PATH`.

## Quick Start

1. Install and sign in to WeChat DevTools if your project requires it.
2. Open the workspace containing `project.config.json` in VS Code.
3. Run **Mini Program: Start Preview** from the Command Palette.
4. If more than one project is found, select the project in the Quick Pick. Set `miniProgramPreview.projectPath` to avoid repeated selection.
5. The **Mini Program Preview** view appears in the Explorer. Use **Mini Program: Open Preview** for a larger editor-area panel.
6. Edit or let an agent edit Mini Program source files. The preview refreshes after the configured debounce period.

If DevTools is already running and you want the extension to connect rather than launch it, set `miniProgramPreview.launchDevTools` to `false`, enable the DevTools automation/service port, and use the same `miniProgramPreview.automatorPort` value.

## Commands

| Command | What it does |
| --- | --- |
| **Mini Program: Start Preview** | Detects/selects a project, launches or connects to DevTools, and captures the initial preview. |
| **Mini Program: Stop Preview** | Disconnects this extension's Automator session. It does not kill the external DevTools process. |
| **Mini Program: Refresh Preview** | Requests an immediate screenshot refresh. |
| **Mini Program: Open Preview** | Opens the editor-area preview panel while sharing the existing session with the sidebar. |
| **Mini Program: Reconnect** | Reconnects to the last project with bounded retries. |

## Settings

All settings use the `miniProgramPreview.*` prefix and can be edited in VS Code Settings or `settings.json`.

| Setting | Default | Description |
| --- | ---: | --- |
| `devtoolsPath` | `""` | Optional path to the DevTools app bundle or executable CLI. |
| `projectPath` | `""` | Optional Mini Program directory or `project.config.json`, relative to a workspace folder or absolute. |
| `autoRefresh` | `true` | Refresh after relevant source changes. |
| `refreshDelay` | `350` ms | Debounce window used to coalesce a burst of writes. |
| `automatorPort` | `9420` | Local Automator WebSocket/service port. |
| `launchDevTools` | `true` | Let Automator launch DevTools when starting a session; set `false` to connect to an existing endpoint. |
| `autoReconnect` | `true` | Retry a disconnected runtime with bounded backoff. |
| `captureDelay` | `180` ms | Initial settle delay before reading page state and capturing a screenshot. |
| `maxRefreshRetries` | `3` | Maximum adaptive screenshot-stability attempts per refresh (bounded to `1..8`). |

Example:

```json
{
  "miniProgramPreview.projectPath": "apps/miniprogram",
  "miniProgramPreview.refreshDelay": 400,
  "miniProgramPreview.launchDevTools": true
}
```

## How It Works

```text
workspace save or external file write
        |
        v
WorkspaceChangeDetector
        |
        v
RefreshScheduler (debounce, coalesce, serialize, cancel stale work)
        |
        v
PreviewSession -> DevToolsController -> miniprogram-automator
        |
        v
current page + page stack + simulator screenshot
        |
        v
sidebar and editor preview webviews
```

The extension keeps one `PreviewSession` and one Automator runtime for all preview consumers. A screenshot is published only if its refresh generation is still current, so a slow result from an older edit cannot overwrite a newer one. The Automator adapter reads the current page, page stack, screenshot, console events, and exception events exposed by the observed public API. Since `miniprogram-automator@0.12.1` does not expose a compile-ready callback in the inspected declarations/source, the client uses an adaptive delay and screenshot hash stability check instead of inventing a `compile()` API.

## AI Coding Workflow

The extension is intentionally agent-agnostic. Codex, Claude Code, Cursor Agent, DeepSeek-based harnesses, Zcode, and other tools are supported because they modify real workspace files; there is no vendor SDK integration to configure.

The relevant sequence is:

```text
agent edits index.wxml, index.wxss, index.js
        |
filesystem watcher observes the writes
        |
one debounced refresh with coalesced reasons
        |
real WeChat DevTools runtime settles
        |
latest simulator screenshot is shown in the IDE
```

This covers editor saves, shell/script writes, multiple files changed close together, and a newer write arriving while an older refresh is still running. Unit tests exercise these scheduler and project-discovery invariants with fakes; they do not claim to be a real DevTools integration test.

## Performance

`PerformanceTracker` keeps timing data in memory only. It records the refresh generation, detection time, debounce completion, screenshot capture latency, and the time the webview reports that the image finished loading. No telemetry is sent. The defaults prioritize coalescing and a stable capture over an unverified fixed latency promise; do not interpret the settings as a benchmark.

## Troubleshooting

### DevTools CLI not found

Install WeChat DevTools or set `miniProgramPreview.devtoolsPath` to the app bundle or executable CLI. Then run **Mini Program: Reconnect**. On macOS, the locator checks conventional app locations and uses application metadata search as a fallback.

### Automation or Service Port unavailable

If the error mentions a port, listen failure, or Service Port, confirm that the selected port is free and that DevTools automation is enabled when connecting to an existing instance. Check `miniProgramPreview.automatorPort`, then run **Mini Program: Reconnect**. A host policy that prevents DevTools from writing its own Application Support data can fail before a WebSocket is opened; the probe documents this separately from extension unit-test results.

### No Mini Program project found

Open the correct workspace, ensure the project root contains `project.config.json`, or set `miniProgramPreview.projectPath` to the project directory/file. Nested projects are discovered automatically; an ambiguous relative setting across workspace folders is rejected rather than guessed.

### Empty or stale preview

Make sure the simulator is open and the project can compile in DevTools. Use **Mini Program: Refresh Preview** after fixing a compile error. For projects with slower rebuilds, increase `captureDelay` or `maxRefreshRetries`; increase `refreshDelay` if a tool emits a very large burst of writes.

## Reality Check

The repository includes [`scripts/probe-wechat-runtime.ts`](scripts/probe-wechat-runtime.ts), which performs safe CLI/API inspection by default and attempts a real session only when `--project` is supplied.

```bash
# Safe discovery and API evidence
npm run spike -- --json

# Attempt a real disposable-project session
npm run spike -- \
  --project /absolute/path/to/miniprogram \
  --port 9420 \
  --timeout 15000 \
  --screenshot work/reality-spike/simulator.png \
  --json
```

Only a returned screenshot and a probe status of `VERIFIED` justify calling the runtime path end-to-end verified. The current report is **BLOCKED / NOT REAL-WORLD VERIFIED** on the development machine. See [docs/REALITY-CHECK.md](docs/REALITY-CHECK.md) before relying on a particular DevTools release or host setup.

## Limitations and Non-Goals

Version `0.1.0` does not provide an MCP server, AI vision agent, DOM inspector, element picker, pixel-stream video, WXML-to-HTML renderer, remote-device streaming, cloud service, multi-simulator dashboard, or per-agent SDK integration. It also does not replace WeChat DevTools. The external DevTools runtime remains responsible for compilation and rendering.

The public Automator surface inspected for this release exposes page and screenshot operations but no compile-complete event. Refresh readiness is therefore inferred through bounded settling and screenshot stability. Service Port behavior, background/minimized-window behavior, reconnects after every DevTools release, screenshot latency, and a successful real simulator capture must be verified on the target machine.

## Development and Testing

```bash
npm ci
npm run compile
npm run lint
npm test
npm run package
```

`npm test` compiles the TypeScript sources and runs the Node test suite. Tests use injected filesystem, clock, locator, and runtime boundaries where applicable, so they are deterministic and do not require a GUI. GitHub Actions intentionally does **not** run the real DevTools probe: hosted runners do not provide the WeChat DevTools application or a usable simulator/service-port session.

For a local runtime investigation, use `npm run spike` as described above and record the result in `docs/REALITY-CHECK.md` without upgrading an unverified observation to `VERIFIED`.

## Contributing

Bug reports and focused pull requests are welcome. Please run the compile, lint, test, and package commands before submitting a change. Keep runtime claims evidence-based, avoid committing credentials or machine-specific paths, and do not add generated artifacts or real screenshots unless they are useful and reproducible.

## License

[MIT](LICENSE)
