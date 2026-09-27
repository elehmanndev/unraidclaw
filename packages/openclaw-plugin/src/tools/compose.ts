// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult, checkParams } from "./util.js";

const project = { type: "string", description: "Compose project name, as unraid_compose_list shows it, e.g. 'mealplan'." };
const server = { type: "string", description: "Target server name (optional, uses default server)" };

export function registerComposeTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_compose_list",
    description:
      "List the Docker Compose stacks on the Unraid server with their services and state. managedBy says what can be done: 'local' stacks can be edited and redeployed; 'git' stacks are a git checkout deployed from their repository, so they can only be started, stopped or restarted here and changes go through the repository; 'unmanaged' stacks have no compose files on the server.",
    parameters: { type: "object", properties: { server }, additionalProperties: false },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["server"]);
        return textResult(await getClient(params.server as string | undefined).get("/api/compose"));
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "unraid_compose_get",
    description:
      "Read a Compose stack: its compose files, with the values of secret-looking keys and of its .env file shown as ***, the keys its .env defines, its services, and for a git stack where its repository is.",
    parameters: { type: "object", properties: { project, server }, required: ["project"], additionalProperties: false },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["project", "server"]);
        return textResult(await getClient(params.server as string | undefined).get(`/api/compose/${encodeURIComponent(String(params.project))}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "unraid_compose_edit",
    description:
      "Replace a local Compose stack's compose file and redeploy it. Pass the whole new file as content, based on what unraid_compose_get returned; values still shown as *** keep the value the file has now, so secrets never need to be typed. Compose checks the new file first, the old one is backed up, and if a service that was running does not stay up, the old file is put back and redeployed and the service logs are returned. Refused for git stacks: change those in their repository. Always call it with dryRun=true first and show the user the diff and planned actions.",
    parameters: {
      type: "object",
      properties: {
        project,
        content: { type: "string", description: "The whole new compose file." },
        file: { type: "string", description: "File to replace, by name, when the stack has several (default: the first)." },
        redeploy: { type: "boolean", description: "Redeploy after saving (default: true)." },
        dryRun: { type: "boolean", description: "Check the file and show the diff and what a redeploy would do, without changing anything (default: false)" },
        server,
      },
      required: ["project", "content"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["project", "content", "file", "redeploy", "dryRun", "server"]);
        const body: Record<string, unknown> = {};
        for (const key of ["content", "file", "redeploy", "dryRun"]) if (params[key] !== undefined) body[key] = params[key];
        return textResult(await getClient(params.server as string | undefined).post(`/api/compose/${encodeURIComponent(String(params.project))}/edit`, body));
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "unraid_compose_action",
    description:
      "Start, stop or restart a Compose stack's services (any stack), or pull its images or redeploy it with 'up' (local stacks only; git stacks are deployed from their repository). Limit it to some services with services. dryRun=true shows the containers affected, and for 'up' what Compose would recreate.",
    parameters: {
      type: "object",
      properties: {
        project,
        action: { type: "string", enum: ["start", "stop", "restart", "pull", "up"] },
        services: { type: "array", items: { type: "string" }, description: "Service names to act on (default: all)." },
        dryRun: { type: "boolean", description: "Report what would happen without doing it (default: false)" },
        server,
      },
      required: ["project", "action"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["project", "action", "services", "dryRun", "server"]);
        const body: Record<string, unknown> = { action: params.action };
        if (params.services !== undefined) body.services = params.services;
        if (params.dryRun !== undefined) body.dryRun = params.dryRun;
        return textResult(await getClient(params.server as string | undefined).post(`/api/compose/${encodeURIComponent(String(params.project))}/action`, body));
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });
}
