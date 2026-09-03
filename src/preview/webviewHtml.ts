import * as vscode from "vscode";

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
  .root { min-height: 100vh; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: 10px; padding: 10px; }
  .header, .footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; font-size: 12px; }
  .status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: 0 0 auto; }
  .dot.connected { background: var(--vscode-testing-iconPassed); }
  .dot.connecting, .dot.updating { background: var(--vscode-editorWarning-foreground); }
  .dot.error { background: var(--vscode-testing-iconFailed); }
  .preview-stage { min-height: 180px; display: grid; place-items: center; overflow: hidden; position: relative; background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .preview-image { display: none; max-width: 100%; max-height: calc(100vh - 98px); width: auto; height: auto; object-fit: contain; image-rendering: auto; }
  .preview-image.visible { display: block; }
  .empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 24px 12px; line-height: 1.5; }
  .overlay { display: none; position: absolute; inset: 0; align-items: center; justify-content: center; background: color-mix(in srgb, var(--vscode-editor-background) 48%, transparent); font-size: 13px; }
  .overlay.visible { display: flex; }
  .error { color: var(--vscode-testing-iconFailed); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .page { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { appearance: none; border: 0; padding: 2px 6px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<main class="root">
  <div class="header">
    <div class="status"><span id="dot" class="dot"></span><span id="status">Disconnected</span></div>
    <button id="reconnect" title="Reconnect to WeChat DevTools">Reconnect</button>
  </div>
  <section class="preview-stage">
    <img id="preview" class="preview-image" alt="Mini Program simulator preview" />
    <div id="empty" class="empty">Start a preview to show the real WeChat simulator.</div>
    <div id="overlay" class="overlay">Updating...</div>
  </section>
  <div class="footer"><span id="page" class="page">No page selected</span><span id="latency"></span></div>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const image = document.getElementById('preview');
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');
  const dot = document.getElementById('dot');
  const overlay = document.getElementById('overlay');
  const page = document.getElementById('page');
  const latency = document.getElementById('latency');
  const reconnect = document.getElementById('reconnect');
  let pendingGeneration;

  reconnect.addEventListener('click', () => vscode.postMessage({ type: 'reconnect' }));
  image.addEventListener('load', () => {
    if (pendingGeneration !== undefined) {
      vscode.postMessage({ type: 'previewRendered', generation: pendingGeneration });
      pendingGeneration = undefined;
    }
  });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || !message.type) return;
    if (message.type === 'state') {
      status.textContent = message.label;
      dot.className = 'dot ' + message.state;
      overlay.classList.toggle('visible', message.state === 'updating' || message.state === 'connecting');
      if (message.error) status.className = 'error'; else status.className = '';
      return;
    }
    if (message.type === 'preview') {
      pendingGeneration = message.generation;
      page.textContent = message.pagePath || 'Current page';
      latency.textContent = message.captureLatencyMs ? 'Captured in ' + message.captureLatencyMs + ' ms' : '';
      empty.style.display = 'none';
      image.classList.add('visible');
      image.src = 'data:image/png;base64,' + message.data;
      return;
    }
    if (message.type === 'error') {
      status.textContent = message.message;
      status.className = 'error';
      dot.className = 'dot error';
      overlay.classList.remove('visible');
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
