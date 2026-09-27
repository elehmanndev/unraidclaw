// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult, checkParams } from "./util.js";

const JOB_TOOLS = [
  "unraid_ca_install",
  "unraid_ca_update",
  "unraid_template_edit",
  "unraid_compose_action",
  "unraid_compose_edit",
  "unraid_plugin_install",
  "unraid_plugin_update",
];
const server = { type: "string", description: "Target server name (optional, uses default server)" };

export function registerJobTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_job_start",
    description:
      "Run a long operation in the background instead of waiting for it: an app install or update, a container edit, a compose pull, redeploy or edit, or a plugin install or update. Pass the tool's name and the arguments you would give it directly. The job's ID comes back at once; check it with unraid_job_get. When the job finishes, the user gets an Unraid notification, which reaches their phone if Unraid's notifications are set up to. The tool's own permission still applies. Use it for anything that pulls an image or rebuilds a container, especially from a phone, and run the tool directly with dryRun=true first when it has one.",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", enum: JOB_TOOLS, description: "The tool to run." },
        arguments: { type: "object", description: "The tool's arguments, as you would pass them to it directly." },
        notify: { type: "boolean", description: "Send an Unraid notification when the job finishes (default: true)." },
        server,
      },
      required: ["tool"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["tool", "arguments", "notify", "server"]);
        const body: Record<string, unknown> = { tool: params.tool };
        if (params.arguments !== undefined) body.arguments = params.arguments;
        if (params.notify !== undefined) body.notify = params.notify;
        return textResult(await getClient(params.server as string | undefined).post("/api/jobs", body));
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "unraid_job_get",
    description: "Read a background job: queued, running, succeeded or failed, how long it took, whether its notification went out, and the tool's result or error.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Job ID from unraid_job_start." }, server },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["id", "server"]);
        return textResult(await getClient(params.server as string | undefined).get(`/api/jobs/${encodeURIComponent(String(params.id))}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });

  api.registerTool({
    name: "unraid_job_list",
    description: "List recent background jobs, newest first, with their status. Results are kept for the last 50 finished jobs and forgotten when the UnraidClaw service restarts.",
    parameters: { type: "object", properties: { server }, additionalProperties: false },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["server"]);
        return textResult(await getClient(params.server as string | undefined).get("/api/jobs"));
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });
}
