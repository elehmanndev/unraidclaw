// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult, checkParams } from "./util.js";

export function registerAppTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_app_list",
    description:
      "List the installed containers whose own web API can be called with unraid_app_request: where requests go by default, the ports each exposes, and whether the user saved a key for it on UnraidClaw's App Keys tab (never the key itself).",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["server"]);
        return textResult(await getClient(params.server as string | undefined).get("/api/apps"));
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "unraid_app_request",
    description:
      "Send one HTTP request to the web API of an app installed on the Unraid server, such as Immich, Jellyfin, Nginx Proxy Manager, Sonarr or Home Assistant, to read or change things inside the app rather than its container settings. Name the installed container (from unraid_docker_list or unraid_app_list) and give the path; the server finds the container's address and port itself, so never pass a host. If the user saved a key for the app on UnraidClaw's App Keys tab, it is added automatically and is never shown: do not ask the user for keys or passwords in chat. If the app answers 401 or 403, tell the user to add or check its key under Settings, UnraidClaw, App Keys. Check the app's own API documentation for paths and bodies, prefer GET to look first, and for anything that changes or deletes data call it with dryRun=true, show the user the request, and ask before sending it for real. The app's own status code is in the result; a 4xx from the app is not a failure of this tool.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Installed container name, e.g. 'immich'." },
        method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method (default: GET)" },
        path: { type: "string", description: "Path on the app starting with '/', e.g. '/api/server/version'. May include a query string." },
        query: { type: "object", description: "Query parameters to add, e.g. {\"page\": 2}.", additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } },
        headers: { type: "object", description: "Extra request headers, e.g. {\"accept\": \"text/html\"}. The saved key's header cannot be set here.", additionalProperties: { type: "string" } },
        body: { description: "Request body. A string is sent as is; an object or array is sent as JSON. On the command line, pass it as JSON." },
        port: { type: "number", description: "Container-side port, only when the app listens on several and unraid_app_list shows no default." },
        https: { type: "boolean", description: "Use HTTPS (default: what the container's WebUI link uses)." },
        timeoutMs: { type: "number", description: "Give up after this many milliseconds (1000 to 300000, default 30000)." },
        dryRun: { type: "boolean", description: "Show the exact request, with the key hidden, without sending it (default: false)" },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["name", "path"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["name", "method", "path", "query", "headers", "body", "port", "https", "timeoutMs", "dryRun", "server"]);
        const body: Record<string, unknown> = {};
        for (const key of ["method", "path", "query", "headers", "body", "port", "https", "timeoutMs", "dryRun"]) {
          if (params[key] !== undefined) body[key] = params[key];
        }
        return textResult(
          await getClient(params.server as string | undefined).post(
            `/api/apps/${encodeURIComponent(String(params.name))}/request`,
            body
          )
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });
}
