# Changelog

## 2.0.0 - 2026-09-04

### Added

- Interactive preview plumbing for validated, generation-bound tap, scroll,
  input, and back messages from both VS Code preview surfaces.
- Coordinate mapping, real Automator element discovery/geometry adaptation, and
  bounded selector discovery that degrades safely when a DevTools runtime does
  not expose or respond to element APIs.
- A single runtime-operation scheduler that serializes code refreshes and user
  interactions, preserves the newest screenshot generation, and captures a
  post-action frame.
- Focused unit coverage for message validation, coordinate mapping, gestures,
  element ranking, interaction ordering, and PreviewSession integration.

### Changed

- Reframed the preview as interactive while retaining the real WeChat DevTools
  runtime as the renderer and source of truth.
- Updated release metadata and VSIX naming to `2.0.0`.

### Verification status

- The v2 implementation is compile- and unit-testable, but the latest runtime
  probe is `PARTIAL`: it connected and read the current page, while a fresh
  screenshot did not complete. Element discovery, tap, scroll, native input,
  and in-preview navigation have not yet been independently verified against
  that current connection. See `docs/REALITY-CHECK.md` for dated evidence.

### Known limitations

- Interaction is capability-dependent. The extension does not synthesize
  simulator clicks or claim a user action succeeded when Automator cannot
  resolve a real element or public navigation/scroll API.
- The public Automator API still has no compile-complete event or structured
  compile-error callback. The extension retains the last valid screenshot when
  DevTools reports a compile error.

## 0.1.1 - 2026-09-03

### Changed

- Verified the real WeChat DevTools Automator and simulator path on macOS with
  a signed-in DevTools session, including current page and screenshot capture.
- Hardened screenshot normalization and stable-frame capture for data-URI and
  wrapped base64 responses.
- Added actionable login-required errors and stale-runtime listener guards.
- Replayed the latest committed screenshot to preview consumers that attach
  after the initial capture.
- Added focused unit coverage for runtime errors, lifecycle races, and preview
  replay; documented the measured live-refresh observations and runtime limits.

### Known limitations

- The public Automator API inspected for this release does not expose a
  compile-complete event or structured compile-error callback. The extension
  retains the last valid screenshot when DevTools reports a compile error.

## 0.1.0 - 2026-09-03

### Added

- Real WeChat DevTools Automator adapter with CLI discovery.
- Shared PreviewSession for the sidebar and editor preview panel.
- Filesystem and VS Code save event detection for WXML, WXSS, JS, TS, JSON, and WXS.
- Debounced, coalesced, serialized refresh scheduling with stale result protection.
- Bounded reconnect and adaptive screenshot stability fallback.
- Project detection for workspace roots and nested monorepos.
- Unit tests, technical spike script, CI workflow, and VSIX packaging.

### Known limitations

- The public Automator types inspected on the development machine do not expose a compile-ready event or reload method. The extension uses an adaptive capture and stability check after each refresh request.
- Real runtime integration depends on WeChat DevTools Service Port/automation availability and is not run in GitHub Actions.
