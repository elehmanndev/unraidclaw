---
name: unraidclaw
description: Manage your Unraid server through AI agents - 68 tools for Docker, Community Applications, container settings, app APIs, compose stacks, background jobs, a setup profile, Unraid plugins, VMs, array, shares, system, notifications, and more with permission control.
---

# UnraidClaw

Manage your Unraid server through AI agents with full permission control.

## What it does

UnraidClaw gives AI agents 68 tools across 18 categories to monitor and manage an Unraid server:

- **Docker** - List, inspect, start, stop, restart, pause, unpause, remove, and create containers
- **Community Applications** - Search the CA catalog, read an app's template, install an app as a container, update an installed app to a newer image, and remove one
- **Container Settings** - Read an installed container's saved settings, and change any of them and rebuild it the way the Docker tab does
- **App APIs** - Read or change things inside an installed app through its own web API, with the key the user saved for it
- **Compose Stacks** - List Docker Compose stacks, read their files with secrets hidden, start, stop and restart them, and edit and redeploy local ones
- **Background Jobs** - Run long installs, updates, rebuilds and redeploys in the background, with an Unraid notification when they finish
- **Setup Profile** - Read and change the owner's usual install settings, which every new app install fills in, and see the conventions the installed containers follow
- **Plugins** - List and inspect installed .plg plugins, install one from a URL, check for updates, update, and remove
- **VMs** - List, inspect, start, stop, force-stop, pause, resume, and reboot virtual machines
- **Array** - View array status, start/stop array, run parity checks
- **Disks** - List array data and parity disks, view temperature, status and available disk usage
- **Shares** - List shares, view details, update share settings (allocator, floor, split level, comment)
- **System** - System info, CPU/memory/uptime, list services, reboot, shutdown
- **Notifications** - List, create, archive, and delete notifications
- **Network** - View network interfaces and configuration
- **Users** - View current user info
- **Logs** - Read syslog entries
- **Health** - Server health check

Tools use a 40-key permission matrix (resource:action) configurable from the Unraid WebGUI; health requires no permission. Activity logging excludes the public health probe, successful MCP handshakes and MCP GET/DELETE responses with status 405. The gateway also has an optional MCP endpoint, off by default, that exposes the same tools to MCP clients; this plugin does not use it.

## Updating and removing an installed app

`unraid_ca_update` and `unraid_ca_remove` take the name of the installed container, the one on the Docker tab. That is often not the app's name in the Community Applications catalog, so call `unraid_docker_list` and use the name you find there. Use the installed container name, not a name inferred from the catalog.

Update keeps the configuration saved on the server, including anything the user changed in the WebGUI after installing, and puts the app back in the state it was in: running if it was running, stopped if it was stopped. Volumes the container has that its template does not mention are reattached, so the replacement uses the same volume data. It never deletes the old image and never touches appdata. If the pull fails the app keeps running on the image it has. An app that is paused or restarting is refused rather than updated into a state nobody asked for.

Remove deletes the container only. Appdata, Docker volumes, the image and the saved template all stay, so the app can be recreated with the same settings. Say that when the user asks whether their data is safe, and do not offer to delete any of it, because these tools cannot.

Both take `dryRun: true`. Use it first for a removal, and read the result back to the user before doing it for real.

## Creating a container by hand

`unraid_docker_create` takes `image` plus optional `name`, `ports`, `volumes`, `env`, `restart` and `network`. Six more fields match the advanced settings of Unraid's container form and are saved to the container's template, so the Docker tab shows them:

- `extraArgs` is Extra Parameters: docker run options, space separated, such as `--gpus all`, `--cap-add=SYS_ADMIN`, `--memory=8g` or `--hostname=media`. Put the network in `network`, not here.
- `postArgs` is Post Arguments: the command appended after the image, such as `--config /config/app.yml`.
- `staticIp` is a fixed IPv4 or IPv6 address. Docker only accepts it on a macvlan, ipvlan or custom bridge network, so pass `network` too; it is rejected on bridge, host and none.
- `privileged` is a boolean and defaults to false. Say so to the user before turning it on, since it gives the container full host access.
- `cpuset` pins CPUs, as `--cpuset-cpus` reads it, for example `0-3,8`.
- `devices` lists host devices, as `--device` reads them, for example `["/dev/dri"]` for hardware transcoding.

The two free-form fields accept only letters, digits, `: . , / + = _ -` and single spaces, because Unraid passes them to the shell unescaped when it rebuilds a container. Quotes and shell characters are rejected before docker runs. A container created with any of these settings in effect cannot later be rebuilt by `unraid_ca_update`; tell the user to update it from the Docker tab.

## Changing an installed container's settings

To change how an installed container runs, such as a port, a path, a variable, a device, its network or fixed IP, privileged mode or Extra Parameters, use `unraid_template_edit` rather than removing and recreating the container. Call `unraid_template_get` first to see what the template has, and use the installed container name from `unraid_docker_list`.

Name only what should change: settings and entries the request leaves out are kept as they are. An entry is found by its type and target, plus protocol for a port, so an entry that does not exist yet is added. To change a device, pass the current one as `replaces`.

Always run it with `dryRun: true` first. Show the user the changes and the command, and ask before running it for real. If the rebuilt container does not start or stops within a few seconds, the original comes back unchanged and the error carries the new container's last log lines. Read them, explain what went wrong, and propose a corrected edit.

This tool changes settings, not the app version, unless you pass `pull: true`: then it pulls the newest image for the tag and rebuilds on it. Use `unraid_ca_update` to update an app first; when it refuses because the container is privileged or has Extra Parameters or devices, update it with `unraid_template_edit` and `pull: true` and nothing else. Changing `Repository` to another tag pulls that tag.

## Following the owner's setup

Call `unraid_profile_get` before installing or setting up an app. Its `profile` holds the values `unraid_ca_install` fills in by itself for any field you leave unset: variables such as TZ, PUID, PGID and UMASK by name, host folders by the path inside the container, and appdata under `appdataRoot`. So do not pass those yourself unless the user wants something different for this app. The plan's `profile` list shows every field it filled; mention them when you read the dry run back. Its `notes` are the owner's own conventions, such as how apps are exposed or named: follow them, and ask when one does not fit.

When the profile is empty, show the user the `suggested` profile and offer to save it with `unraid_profile_update`, then add their own conventions as notes. Pass up the `notices`, such as containers on an old timezone, when they are relevant. Never save passwords or API keys in the profile; the App Keys tab is where keys go.

## Installing apps that need more access

When `unraid_ca_install` refuses an app because its template needs privileged mode, Extra Parameters, Post Arguments, host devices or a custom network such as br0, that is the template asking for more access, not a broken app. Tell the user what the app would get, then offer `full: true`, which installs it the way the Docker tab would and needs the Edit & Rebuild permission. Dry-run it first and read the settings in the plan back to the user. To put the app on a custom network with a fixed IP, pass `settings: {"Network": "br0", "MyIP": "..."}`. Tailscale templates and templates with extra networks are still refused; point the user to the Docker tab for those.

## Changing things inside an app

Many requests are about an app's own data, not its container: add an album in Immich, a proxy host in Nginx Proxy Manager, a series in Sonarr. Use `unraid_app_request` for those, with the installed container name and a path from the app's API documentation. Never pass a host or ask for a URL: the server finds the container itself.

Keys are the user's to manage. If the app needs one, it is added automatically when the user has saved it under Settings, UnraidClaw, App Keys, and `unraid_app_list` shows which apps have one. Never ask the user to paste a key, token or password into the chat. If the app answers 401 or 403, tell the user to add or check the key on that tab.

Look before you change: GET first to see the current state. For anything that creates, changes or deletes, call with `dryRun: true`, show the user the request, and ask before sending it. The app's status code is in the result, so a 404 or 422 from the app is information to act on, not a tool failure.

## Compose stacks

Containers made by Docker Compose are not on the Docker tab's templates, so `unraid_template_edit` cannot change them. Use `unraid_compose_list` to see the stacks and what each allows.

A `git` stack is a checkout of a repository and is deployed from there, often by a webhook. Do not try to edit or redeploy it here; the tools refuse. Explain that the change belongs in the repository, and offer to make it there if you can. Starting, stopping and restarting it is fine.

For a `local` stack, read it with `unraid_compose_get`, change what is needed in the text you were given, and send the whole file back with `unraid_compose_edit`. Leave `***` where a secret was: it keeps the real value. Dry-run first and show the user the diff and the planned actions. If the redeploy fails, the old file is already back; read the logs in the error and propose a fix.

## Long operations

Pulling an image, installing or updating an app, rebuilding a container and redeploying a stack can take minutes. Run them with `unraid_job_start` rather than waiting, especially when the user is on a phone: give it the tool's name and the same arguments you would pass directly, then tell the user the job is running and that they will get a notification when it is done. Do the dry run directly first, since a dry run is quick and the user should see it before anything changes. Check on a job with `unraid_job_get` when the user asks, and read its result or error back the way you would for a direct call.

## Plugins

Unraid plugins are .plg files that install files and run scripts on the server itself. They are not Docker containers. Some are listed in Community Applications, but these tools manage them directly without CA. Someone asking to install an app almost always means a container, so reach for `unraid_ca_install`. Use `unraid_plugin_install` only when they give you a .plg URL or name a plugin such as Unassigned Devices.

A .plg file is an installer Unraid runs as root, so installing one from a URL runs whatever code that URL serves. Install only from a URL the user gave you or a source they trust, and show them the dry run first. Every mutating plugin tool takes `dryRun`, which returns the plan and touches nothing.

Updating is two steps. `unraid_plugin_check_updates` downloads the plugin's published version and stages it; `unraid_plugin_update` installs what was staged. The check is not a read-only lookup: it arms an update the Unraid WebGUI will also offer. Update verifies afterwards that the installed version changed, so a result without `verified: true` is not a completed update.

Removal runs the plugin's own removal script. Some plugins keep their configuration and data, others delete it. Tell the user that before removing anything rather than promising their data survives.

OS plugins are protected from mutation. UnraidClaw can list, inspect and check itself, but cannot install over, update or remove itself through this API because its scripts stop the server handling the request. Use the Unraid WebGUI or Unraid's `plugin` command for self-management. The `unraidclaw` CLI uses the same API and cannot bypass this restriction.

## Requirements

- **Unraid 7.0.0+** with the [UnraidClaw plugin](https://github.com/emaspa/unraidclaw) installed
- An API key generated from the UnraidClaw settings page

## Configuration

| Field | Description |
|-------|-------------|
| `serverUrl` | URL of your UnraidClaw server (e.g. `https://<home-server>:9876`) |
| `apiKey` | API key from the UnraidClaw settings page |
| `tlsSkipVerify` | Set to `true` to accept the gateway's self-signed certificate. This disables certificate verification for that server |

## Install

UnraidClaw is an OpenClaw **plugin** (not a skill). Install it from ClawHub:

```bash
openclaw plugins install clawhub:unraidclaw --accept-capabilities
```

It is also on npm, which needs `--force` because the source is outside ClawHub:

```bash
openclaw plugins install unraidclaw --force --accept-capabilities
```

Then configure in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["unraidclaw"],
    "entries": {
      "unraidclaw": {
        "config": {
          "serverUrl": "https://YOUR_UNRAID_IP:9876",
          "apiKey": "YOUR_API_KEY",
          "tlsSkipVerify": true
        }
      }
    }
  }
}
```

## Examples

- "List all running Docker containers"
- "Stop the plex container"
- "What's the array status?"
- "Show me disk temperatures"
- "Create a new nginx container with port 8080"
- "Find me a Community Applications backup tool"
- "Install Jellyfin from Community Applications, media on /mnt/user/media"
- "Update the jellyfin container to the latest image"
- "Which of my Unraid plugins have updates?"
- "Check parity status"
- "Show recent notifications"
- "Reboot the server"

## Links

- [GitHub](https://github.com/emaspa/unraidclaw)
- [npm](https://www.npmjs.com/package/unraidclaw)
- [Unraid Community Apps](https://unraid.net/community/apps)
