# WeChat DevTools Reality Check

This document records observations made on the development machine, not assumptions about every WeChat DevTools release. Run the standalone probe with:

```bash
npm run compile
node out/scripts/probe-wechat-runtime.js
```

To attempt an actual runtime session against a disposable or user-supplied Mini Program project:

```bash
npm run compile
node out/scripts/probe-wechat-runtime.js \
  --project /absolute/path/to/miniprogram \
  --screenshot work/reality-spike/simulator.png
```

## Verified locally

- Node.js: `/usr/local/bin/node` `v24.16.0`.
- npm: `/usr/local/bin/npm` `11.13.0`.
- Git: `/usr/bin/git` `2.39.3`.
- VS Code application bundle: `/Applications/Visual Studio Code.app`, embedded `code` CLI `1.135.0`; `code` is not on the shell `PATH`.
- WeChat DevTools application bundle: `/Applications/wechatwebdevtools.app`.
- DevTools bundle values from `Contents/Info.plist`: `CFBundleShortVersionString=2.01.2510290`, `CFBundleVersion=4240.111`.
- The bundled executable `/Applications/wechatwebdevtools.app/Contents/MacOS/cli` is executable.
- CLI help exposes `open`, `auto`, `auto-preview`, `close`, and related commands. `auto --help` exposes `--project`, `--trust-project`, `--ticket`, and the global `--port` option. The internal CLI also accepts the hidden `--auto-port` option used by the automator launcher.
- A local `miniprogram-automator` package artifact reports version `0.12.1`. Its declarations expose `launch()`, `connect()`, `MiniProgram.currentPage()`, `pageStack()`, `screenshot()`, `disconnect()`, and `close()`.
- The inspected automator implementation launches `cli auto --project <project> --auto-port <port>`, then connects to `ws://127.0.0.1:<port>`.
- The inspected automator implementation requests `App.getCurrentPage`, `App.getPageStack`, and `App.captureScreenshot`. It forwards `App.logAdded` as `console` events and `App.exceptionThrown` as `exception` events.
- No `compile()` method or compile-complete event was found in the inspected `miniprogram-automator@0.12.1` declarations/source. The extension therefore must not claim a compile-ready API unless a later runtime probe demonstrates one.

## Runtime attempt on this machine

The bundled CLI was invoked against the disposable fixture under `work/reality-fixture`:

```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
  --project "$PWD/work/reality-fixture" \
  --auto-port 9420 \
  --trust-project
```

Observed result:

```text
- initialize
[error] Please ensure that the IDE has been properly installed
... EPERM: operation not permitted, open
'<home>/Library/Application Support/微信开发者工具/<version-hash>/Default/.cli'
```

This is **BLOCKED / NOT REAL-WORLD VERIFIED** in the current sandbox: DevTools reached its initialization path, but the environment denied its write to the application's own `Library/Application Support` state directory. No automator WebSocket connection or simulator screenshot was obtained, so this report does not claim that launch, page inspection, screenshot capture, reconnect, or timing works end to end on this machine.

The standalone probe was also run through the installed automator artifact with
`--project work/reality-fixture --port 9420`; it failed before a WebSocket was
opened with `listen EPERM: operation not permitted 0.0.0.0`. This is a second
sandbox boundary, not evidence of a successful or failed DevTools runtime.

## Controller implications

1. Locate the CLI through an explicit setting first, then conventional application paths and `PATH` lookup. Do not hard-code only one path.
2. Treat `cli auto` plus a localhost WebSocket as the current automator connection contract. Pick a free port and retain the project-to-port association for reconnect.
3. Surface initialization failures as actionable onboarding errors. A failure to write DevTools state may be a host permission issue, a missing/incorrect installation, or a user-level DevTools setup issue; the extension cannot infer which one without the returned error.
4. Keep compile readiness behind a bounded settle/capture strategy. The inspected public automator surface has screenshot/page APIs but no compile-ready callback.
5. Keep page stack, current page, screenshot, console, exception, disconnect, and close operations behind one shared session object so sidebar and editor panel do not open competing automator connections.

## Not verified

- Service Port settings through the DevTools UI.
- A successful launch of a real Mini Program project.
- A successful WebSocket connection, page stack, current page, screenshot, or screenshot latency.
- Whether the DevTools window can be minimized/backgrounded reliably for every release.
- Reconnect behavior after DevTools restart or port changes.
- A stable compile-error event or structured compile diagnostics API.

Run the probe on a host where DevTools can write its own application data and where a disposable Mini Program project is available before changing any of these items to `VERIFIED`.
