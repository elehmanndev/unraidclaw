import type { FastifyInstance, FastifyReply } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { SetupProfile, SetupProfileUpdateResponse, SetupProfileView } from "@unraidclaw/shared";
import { requirePermission } from "../permissions.js";
import { createCaRuntime, type CaRuntime } from "./ca.js";
import {
  PROFILE_FILE,
  ProfileError,
  detectConventions,
  mergeProfile,
  parseProfileUpdate,
  readProfile,
  writeProfile,
} from "../profile.js";

/** Everything the profile routes touch. Tests replace these. */
export interface ProfileRuntime {
  file: string;
  run: CaRuntime["run"];
  readHostVars: CaRuntime["readHostVars"];
  read(): Promise<SetupProfile>;
  write(profile: SetupProfile): Promise<void>;
  now(): Date;
}

export function createProfileRuntime(ca: CaRuntime = createCaRuntime(), overrides: Partial<ProfileRuntime> = {}): ProfileRuntime {
  const file = overrides.file ?? PROFILE_FILE;
  return {
    file,
    run: overrides.run ?? ca.run,
    readHostVars: overrides.readHostVars ?? ca.readHostVars,
    read: overrides.read ?? (() => readProfile(file)),
    write: overrides.write ?? ((profile) => writeProfile(profile, file)),
    now: overrides.now ?? (() => new Date()),
  };
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof ProfileError) {
    return reply.status(err.statusCode).send({ ok: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  throw err;
}

export function registerProfileRoutes(app: FastifyInstance, runtime: ProfileRuntime = createProfileRuntime()): void {
  // Changes are read, merged and written one at a time, so two at once cannot
  // lose each other's fields.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  app.get("/api/profile", {
    preHandler: requirePermission(Resource.PROFILE, Action.READ),
    handler: async (_req, reply) => {
      const profile = await runtime.read();
      const { timeZone } = await runtime.readHostVars();
      let inspects: unknown[] = [];
      const notices: string[] = [];
      try {
        const ids = (await runtime.run("docker", ["ps", "-aq", "--no-trunc"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        if (ids.length > 0) {
          const parsed = JSON.parse((await runtime.run("docker", ["inspect", ...ids])).stdout);
          if (Array.isArray(parsed)) inspects = parsed;
        }
      } catch (err) {
        notices.push(`The installed containers could not be read, so nothing was suggested: ${(err as Error).message}`);
      }
      const found = detectConventions(inspects, timeZone);
      const view: SetupProfileView = { profile, suggested: found.suggested, evidence: found.evidence, notices: [...notices, ...found.notices] };
      return reply.send({ ok: true, data: view });
    },
  });

  app.post("/api/profile", {
    preHandler: requirePermission(Resource.PROFILE, Action.UPDATE),
    handler: async (req, reply) => {
      try {
        const update = parseProfileUpdate(req.body);
        return await serialized(async () => {
          const current = await runtime.read();
          const { profile, changed } = mergeProfile(current, update);
          req.activityDetail = `${update.dryRun ? "dry run " : ""}${changed.length > 0 ? `changed ${changed.join(", ")}`.slice(0, 200) : "no change"}`;
          if (update.dryRun) {
            const response: SetupProfileUpdateResponse = { dryRun: true, profile, changed };
            return reply.send({ ok: true, data: response });
          }
          if (changed.length === 0) {
            const response: SetupProfileUpdateResponse = { dryRun: false, profile: current, changed, verified: true };
            return reply.send({ ok: true, data: response });
          }
          profile.updatedAt = runtime.now().toISOString();
          try {
            await runtime.write(profile);
          } catch (err) {
            throw new ProfileError(`The profile could not be saved to ${runtime.file}: ${(err as Error).message}. The previous profile is unchanged.`, "PROFILE_WRITE_FAILED", 500);
          }
          const saved = await runtime.read();
          const verified = JSON.stringify(saved) === JSON.stringify(profile);
          const response: SetupProfileUpdateResponse = { dryRun: false, profile: saved, changed, verified };
          if (!verified) {
            return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: `The profile was written to ${runtime.file} but reads back differently.` }, data: response });
          }
          return reply.send({ ok: true, data: response });
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  });
}
