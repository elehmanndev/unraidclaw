// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { ClientResolver } from "../registry.js";
import { textResult, errorResult } from "./util.js";

export function registerDockerTools(api: any, getClient: ClientResolver): void {
  api.registerTool({
    name: "unraid_docker_list",
    description: "List all Docker containers on the Unraid server with their current state, image, and status.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get("/api/docker/containers"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_inspect",
    description: "Get detailed information about a specific Docker container including ports, mounts, and network mode.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["id"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        return textResult(await getClient(params.server as string | undefined).get(`/api/docker/containers/${params.id}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_logs",
    description: "Get logs from a specific Docker container.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
        tail: { type: "integer", minimum: 1, maximum: 10000, description: "Number of lines from the end (default: 100)" },
        since: { type: "string", description: "Show logs since timestamp (e.g., 2024-01-01T00:00:00Z)" },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["id"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const query: Record<string, string> = {};
        if (params.tail) query.tail = String(params.tail);
        if (params.since) query.since = String(params.since);
        return textResult(await getClient(params.server as string | undefined).get(`/api/docker/containers/${params.id}/logs`, query));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  for (const [toolName, desc, action] of [
    ["unraid_docker_start", "Start a stopped Docker container.", "start"],
    ["unraid_docker_stop", "Stop a running Docker container.", "stop"],
    ["unraid_docker_restart", "Restart a Docker container.", "restart"],
    ["unraid_docker_pause", "Pause a running Docker container (freeze all processes).", "pause"],
    ["unraid_docker_unpause", "Unpause a paused Docker container.", "unpause"],
  ] as const) {
    api.registerTool({
      name: toolName,
      description: desc,
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Container ID or name" },
          server: { type: "string", description: "Target server name (optional, uses default server)" },
        },
        required: ["id"],
      },
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          return textResult(await getClient(params.server as string | undefined).post(`/api/docker/containers/${params.id}/${action}`));
        } catch (err) {
          return errorResult(err);
        }
      },
    });
  }

  api.registerTool({
    name: "unraid_docker_remove",
    description: "Remove a Docker container. Pass force=true to stop and remove in one step. This is a destructive operation that cannot be undone.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Container ID or name" },
        force: { type: "boolean", description: "Stop the container before removing (default: false)" },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["id"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const query = params.force ? "?force=true" : "";
        return textResult(await getClient(params.server as string | undefined).delete(`/api/docker/containers/${params.id}${query}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  api.registerTool({
    name: "unraid_docker_create",
    description:
      "Create and start a new Docker container on the Unraid server. Specify image, optional name, port mappings, volume mounts, environment variables, restart policy, network, and Unraid's advanced settings: extra docker run options, post arguments, a fixed IP on a custom network, privileged mode, CPU pinning and host devices.",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "Docker image to use (e.g. vikunja/vikunja:latest)" },
        name: { type: "string", description: "Optional container name" },
        ports: {
          type: "array",
          items: { type: "string" },
          description: "Port mappings in host:container format (e.g. ['3456:3456'])",
        },
        volumes: {
          type: "array",
          items: { type: "string" },
          description: "Volume mounts in host:container format (e.g. ['/mnt/cache/appdata/vikunja:/app/vikunja'])",
        },
        env: {
          type: "array",
          items: { type: "string" },
          description: "Environment variables in KEY=VALUE format",
        },
        restart: {
          type: "string",
          enum: ["no", "always", "unless-stopped", "on-failure"],
          description: "Restart policy (default: unless-stopped)",
        },
        network: { type: "string", description: "Network to attach the container to" },
        extraArgs: {
          type: "string",
          description:
            "Extra docker run options, space separated, as Unraid's Extra Parameters field (e.g. '--gpus all', '--cap-add=SYS_ADMIN --memory=8g', '--hostname=media'). Must start with an option. Only letters, digits, : . , / + = _ - and single spaces; no quotes or shell characters.",
        },
        postArgs: {
          type: "string",
          description:
            "Arguments appended after the image as the container command, space separated, as Unraid's Post Arguments field (e.g. '--config /config/app.yml'). Same character rules as extraArgs.",
        },
        staticIp: {
          type: "string",
          description: "Fixed IPv4 or IPv6 address for the container (Unraid's Fixed IP field). Needs a user-defined network such as a macvlan, ipvlan or custom bridge; docker refuses it on bridge, host and none.",
        },
        privileged: { type: "boolean", description: "Run the container privileged, with full host access (default: false)" },
        cpuset: { type: "string", description: "CPUs the container may run on, as docker --cpuset-cpus reads it (e.g. '0-3,8')" },
        devices: {
          type: "array",
          items: { type: "string" },
          description: "Host devices to pass through, as docker --device reads them (e.g. ['/dev/dri', '/dev/ttyUSB0:/dev/ttyUSB0:rwm'])",
        },
        server: { type: "string", description: "Target server name (optional, uses default server)" },
      },
      required: ["image"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const { server, ...body } = params;
        return textResult(await getClient(server as string | undefined).post("/api/docker/containers", body));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
