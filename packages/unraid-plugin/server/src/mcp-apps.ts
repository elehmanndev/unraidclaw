// MCP Apps (io.modelcontextprotocol/ui, spec 2026-01-26): one bundled HTML view
// that hosts such as Claude show in a sandboxed iframe for every mutating tool
// with a dryRun parameter. The view shows the preview and, on a dry run, offers
// an Apply button that asks the host to repeat the same call with dryRun false.
// The host proxies that call back to /mcp, so the API key and the permission
// matrix still decide what it may do. Hosts without MCP Apps ignore the _meta
// and keep getting the plain text result.

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const DRY_RUN_VIEW_URI = "ui://unraidclaw/dry-run";

export const DRY_RUN_VIEW = {
  uri: DRY_RUN_VIEW_URI,
  name: "unraidclaw_dry_run",
  description: "Preview of a change on the Unraid server, with an Apply button after a dry run.",
  mimeType: MCP_APP_MIME_TYPE,
};

/** True for tools that get the view: they mutate and accept a dryRun flag. */
export function usesDryRunView(inputSchema: { properties?: Record<string, unknown> }, readOnly: boolean): boolean {
  return !readOnly && !!inputSchema.properties && "dryRun" in inputSchema.properties;
}

// The view builds every node with textContent and never parses tool output as
// HTML, so a container name or log line cannot inject markup. It loads nothing
// from the network: no csp metadata means the host applies its restrictive
// default (no connect-src, inline script and style only).
const VIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UnraidClaw</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 12px;
    font-family: var(--font-sans, system-ui, sans-serif); font-size: 14px;
    color: var(--color-text-primary, CanvasText);
    background: var(--color-background-primary, Canvas);
  }
  h1 { font-size: 15px; margin: 0 0 8px; display: flex; gap: 8px; align-items: center; }
  .badge { font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; border: 1px solid currentColor; opacity: .8; }
  .ok { color: #1a7f37; } .warn { color: #9a6700; } .bad { color: #cf222e; }
  ul { margin: 4px 0 8px; padding-left: 18px; }
  pre {
    margin: 4px 0 8px; padding: 8px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word;
    font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px;
    background: var(--color-background-secondary, rgba(127,127,127,.12)); border-radius: 6px;
  }
  h2 { font-size: 13px; margin: 10px 0 2px; }
  details { margin-top: 8px; }
  .actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: #cf222e; border-color: #cf222e; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .muted { opacity: .7; font-size: 12px; }
</style>
</head>
<body>
<h1><span id="title">UnraidClaw</span><span id="badge" class="badge" hidden></span></h1>
<div id="body"><p class="muted">Waiting for the result...</p></div>
<div class="actions" id="actions" hidden>
  <button id="apply" class="primary" type="button">Apply</button>
  <button id="cancel" type="button" hidden>Cancel</button>
  <span id="note" class="muted"></span>
</div>
<script>
(function () {
  "use strict";
  var nextId = 1;
  var pending = {};
  var toolName = null;
  var toolArgs = null;
  var armed = false;

  function send(message) { window.parent.postMessage(message, "*"); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params }); }

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function str(value) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
  function messages(list) {
    return list.map(function (item) {
      if (item && typeof item === "object") return (item.code ? item.code + ": " : "") + (item.message || str(item));
      return String(item);
    });
  }
  function section(parent, heading, items, cls) {
    if (!items || !items.length) return;
    parent.appendChild(el("h2", heading, cls));
    var ul = el("ul");
    items.forEach(function (text) { ul.appendChild(el("li", text)); });
    parent.appendChild(ul);
  }
  function block(parent, heading, value) {
    if (value === undefined || value === null || value === "") return;
    parent.appendChild(el("h2", heading));
    parent.appendChild(el("pre", str(value)));
  }

  function textOf(result) {
    var parts = (result && result.content) || [];
    for (var i = 0; i < parts.length; i++) if (parts[i].type === "text") return parts[i].text;
    return "";
  }

  function render(result) {
    var body = document.getElementById("body");
    var badge = document.getElementById("badge");
    var actions = document.getElementById("actions");
    body.textContent = "";
    var text = textOf(result);
    var data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    var dryRun = !!(toolArgs && toolArgs.dryRun === true);
    var failed = !!(result && result.isError);

    badge.hidden = false;
    badge.textContent = failed ? "Failed" : dryRun ? "Dry run" : "Done";
    badge.className = "badge " + (failed ? "bad" : dryRun ? "warn" : "ok");

    if (!data || typeof data !== "object") {
      body.appendChild(el("pre", text || "No output"));
    } else {
      var blockers = messages(data.blockers || (data.plan && data.plan.blockers) || []);
      var warnings = messages(data.warnings || (data.plan && data.plan.warnings) || []);
      if (data.summary) body.appendChild(el("p", str(data.summary)));
      section(body, "Blocked", blockers, "bad");
      section(body, "Warnings", warnings, "warn");
      block(body, "Changes", data.changes || (data.plan && data.plan.changes));
      block(body, "Diff", data.diff);
      block(body, "Command", data.command || (data.plan && data.plan.command));
      if (data.reclaimableBytes !== undefined) body.appendChild(el("p", "Reclaimable: " + (data.reclaimableBytes / 1048576).toFixed(1) + " MiB"));
      if (data.verified !== undefined && !dryRun) body.appendChild(el("p", data.verified ? "Verified on the server." : "Not verified yet; the change may still be in progress.", data.verified ? "ok" : "warn"));
      var details = el("details");
      details.appendChild(el("summary", "Full response"));
      details.appendChild(el("pre", str(data)));
      body.appendChild(details);
    }

    var canApply = dryRun && !failed && toolName && !(data && (data.blockers || (data.plan && data.plan.blockers) || []).length);
    actions.hidden = !canApply;
    disarm();
  }

  function disarm() {
    armed = false;
    document.getElementById("apply").textContent = "Apply";
    document.getElementById("cancel").hidden = true;
    document.getElementById("note").textContent = "Runs the same call without dryRun.";
  }

  document.getElementById("cancel").addEventListener("click", disarm);
  document.getElementById("apply").addEventListener("click", function () {
    // Two clicks: the first arms the button, the second sends. A stray tap
    // never applies a change.
    if (!armed) {
      armed = true;
      this.textContent = "Confirm apply";
      document.getElementById("cancel").hidden = false;
      document.getElementById("note").textContent = "This changes the server.";
      return;
    }
    var button = this;
    var args = {};
    Object.keys(toolArgs).forEach(function (k) { args[k] = toolArgs[k]; });
    args.dryRun = false;
    button.disabled = true;
    document.getElementById("cancel").hidden = true;
    document.getElementById("note").textContent = "Applying...";
    request("tools/call", { name: toolName, arguments: args }).then(function (result) {
      toolArgs = args;
      button.disabled = false;
      render(result);
      // Tell the model the user applied it, so it does not repeat the call.
      // Hosts may refuse this; the change is already done either way.
      request("ui/update-model-context", { content: [{ type: "text", text: "The user applied " + toolName + " from the preview. Result: " + textOf(result) }] }).catch(function () {});
    }, function (error) {
      button.disabled = false;
      disarm();
      document.getElementById("note").textContent = "The host refused the call: " + (error && error.message ? error.message : "unknown error");
    });
  });

  function applyHostContext(context) {
    if (!context) return;
    if (context.theme) document.documentElement.style.colorScheme = context.theme;
    var vars = context.styles && context.styles.variables;
    if (vars) Object.keys(vars).forEach(function (k) { if (vars[k]) document.documentElement.style.setProperty(k, vars[k]); });
    if (context.toolInfo && context.toolInfo.tool && context.toolInfo.tool.name) setTool(context.toolInfo.tool.name);
  }
  function setTool(name) {
    toolName = name;
    document.getElementById("title").textContent = name.replace(/^unraid_/, "").replace(/_/g, " ");
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && pending[msg.id] && !msg.method) {
      var p = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      return;
    }
    switch (msg.method) {
      case "ui/notifications/tool-input":
        toolArgs = (msg.params && msg.params.arguments) || {};
        break;
      case "ui/notifications/tool-result":
        render(msg.params);
        break;
      case "ui/notifications/host-context-changed":
        applyHostContext(msg.params);
        break;
      case "ui/resource-teardown":
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
        break;
    }
  });

  new ResizeObserver(function () {
    notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  }).observe(document.body);

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "unraidclaw-dry-run", version: "1" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then(function (result) {
    applyHostContext(result && result.hostContext);
    notify("ui/notifications/initialized", {});
  });
})();
</script>
</body>
</html>
`;

export function readDryRunView() {
  return {
    contents: [{ uri: DRY_RUN_VIEW_URI, mimeType: MCP_APP_MIME_TYPE, text: VIEW_HTML, _meta: { ui: { prefersBorder: true } } }],
  };
}
