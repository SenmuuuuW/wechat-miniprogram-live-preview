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

## Latest local E2E smoke session (2026-09-03)

A real Mini Program project (`zhifan-wechat-current`) was exercised while the
GUI DevTools process was running and the user was signed in. The standalone
runtime probe completed with a `VERIFIED` result through the Automator endpoint
`ws://127.0.0.1:9426`. The IDE HTTP Service Port was `31227`; it is a separate
endpoint and was not used as the Automator WebSocket.

Observed runtime evidence:

- `currentPage()` returned `pages/index/index`.
- `pageStack()` returned a single `pages/index/index` entry.
- `screenshot()` returned a real 780x1506 PNG. The standalone probe artifact is
  `work/reality-spike/simulator-probe-9430.png` (60,087 bytes); the persistent
  extension connection also captured `work/reality-spike/simulator-stable-9426.png`
  (60,565 bytes).
- The VS Code Explorer preview and editor-area preview both displayed the
  screenshot and reported `Connected`.
- Editing WXML to display `知返·E2E` refreshed the VS Code preview in about
  1,130 ms. A shell/agent write changing the same view to `知返·Agent` refreshed
  it in about 1,162 ms.
- **Mini Program: Reconnect** successfully recovered after the Automator
  runtime was disconnected and DevTools was restarted.

The compile-error check also reached the real DevTools process. Removing the
closing `>` from `pages/index/index.wxml` produced DevTools' visible
`WXML 文件编译错误` / `unexpected token` diagnostic at line 9. The observed
`miniprogram-automator@0.12.1` client emitted no compile-error event; the
extension retained the last valid screenshot and remained `Connected`. This is
an explicit limitation, not a passing compile-error-handling result. The file
was restored to its valid form after the check.

These results verify the local smoke path on this machine and DevTools build;
they do not establish compatibility with every host, project, or DevTools
release.

### Save-to-preview observations

The timings below are wall-clock smoke measurements from the source write to
the first visibly changed image. They are evidence for this host and project,
not telemetry or a performance guarantee.

| Change | Samples | DevTools visible | VS Code Preview visible |
| --- | ---: | --- | --- |
| WXSS | 5 | min 1,635 ms; median 1,674 ms; average 1,908 ms; max 2,778 ms | min 2,089 ms; median 2,146 ms; average 2,164 ms; max 2,292 ms |
| WXML | 3 | 1,070-1,978 ms | 421-730 ms |
| Agent direct filesystem write | 1 | 721 ms | 885 ms |

Two writes to the same file within 100 ms produced one observed new preview
latency, consistent with the scheduler's debounce/coalescing behavior. The
session contains eight ordinary WXSS/WXML samples plus one direct agent-write
sample; it is intentionally reported as a smoke check rather than a
statistically meaningful ten-run benchmark.

## Historical blocked attempts

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

An earlier session on 2026-09-03 also showed that the two local ports were
distinct:

- `Default/.ide` contained `25358`, and `127.0.0.1:25358` served the IDE HTTP
  service. `miniprogram-automator.connect({ wsEndpoint: "ws://127.0.0.1:25358" })`
  failed immediately because this is not an Automator WebSocket endpoint.
- `Default/.cli` contained a separate automation value (`3801`). Launching
  `cli auto --auto-port 3811` did not change that file or open port `3811`.

The bundled CLI then produced this sequence for the real project:

```text
- initialize
✔ IDE server has started, listening on http://127.0.0.1:25358
- preparing
✖ preparing
[error] { code: 10, message: '... INVALID_LOGIN,access_token expired ...' }
```

In the same GUI session, `cli islogin` completed with `{"login":true}`. This
only verifies the local login-state check; it does not prove that the project
can be opened for automation. The expired access token prevented the CLI from
starting the requested Automator WebSocket, so no page or screenshot APIs were
exercised. `miniprogram-automator.launch()` consequently timed out while
waiting for that socket.

## Controller implications

1. Locate the CLI through an explicit setting first, then conventional application paths and `PATH` lookup. Do not hard-code only one path.
2. Treat `cli auto` plus a localhost WebSocket as the current automator connection contract. Pick a free port and retain the project-to-port association for reconnect.
3. Surface initialization failures as actionable onboarding errors. A failure to write DevTools state may be a host permission issue, a missing/incorrect installation, or a user-level DevTools setup issue; the extension cannot infer which one without the returned error.
4. Keep compile readiness behind a bounded settle/capture strategy. The inspected public automator surface has screenshot/page APIs but no compile-ready callback.
5. Keep page stack, current page, screenshot, console, exception, disconnect, and close operations behind one shared session object so sidebar and editor panel do not open competing automator connections.

## Not verified

- A structured compile-error event or compile-complete callback. The public
  Automator surface inspected here exposes page and screenshot operations only;
  compile readiness is inferred with bounded settling and screenshot stability.
- Reliable behavior when DevTools is minimized or backgrounded across releases.
- Compatibility with other operating systems, DevTools versions, or projects
  whose rebuild times differ materially from this session.
- A statistically meaningful latency benchmark. The timings above are smoke
  samples, not a performance guarantee.

Run the probe on the target host and record a separate dated result before
generalizing beyond this local smoke evidence.
