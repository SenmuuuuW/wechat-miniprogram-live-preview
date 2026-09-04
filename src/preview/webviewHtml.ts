import type * as vscode from "vscode";

import {
  DEFAULT_SWIPE_MAX_DURATION_MS,
  DEFAULT_SWIPE_MIN_DISTANCE_PX,
  DEFAULT_TAP_MAX_DISTANCE_PX,
  DEFAULT_TAP_MAX_DURATION_MS,
  DEFAULT_WHEEL_IDLE_MS,
  DEFAULT_WHEEL_MIN_MAGNITUDE_PX,
} from "../interaction/GestureController";

/** Builds the small, stateful Webview shared by the sidebar and editor preview. */
export function previewWebviewHtml(webview: vscode.Webview, title: string): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  .root { min-height: 100vh; display: grid; grid-template-rows: auto minmax(180px, 1fr) auto; gap: 8px; padding: 10px; }
  .header, .footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; font-size: 12px; }
  .status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: 0 0 auto; }
  .dot.connected { background: var(--vscode-testing-iconPassed); }
  .dot.connecting, .dot.updating, .dot.interacting, .dot.typing { background: var(--vscode-editorWarning-foreground); }
  .dot.error { background: var(--vscode-testing-iconFailed); }
  .actions { display: inline-flex; align-items: center; gap: 4px; }
  .preview-stage { min-height: 180px; display: grid; place-items: center; overflow: hidden; position: relative; touch-action: none; user-select: none; background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .preview-image { display: none; grid-area: 1 / 1; max-width: 100%; max-height: calc(100vh - 98px); width: auto; height: auto; object-fit: contain; image-rendering: auto; user-select: none; -webkit-user-drag: none; }
  .preview-image.visible { display: block; }
  .empty { grid-area: 1 / 1; position: relative; z-index: 1; text-align: center; color: var(--vscode-descriptionForeground); padding: 24px 12px; line-height: 1.5; }
  .overlay { display: none; pointer-events: none; position: absolute; inset: 0; align-items: center; justify-content: center; background: color-mix(in srgb, var(--vscode-editor-background) 48%, transparent); font-size: 13px; }
  .overlay.visible { display: flex; }
  .error { color: var(--vscode-testing-iconFailed); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .page { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notice { display: none; position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 2; padding: 6px 8px; color: var(--vscode-notifications-foreground); background: var(--vscode-notifications-background); border: 1px solid var(--vscode-notifications-border); border-radius: 3px; font-size: 11px; line-height: 1.35; }
  .notice.visible { display: block; }
  .keyboard-capture { position: fixed; width: 1px; height: 1px; left: -100px; top: -100px; opacity: 0; pointer-events: none; }
  button { appearance: none; border: 0; min-height: 24px; padding: 2px 7px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .55; cursor: default; }
</style>
</head>
<body>
<main class="root">
  <div class="header">
    <div class="status"><span id="dot" class="dot"></span><span id="status">Disconnected</span></div>
    <div class="actions">
      <button id="back" title="Navigate back in the Mini Program">&lt;- Back</button>
      <button id="refresh" title="Refresh the Mini Program preview">Refresh</button>
      <button id="reconnect" title="Reconnect to WeChat DevTools">Reconnect</button>
    </div>
  </div>
  <section id="stage" class="preview-stage" aria-label="Mini Program simulator preview">
    <img id="previewA" class="preview-image" alt="Mini Program simulator preview" draggable="false" />
    <img id="previewB" class="preview-image" alt="" aria-hidden="true" draggable="false" />
    <div id="empty" class="empty">Start a preview to show the real WeChat simulator.</div>
    <div id="overlay" class="overlay">Updating...</div>
    <div id="notice" class="notice" role="status" aria-live="polite"></div>
  </section>
  <div class="footer"><span id="page" class="page">No page selected</span><span id="latency"></span></div>
</main>
<input id="keyboardCapture" class="keyboard-capture" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-hidden="true" />
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const stage = document.getElementById('stage');
  const previewA = document.getElementById('previewA');
  const previewB = document.getElementById('previewB');
  const previewImages = [previewA, previewB];
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');
  const dot = document.getElementById('dot');
  const overlay = document.getElementById('overlay');
  const notice = document.getElementById('notice');
  const page = document.getElementById('page');
  const latency = document.getElementById('latency');
  const back = document.getElementById('back');
  const refresh = document.getElementById('refresh');
  const reconnect = document.getElementById('reconnect');
  const keyboardCapture = document.getElementById('keyboardCapture');

  let currentGeneration;
  let screenshotSize;
  let pendingGeneration;
  let pendingScreenshotSize;
  let pendingPagePath;
  let pendingCaptureLatencyMs;
  let pendingSource;
  let pendingImage;
  let activeImage = previewA;
  let acknowledgedGeneration;
  let noticeTimer;
  let pointer;
  let wheelBatch;
  let wheelTimer;
  let typing = false;
  // A text-entry session survives the short Interacting/Updating states caused
  // by each real Automator input and its follow-up screenshot. Otherwise the
  // hidden input would be cleared between consecutive keystrokes.
  let typingSession = false;
  let exitTypingRequested = false;
  // Keep DOM gesture recognition aligned with the tested interaction policy.
  // This Webview cannot import the extension bundle, so these values are
  // injected from GestureController rather than independently maintained.
  const TAP_MAX_DISTANCE_PX = ${DEFAULT_TAP_MAX_DISTANCE_PX};
  const TAP_MAX_DURATION_MS = ${DEFAULT_TAP_MAX_DURATION_MS};
  const SWIPE_MIN_DISTANCE_PX = ${DEFAULT_SWIPE_MIN_DISTANCE_PX};
  const SWIPE_MAX_DURATION_MS = ${DEFAULT_SWIPE_MAX_DURATION_MS};
  const WHEEL_IDLE_MS = ${DEFAULT_WHEEL_IDLE_MS};
  const WHEEL_MIN_MAGNITUDE_PX = ${DEFAULT_WHEEL_MIN_MAGNITUDE_PX};

  function isPositiveFinite(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
  }

  function validGeneration(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function postControl(type) {
    vscode.postMessage({ type: type });
  }

  function showNotice(message) {
    notice.textContent = String(message || '');
    notice.classList.toggle('visible', Boolean(message));
    if (noticeTimer) window.clearTimeout(noticeTimer);
    if (message) {
      noticeTimer = window.setTimeout(() => notice.classList.remove('visible'), 6000);
    }
  }

  function acknowledge(generation) {
    if (!validGeneration(generation) || acknowledgedGeneration === generation) return;
    acknowledgedGeneration = generation;
    vscode.postMessage({ type: 'previewRendered', generation: generation });
  }

  function screenshotDimensions() {
    if (screenshotSize && isPositiveFinite(screenshotSize.width) && isPositiveFinite(screenshotSize.height)) {
      return screenshotSize;
    }
    if (isPositiveFinite(activeImage.naturalWidth) && isPositiveFinite(activeImage.naturalHeight)) {
      return { width: activeImage.naturalWidth, height: activeImage.naturalHeight };
    }
    return undefined;
  }

  function contains(rect, x, y) {
    return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
  }

  // Converts a client point through the fitted image and rejects letterbox bars.
  function mapClientToScreenshot(clientX, clientY) {
    // The old frame stays visible while its successor is decoding. Do not send an
    // interaction which would be bound to a frame the session has already replaced.
    if (!currentGeneration || pendingGeneration !== undefined) return undefined;
    const dimensions = screenshotDimensions();
    const stageRect = stage.getBoundingClientRect();
    const imageRect = activeImage.getBoundingClientRect();
    if (!dimensions || stageRect.width <= 0 || stageRect.height <= 0 || imageRect.width <= 0 || imageRect.height <= 0) return undefined;
    if (!contains(stageRect, clientX, clientY)) return undefined;
    const scale = Math.min(imageRect.width / dimensions.width, imageRect.height / dimensions.height);
    if (!Number.isFinite(scale) || scale <= 0) return undefined;
    const content = {
      left: imageRect.left + (imageRect.width - dimensions.width * scale) / 2,
      top: imageRect.top + (imageRect.height - dimensions.height * scale) / 2,
      width: dimensions.width * scale,
      height: dimensions.height * scale
    };
    if (!contains(content, clientX, clientY)) return undefined;
    const nx = Math.max(0, Math.min(1, (clientX - content.left) / content.width));
    const ny = Math.max(0, Math.min(1, (clientY - content.top) / content.height));
    const width = Math.max(1, Math.round(dimensions.width));
    const height = Math.max(1, Math.round(dimensions.height));
    return {
      x: Math.max(0, Math.min(width - 1, Math.round(nx * (width - 1)))),
      y: Math.max(0, Math.min(height - 1, Math.round(ny * (height - 1))))
    };
  }

  function capDelta(value) {
    return Math.max(-10000, Math.min(10000, Number.isFinite(value) ? value : 0));
  }

  function emitTap(clientX, clientY) {
    const point = mapClientToScreenshot(clientX, clientY);
    if (point && validGeneration(currentGeneration)) {
      vscode.postMessage({ type: 'tap', generation: currentGeneration, screenshotX: point.x, screenshotY: point.y });
    }
  }

  function emitScroll(clientX, clientY, deltaX, deltaY) {
    const point = mapClientToScreenshot(clientX, clientY);
    const boundedDeltaX = capDelta(deltaX);
    const boundedDeltaY = capDelta(deltaY);
    if (point && validGeneration(currentGeneration) && Math.hypot(boundedDeltaX, boundedDeltaY) >= WHEEL_MIN_MAGNITUDE_PX) {
      vscode.postMessage({ type: 'scroll', generation: currentGeneration, screenshotX: point.x, screenshotY: point.y, deltaX: boundedDeltaX, deltaY: boundedDeltaY });
    }
  }

  function flushWheel() {
    if (!wheelBatch) return;
    const batch = wheelBatch;
    wheelBatch = undefined;
    wheelTimer = undefined;
    emitScroll(batch.clientX, batch.clientY, batch.deltaX, batch.deltaY);
  }

  function normalizeWheelDelta(event) {
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    return { x: event.deltaX * multiplier, y: event.deltaY * multiplier };
  }

  back.addEventListener('click', () => postControl('back'));
  refresh.addEventListener('click', () => postControl('refresh'));
  reconnect.addEventListener('click', () => postControl('reconnect'));

  function commitPendingPreview() {
    if (!pendingImage || !validGeneration(pendingGeneration)) return;
    const nextImage = pendingImage;
    const generation = pendingGeneration;
    activeImage.classList.remove('visible');
    nextImage.classList.add('visible');
    activeImage = nextImage;
    currentGeneration = generation;
    screenshotSize = pendingScreenshotSize;
    page.textContent = pendingPagePath || 'Current page';
    latency.textContent = Number.isFinite(pendingCaptureLatencyMs) ? 'Captured in ' + pendingCaptureLatencyMs + ' ms' : '';
    pendingGeneration = undefined;
    pendingScreenshotSize = undefined;
    pendingPagePath = undefined;
    pendingCaptureLatencyMs = undefined;
    pendingSource = undefined;
    pendingImage = undefined;
    window.setTimeout(() => acknowledge(generation), 0);
  }

  previewImages.forEach((candidate) => {
    candidate.addEventListener('load', () => {
      if (candidate !== pendingImage || candidate.src !== pendingSource) return;
      commitPendingPreview();
    });
    candidate.addEventListener('error', () => {
      if (candidate !== pendingImage) return;
      pendingGeneration = undefined;
      pendingScreenshotSize = undefined;
      pendingPagePath = undefined;
      pendingCaptureLatencyMs = undefined;
      pendingSource = undefined;
      pendingImage = undefined;
      showNotice('The latest simulator screenshot could not be displayed.');
    });
  });

  function previewSize(value) {
    if (!value || !isPositiveFinite(value.width) || !isPositiveFinite(value.height)) {
      return undefined;
    }
    return { width: value.width, height: value.height };
  }

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const delta = normalizeWheelDelta(event);
    if (!wheelBatch) {
      wheelBatch = { clientX: event.clientX, clientY: event.clientY, deltaX: 0, deltaY: 0 };
    }
    wheelBatch.clientX = event.clientX;
    wheelBatch.clientY = event.clientY;
    wheelBatch.deltaX += delta.x;
    wheelBatch.deltaY += delta.y;
    if (wheelTimer) window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(flushWheel, WHEEL_IDLE_MS);
  }, { passive: false });

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    // A sequence which began in an image letterbox is never a simulator input,
    // even if it ends over the fitted screenshot.
    if (!mapClientToScreenshot(event.clientX, event.clientY)) return;
    pointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, maxDistance: 0, startedAt: Date.now() };
    try { stage.setPointerCapture(event.pointerId); } catch (_) { }
  });

  stage.addEventListener('pointermove', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    pointer.maxDistance = Math.max(pointer.maxDistance, Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY));
  });

  stage.addEventListener('pointerup', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const active = pointer;
    pointer = undefined;
    try { stage.releasePointerCapture(event.pointerId); } catch (_) { }
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    const maxDistance = Math.max(active.maxDistance, Math.hypot(dx, dy));
    const duration = Math.max(0, Date.now() - active.startedAt);
    const finalDistance = Math.hypot(dx, dy);
    let kind;
    if (maxDistance <= TAP_MAX_DISTANCE_PX) {
      kind = duration <= TAP_MAX_DURATION_MS ? 'tap' : 'hold';
    } else if (finalDistance >= SWIPE_MIN_DISTANCE_PX && duration <= SWIPE_MAX_DURATION_MS) {
      kind = 'swipe';
    } else {
      kind = 'drag';
    }
    if (kind === 'tap') {
      emitTap(event.clientX, event.clientY);
    } else if ((kind === 'swipe' || kind === 'drag') && (dx || dy)) {
      // The public runtime API is scroll-based. Both tested drag and swipe
      // classifications therefore become a page-scroll request.
      emitScroll(event.clientX, event.clientY, -dx, -dy);
    }
  });

  stage.addEventListener('pointercancel', (event) => {
    if (pointer && event.pointerId === pointer.id) pointer = undefined;
  });

  keyboardCapture.addEventListener('input', () => {
    if (!typingSession || !validGeneration(currentGeneration)) return;
    vscode.postMessage({ type: 'input', generation: currentGeneration, value: keyboardCapture.value });
  });
  keyboardCapture.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      typing = false;
      typingSession = false;
      exitTypingRequested = true;
      keyboardCapture.blur();
      postControl('exitTyping');
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'state') {
      status.textContent = message.error ? String(message.error) : String(message.label || message.state || 'Disconnected');
      status.className = message.error ? 'error' : '';
      dot.className = 'dot ' + String(message.state || '');
      overlay.classList.toggle('visible', message.state === 'updating' || message.state === 'connecting');
      typing = message.state === 'typing';
      if (typing) {
        if (!typingSession && !exitTypingRequested) {
          typingSession = true;
          keyboardCapture.value = '';
        }
        if (typingSession) keyboardCapture.focus();
      } else if (message.state === 'connected' || message.state === 'disconnected' || message.state === 'error') {
        typingSession = false;
        exitTypingRequested = false;
        keyboardCapture.blur();
      }
      return;
    }
    if (message.type === 'preview') {
      if (!validGeneration(message.generation) || typeof message.data !== 'string' || !message.data) return;
      if ((validGeneration(currentGeneration) && message.generation < currentGeneration)
        || (validGeneration(pendingGeneration) && message.generation <= pendingGeneration)) return;
      pendingGeneration = message.generation;
      pendingScreenshotSize = previewSize(message.screenshotSize);
      pendingPagePath = typeof message.pagePath === 'string' ? message.pagePath : undefined;
      pendingCaptureLatencyMs = message.captureLatencyMs;
      empty.style.display = 'none';
      const nextSrc = 'data:image/png;base64,' + message.data;
      const nextImage = activeImage === previewA ? previewB : previewA;
      pendingImage = nextImage;
      pendingSource = nextSrc;
      if (nextImage.src === nextSrc && nextImage.complete && nextImage.naturalWidth > 0) {
        commitPendingPreview();
      } else {
        nextImage.src = nextSrc;
      }
      return;
    }
    if (message.type === 'notice') {
      showNotice(message.message);
      return;
    }
    if (message.type === 'error') {
      status.textContent = String(message.message || 'Preview error');
      status.className = 'error';
      dot.className = 'dot error';
      overlay.classList.remove('visible');
      showNotice(message.message);
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}
