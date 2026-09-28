// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult, checkParams } from "./util.js";

const server = { type: "string", description: "Target server name (optional, uses default server)" };
const stringMap = {
  type: "object",
  additionalProperties: { anyOf: [{ type: "string" }, { type: "null" }] },
};

export function registerProfileTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_profile_get",
    description:
      "Read the owner's setup profile: the values every new app install fills in when you do not set them (variables such as TZ, PUID, PGID and UMASK, host folders for container paths such as /media, and the appdata folder), plus the owner's own notes on how they like things set up. Also returns a suggested profile built from the containers already installed, the evidence behind it, and notices such as containers on an old timezone. Read it before installing or setting up an app and follow its notes. If the profile is empty, offer to save the suggested one with unraid_profile_update after showing it to the user.",
    parameters: { type: "object", properties: { server }, additionalProperties: false },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["server"]);
        return textResult(await getClient(params.server as string | undefined).get("/api/profile"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_profile_update",
    description:
      "Change the owner's setup profile. Fields left out stay as they are. Within variables and paths only the keys given change, and null removes a key; an empty appdataRoot or notes clears it. variables are matched to template variables by name, paths to template paths by the path inside the container, and appdataRoot moves any template default under a pool's appdata folder. notes are free text for agents and are never applied. Installs use the profile from the next install on; nothing already installed changes. Do not put passwords or API keys in it. Pass dryRun=true to see the result without saving.",
    parameters: {
      type: "object",
      properties: {
        variables: { ...stringMap, description: "Variable values by name, e.g. {\"TZ\": \"Europe/Madrid\", \"PUID\": \"99\", \"PGID\": \"100\", \"UMASK\": \"022\"}. null removes one." },
        paths: { ...stringMap, description: "Host folders by the path inside the container, e.g. {\"/media\": \"/mnt/user/Media\", \"/downloads\": \"/mnt/user/downloads\"}. null removes one." },
        appdataRoot: { type: "string", description: "Where app data lives, e.g. /mnt/user/appdata or /mnt/cache/appdata. An empty string clears it." },
        notes: { type: "string", description: "The owner's conventions in their own words, e.g. how apps are exposed or named. An empty string clears them." },
        dryRun: { type: "boolean", description: "Return the resulting profile without saving it (default: false)." },
        server,
      },
      additionalProperties: false,
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        checkParams(params, ["variables", "paths", "appdataRoot", "notes", "dryRun", "server"]);
        const body: Record<string, unknown> = {};
        for (const key of ["variables", "paths", "appdataRoot", "notes", "dryRun"]) {
          if (params[key] !== undefined) body[key] = params[key];
        }
        return textResult(await getClient(params.server as string | undefined).post("/api/profile", body));
      } catch (err) {
        return errorResult(err);
      }
    },
  }, { optional: true });
}
