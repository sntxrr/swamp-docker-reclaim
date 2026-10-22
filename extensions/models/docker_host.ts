/**
 * Docker host reclaim — measure what a Docker host's disk is actually spent
 * on, plan what can be freed without destroying a rollback, and free it.
 *
 * The problem this exists for is that the number people reach for is the
 * wrong one. `docker image prune` — dangling or `-a` — never touches the
 * BUILD CACHE, and on a host that builds its own images the build cache is
 * usually most of the footprint. On the host this model was written against
 * it was 59.5 GB of a 77 GB reclaim: `docker image prune -f` would have
 * recovered none of it, and even `-a` only reached the other 19.8 GB.
 *
 * Three behaviours are deliberate, because each corresponds to a way the
 * obvious command does damage or lies:
 *
 * 1. **`docker image prune -a` deletes rollback targets.** It removes every
 *    image no container references, which is exactly the set of previous
 *    versions you would roll back to. This model protects the newest
 *    `keepVersions` tags of each repository and removes specific image IDs,
 *    rather than handing the decision to `-a`.
 *
 * 2. **`docker builder prune -af` deletes the cache that makes the next
 *    build fast.** Cache that is minutes old is the most valuable cache
 *    there is. Pruning is therefore age-filtered (`--filter until=`), so a
 *    scheduled run reclaims cold layers and leaves the working set alone.
 *
 * 3. **Sizes reported by Docker are human strings, and they round.** "59.53GB"
 *    is not a byte count and 1000 vs 1024 is a real 7% at terabyte scale.
 *    Parsing is explicit and unit-aware rather than a `parseFloat`, and the
 *    freed figure `reclaim` reports is measured by observing before and
 *    after, not by adding up estimates.
 *
 * Everything reaches the host over SSH with host key checking left ON.
 * `StrictHostKeyChecking=no` is available but is not the default, because a
 * model whose whole purpose is to run destructive commands as a privileged
 * user is the last place to accept an unverified host key.
 *
 * The one exception is `sshHost: local`, for a Docker engine on the machine
 * swamp itself runs on (Docker Desktop on a workstation, for one). There is no
 * SSH server to reach and none should be required, so each command runs
 * through `sh -c` as the invoking user. The commands, and therefore every
 * protection above, are byte-for-byte the same in both modes; only the
 * transport differs.
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Pure helpers. Exported for tests — none of them touch the network or a host.
// ---------------------------------------------------------------------------

/** Multipliers for the unit suffixes Docker emits. */
const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
};

/**
 * Parse a Docker size string ("59.53GB", "1.2MiB", "0B", "0") into bytes.
 *
 * Docker mixes SI and binary suffixes across commands and versions, and
 * `system df` writes a reclaimable column as "56.76GB (95%)". Returns 0 for
 * anything unparseable rather than NaN, so one odd row cannot poison a total.
 */
export function parseSize(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return 0;
  const m = raw.trim().match(/^([\d.]+)\s*([a-zA-Z]*)/);
  if (!m) return 0;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (m[2] || "b").toLowerCase();
  const mult = UNITS[unit];
  if (mult === undefined) return 0;
  return Math.round(value * mult);
}

/** One row of `docker system df`. */
export interface UsageRow {
  type: string;
  total: number;
  active: number;
  sizeBytes: number;
  reclaimableBytes: number;
}

/**
 * Parse `docker system df --format '{{json .}}'` output.
 *
 * One JSON object per line, one line per type (Images, Containers, Local
 * Volumes, Build Cache). Malformed lines are skipped rather than throwing:
 * a Docker version that adds a row must not break the read path.
 */
export function parseSystemDf(stdout: string): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof raw.Type !== "string") continue;
    rows.push({
      type: raw.Type,
      total: Number.parseInt(String(raw.TotalCount ?? "0"), 10) || 0,
      active: Number.parseInt(String(raw.Active ?? "0"), 10) || 0,
      sizeBytes: parseSize(raw.Size),
      reclaimableBytes: parseSize(raw.Reclaimable),
    });
  }
  return rows;
}

/** Free space on the filesystem holding Docker's data root. */
export interface DiskUsage {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
}

/**
 * Parse `df -Pk <path>`.
 *
 * `-P` forces one record per filesystem — without it a long device name wraps
 * onto its own line and the columns shift. `-k` fixes the unit at 1K blocks,
 * so there is no suffix to guess at.
 *
 * `usedPercent` is `used / (used + available)`, matching what df's Capacity
 * column measures — NOT `used / total`. The two differ because a filesystem
 * reserves blocks only root may use, so `used + available` is less than
 * `total`: on the host this was written against, 44.0% against 42.1%.
 *
 * It is deliberately NOT rounded the way df prints it. df ceilings that column
 * — 44.03% displays as "45%" — which is fine for a human glance and wrong for
 * a threshold, since a guard on `> 80` would fire at a true 79.01%. Expect
 * this value to read up to one point below what `df` shows, and treat this one
 * as the real number.
 */
export function parseDf(stdout: string, path: string): DiskUsage | null {
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  if (lines.length < 2) return null;
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  if (cols.length < 5) return null;
  const k = 1024;
  const totalBytes = (Number.parseInt(cols[1], 10) || 0) * k;
  const usedBytes = (Number.parseInt(cols[2], 10) || 0) * k;
  const freeBytes = (Number.parseInt(cols[3], 10) || 0) * k;
  return {
    path,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: usedBytes + freeBytes > 0
      ? Math.round((usedBytes / (usedBytes + freeBytes)) * 1000) / 10
      : 0,
  };
}

/** One image as `docker images` reports it. */
export interface ImageRow {
  id: string;
  repository: string;
  tag: string;
  createdAt: string;
  sizeBytes: number;
}

/**
 * Parse the tab-separated image listing this model asks for.
 *
 * A `<none>` repository is a dangling image — it has no tag left, so nothing
 * can refer to it by name and it is always a removal candidate.
 */
export function parseImages(stdout: string): ImageRow[] {
  const rows: ImageRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [id, repository, tag, createdAt, size] = line.split("\t");
    if (!id) continue;
    rows.push({
      id: id.trim(),
      repository: (repository ?? "<none>").trim(),
      tag: (tag ?? "<none>").trim(),
      createdAt: (createdAt ?? "").trim(),
      sizeBytes: parseSize(size),
    });
  }
  return rows;
}

/** An image the plan proposes to remove, and why it is safe to. */
export interface Candidate {
  id: string;
  ref: string;
  sizeBytes: number;
  reason: "dangling" | "unused";
}

/** An image the plan refuses to remove, and what protected it. */
export interface Protected {
  id: string;
  ref: string;
  reason: "in-use" | "kept-version";
}

export interface ImagePlan {
  remove: Candidate[];
  protect: Protected[];
  removeBytes: number;
}

/** `repo:tag`, or the id for an image with no usable name. */
function refOf(image: ImageRow): string {
  if (image.repository === "<none>" || !image.repository) return image.id;
  if (image.tag === "<none>" || !image.tag) return image.repository;
  return `${image.repository}:${image.tag}`;
}

/**
 * Decide which images may be removed.
 *
 * Two protections, in order:
 *
 * - **In use.** Any image ID a container references — running OR stopped.
 *   Docker enforces this itself, but computing it here is what lets `plan`
 *   tell the truth about what `reclaim` will do before anything is deleted.
 * - **Kept versions.** The newest `keepVersions` tagged images of each
 *   repository, newest first by the caller-supplied order. These are the
 *   rollback targets; `docker image prune -a` removes them and this does not.
 *
 * `images` must be newest-first — `docker images` already sorts that way, and
 * sorting on the human `createdAt` string here would be wrong.
 */
export function planImages(
  images: ImageRow[],
  inUseIds: Set<string>,
  keepVersions: number,
): ImagePlan {
  const remove: Candidate[] = [];
  const protect: Protected[] = [];
  const keptPerRepo = new Map<string, number>();

  for (const image of images) {
    const ref = refOf(image);

    if (inUseIds.has(image.id)) {
      protect.push({ id: image.id, ref, reason: "in-use" });
      continue;
    }

    const dangling = image.repository === "<none>" || image.tag === "<none>";
    if (dangling) {
      remove.push({
        id: image.id,
        ref,
        sizeBytes: image.sizeBytes,
        reason: "dangling",
      });
      continue;
    }

    const kept = keptPerRepo.get(image.repository) ?? 0;
    if (kept < keepVersions) {
      keptPerRepo.set(image.repository, kept + 1);
      protect.push({ id: image.id, ref, reason: "kept-version" });
      continue;
    }

    remove.push({
      id: image.id,
      ref,
      sizeBytes: image.sizeBytes,
      reason: "unused",
    });
  }

  return {
    remove,
    protect,
    removeBytes: remove.reduce((sum, c) => sum + c.sizeBytes, 0),
  };
}

/** Sum the reclaimable bytes of one `docker system df` row type. */
export function reclaimableOf(rows: UsageRow[], type: string): number {
  return rows
    .filter((r) => r.type.toLowerCase() === type.toLowerCase())
    .reduce((sum, r) => sum + r.reclaimableBytes, 0);
}

/** Render bytes for a log line. Not used for arithmetic. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/**
 * Build the argument list for an SSH invocation.
 *
 * Host key checking stays on by default. `accept-new` trusts a host the first
 * time and pins it thereafter, which is the useful middle ground for a fleet
 * that gains hosts; `yes` requires the key to be known already. `no` accepts
 * any key on every connection and is offered only because some environments
 * have no persistent known_hosts — it is never the default, because this model
 * runs destructive commands as a privileged user.
 */
export function sshArgs(
  host: string,
  user: string,
  command: string,
  opts: {
    strictHostKeyChecking?: string;
    knownHostsFile?: string;
    connectTimeout?: number;
  } = {},
): string[] {
  const strict = opts.strictHostKeyChecking ?? "accept-new";
  const args = [
    "-o",
    `StrictHostKeyChecking=${strict}`,
    "-o",
    `ConnectTimeout=${opts.connectTimeout ?? 10}`,
    "-o",
    "BatchMode=yes",
  ];
  if (opts.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${opts.knownHostsFile}`);
  }
  args.push(`${user}@${host}`, command);
  return args;
}

/**
 * The `sshHost` value that means "this machine": commands run locally through
 * `sh -c` instead of over SSH. A reserved word rather than `localhost` on
 * purpose — `localhost` is a real SSH destination some setups rely on, and
 * changing what it means would silently change their transport.
 */
export const LOCAL_HOST = "local";

/**
 * The program and arguments that run `command` against the configured host.
 *
 * Local mode hands the command to `sh -c` verbatim, so the quoting the SSH
 * path relies on (the remote shell parses the command string) is preserved:
 * the same string means the same thing in both modes.
 */
export function execArgv(
  g: {
    sshHost: string;
    sshUser: string;
    strictHostKeyChecking?: string;
    knownHostsFile?: string;
  },
  command: string,
): { cmd: string; args: string[] } {
  if (g.sshHost === LOCAL_HOST) {
    return { cmd: "sh", args: ["-c", command] };
  }
  return {
    cmd: "ssh",
    args: sshArgs(g.sshHost, g.sshUser, command, {
      strictHostKeyChecking: g.strictHostKeyChecking,
      knownHostsFile: g.knownHostsFile,
    }),
  };
}

/** Where commands ran, for error messages: `user@host` or `local`. */
export function targetLabel(g: { sshHost: string; sshUser: string }): string {
  return g.sshHost === LOCAL_HOST ? LOCAL_HOST : `${g.sshUser}@${g.sshHost}`;
}

// ---------------------------------------------------------------------------
// Host access
// ---------------------------------------------------------------------------

interface GlobalArgs {
  sshHost: string;
  sshUser: string;
  keepVersions: number;
  buildCacheKeepHours: number;
  dataRoot: string;
  strictHostKeyChecking: string;
  knownHostsFile?: string;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(g: GlobalArgs, command: string): Promise<ExecResult> {
  const { cmd, args } = execArgv(g, command);
  // A subprocess is the transport itself: `ssh` to a remote engine, or `sh -c`
  // for `sshHost: local`. Both are documented in the README; the program is
  // fixed by execArgv, never taken from input.
  // swamp-quality-ignore deno-command
  const proc = new Deno.Command(cmd, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const out = await proc.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Run a command and fail loudly. Used where a wrong answer is worse than an error. */
async function runOrThrow(g: GlobalArgs, command: string): Promise<string> {
  const result = await run(g, command);
  if (result.code !== 0) {
    const via = g.sshHost === LOCAL_HOST ? "sh -c" : "ssh";
    const where = `${via} ${targetLabel(g)}`;
    const tail = result.stderr.trim().slice(-400);
    throw new Error(
      `${where} failed (exit ${result.code}) running \`${command}\`: ${tail}`,
    );
  }
  return result.stdout;
}

/** Read current usage: what Docker holds, and how much room is left for it. */
async function readUsage(g: GlobalArgs) {
  const dfJson = await runOrThrow(g, "docker system df --format '{{json .}}'");
  const rows = parseSystemDf(dfJson);
  const diskOut = await runOrThrow(g, `df -Pk ${g.dataRoot}`);
  const disk = parseDf(diskOut, g.dataRoot);

  const byType = (type: string) =>
    rows.find((r) => r.type.toLowerCase() === type.toLowerCase()) ?? {
      type,
      total: 0,
      active: 0,
      sizeBytes: 0,
      reclaimableBytes: 0,
    };

  return {
    images: byType("Images"),
    containers: byType("Containers"),
    volumes: byType("Local Volumes"),
    buildCache: byType("Build Cache"),
    disk,
    totalReclaimableBytes: rows.reduce((s, r) => s + r.reclaimableBytes, 0),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Every image ID referenced by a container, running or stopped.
 *
 * Resolved via `docker inspect` on container IDs rather than by reading the
 * `Image` column of `docker ps`, which prints whatever name the container was
 * created with — a tag that may since have moved to a different image.
 */
async function inUseImageIds(g: GlobalArgs): Promise<Set<string>> {
  const ids = (await runOrThrow(g, "docker ps -aq")).trim();
  if (!ids) return new Set();
  const inspected = await runOrThrow(
    g,
    `docker inspect --format '{{.Image}}' ${ids.split("\n").join(" ")}`,
  );
  const short = new Set<string>();
  for (const line of inspected.split("\n")) {
    const full = line.trim().replace(/^sha256:/, "");
    if (!full) continue;
    short.add(full);
    short.add(full.slice(0, 12)); // `docker images` prints the short form
  }
  return short;
}

async function readImagePlan(g: GlobalArgs): Promise<ImagePlan> {
  const listing = await runOrThrow(
    g,
    "docker images --format '{{.ID}}\\t{{.Repository}}\\t{{.Tag}}\\t{{.CreatedAt}}\\t{{.Size}}'",
  );
  return planImages(
    parseImages(listing),
    await inUseImageIds(g),
    g.keepVersions,
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  sshHost: z.string().describe(
    "Hostname or IP of the Docker host, or the reserved word `local` to run against the Docker engine on the machine swamp runs on (via `sh -c`, no SSH). No default: this model runs destructive commands, and a default host is a way to run them somewhere unintended.",
  ),
  sshUser: z.string().default("root").describe(
    "SSH user. Ignored when sshHost is `local`, where commands run as the invoking user.",
  ),
  keepVersions: z.number().int().min(0).default(2).describe(
    "Newest tagged images to keep per repository. These are the rollback targets — `docker image prune -a` removes them and this does not. 0 keeps none.",
  ),
  buildCacheKeepHours: z.number().int().min(0).default(168).describe(
    "Keep build cache newer than this many hours. Recent cache is what makes the next build fast; 168 (7 days) reclaims cold layers only. 0 prunes all of it.",
  ),
  dataRoot: z.string().default("/var/lib/docker").describe(
    "Path used to measure free space. Should be on the filesystem holding Docker's data root.",
  ),
  strictHostKeyChecking: z.enum(["yes", "accept-new", "no"]).default(
    "accept-new",
  )
    .describe(
      "SSH host key policy. 'accept-new' pins a host on first contact; 'yes' requires it to be known already. 'no' accepts any key every time and is never appropriate for a privileged, destructive session — it exists only for environments with no persistent known_hosts.",
    ),
  knownHostsFile: z.string().optional().describe(
    "Explicit known_hosts path, for runtimes where the default HOME is not the operator's.",
  ),
});

const UsageRowSchema = z.object({
  type: z.string(),
  total: z.number(),
  active: z.number(),
  sizeBytes: z.number(),
  reclaimableBytes: z.number(),
});

const DiskSchema = z.object({
  path: z.string(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  freeBytes: z.number(),
  usedPercent: z.number(),
}).nullable();

const UsageSchema = z.object({
  images: UsageRowSchema,
  containers: UsageRowSchema,
  volumes: UsageRowSchema,
  buildCache: UsageRowSchema,
  disk: DiskSchema,
  totalReclaimableBytes: z.number(),
  timestamp: z.string(),
});

const PlanSchema = z.object({
  images: z.array(z.object({
    id: z.string(),
    ref: z.string(),
    sizeBytes: z.number(),
    reason: z.enum(["dangling", "unused"]),
  })),
  protectedImages: z.array(z.object({
    id: z.string(),
    ref: z.string(),
    reason: z.enum(["in-use", "kept-version"]),
  })),
  imageBytes: z.number(),
  buildCacheReclaimableBytes: z.number(),
  buildCacheKeepHours: z.number(),
  estimatedBytes: z.number(),
  timestamp: z.string(),
});

const ReclaimSchema = z.object({
  applied: z.boolean(),
  imagesRemoved: z.number(),
  imagesFailed: z.number(),
  freedBytes: z.number(),
  freeBytesBefore: z.number(),
  freeBytesAfter: z.number(),
  timestamp: z.string(),
});

interface Context {
  globalArgs: GlobalArgs;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  writeResource: (
    resource: string,
    instance: string,
    attributes: unknown,
  ) => Promise<unknown>;
}

/**
 * The `@sntxrr/docker-reclaim/host` model: one Docker host's disk footprint,
 * what of it can be freed, and freeing it.
 */
export const model = {
  type: "@sntxrr/docker-reclaim/host",
  description:
    "Measure what a Docker host's disk is spent on, plan what can be freed without destroying a rollback target, and free it. Covers the build cache, which `docker image prune` never touches and which is usually most of the footprint.",
  version: "2026.10.22.1",
  upgrades: [
    {
      toVersion: "2026.09.06.2",
      description:
        "Each resource now writes to its own data instance -- `usage`, `plan`, `reclaim` -- instead of all three sharing one called `current`. Sharing it meant data.latest(model, 'current') returned whichever METHOD ran last, with a different schema each time: a workflow guard reading .disk.usedPercent would find no such field after a reclaim, the expression would die during evaluation, and a step with allowFailure would then report SUCCEEDED having done nothing." +
        " Nothing to migrate -- global arguments are unchanged -- but expressions must move from data.latest(name, 'current') to data.latest(name, 'usage').",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.22.1",
      description:
        "Adds `sshHost: local`: commands run on the machine swamp runs on through `sh -c` instead of over SSH, for a Docker engine with no SSH server in front of it. Additive -- every existing value of sshHost keeps its meaning, the reclaim rules are unchanged, and there is nothing to migrate.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    usage: {
      description:
        "What Docker currently holds, by class, with the reclaimable portion of each and the free space on the filesystem behind it.",
      schema: UsageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    plan: {
      description:
        "What `reclaim` would remove and what it would refuse to, with the reason for each.",
      schema: PlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    reclaim: {
      description:
        "The outcome of a reclaim, with space freed measured by observing before and after rather than by summing estimates.",
      schema: ReclaimSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  methods: {
    observe: {
      description:
        "Read-only. Report what Docker holds and how much of it is reclaimable, plus free space on the data root. Safe to schedule as often as you like; this is the number to assert a threshold against.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Context) => {
        const usage = await readUsage(context.globalArgs);
        context.logger.info(
          "{host}: {reclaimable} reclaimable, {free} free",
          {
            host: context.globalArgs.sshHost,
            reclaimable: humanBytes(usage.totalReclaimableBytes),
            free: humanBytes(usage.disk?.freeBytes ?? 0),
          },
        );
        await context.writeResource("usage", "usage", usage);
        return usage;
      },
    },

    plan: {
      description:
        "Read-only. Report exactly which images would be removed and which are protected, and how much build cache is old enough to prune. Removes nothing.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Context) => {
        const g = context.globalArgs;
        const [imagePlan, usage] = [await readImagePlan(g), await readUsage(g)];
        const buildCacheReclaimableBytes = usage.buildCache.reclaimableBytes;

        const plan = {
          images: imagePlan.remove,
          protectedImages: imagePlan.protect,
          imageBytes: imagePlan.removeBytes,
          buildCacheReclaimableBytes,
          buildCacheKeepHours: g.buildCacheKeepHours,
          // An estimate, and named as one. The build cache figure is what
          // Docker considers reclaimable with no age filter, so the age
          // filter can only make the real number smaller.
          estimatedBytes: imagePlan.removeBytes + buildCacheReclaimableBytes,
          timestamp: new Date().toISOString(),
        };

        context.logger.info(
          "{host}: {count} images ({imageBytes}) removable, {protected} protected, {cache} build cache reclaimable",
          {
            host: g.sshHost,
            count: imagePlan.remove.length,
            imageBytes: humanBytes(imagePlan.removeBytes),
            protected: imagePlan.protect.length,
            cache: humanBytes(buildCacheReclaimableBytes),
          },
        );
        await context.writeResource("plan", "plan", plan);
        return plan;
      },
    },

    reclaim: {
      description:
        "Free space. Dry-run by default: without `apply: true` it reports the plan and removes nothing. With it, removes the planned image IDs and prunes build cache older than `buildCacheKeepHours`. Never removes an image a container references, and never the newest `keepVersions` tags of a repository.",
      arguments: z.object({
        apply: z.boolean().default(false).describe(
          "Actually remove things. Defaults to false so an accidental run is a report.",
        ),
      }),
      execute: async (args: { apply: boolean }, context: Context) => {
        const g = context.globalArgs;
        const before = await readUsage(g);
        const imagePlan = await readImagePlan(g);

        if (!args.apply) {
          context.logger.info(
            "Dry run. Would remove {count} images ({bytes}) and build cache older than {hours}h. Pass apply=true to act.",
            {
              count: imagePlan.remove.length,
              bytes: humanBytes(imagePlan.removeBytes),
              hours: g.buildCacheKeepHours,
            },
          );
          const result = {
            applied: false,
            imagesRemoved: 0,
            imagesFailed: 0,
            freedBytes: 0,
            freeBytesBefore: before.disk?.freeBytes ?? 0,
            freeBytesAfter: before.disk?.freeBytes ?? 0,
            timestamp: new Date().toISOString(),
          };
          await context.writeResource("reclaim", "reclaim", result);
          return result;
        }

        let removed = 0;
        let failed = 0;
        if (imagePlan.remove.length > 0) {
          // Removed one at a time on purpose. A single `docker rmi a b c`
          // stops at the first failure and leaves the rest untouched, and an
          // image can legitimately refuse — another image may depend on its
          // layers. One refusal should not abandon the run.
          for (const candidate of imagePlan.remove) {
            const result = await run(g, `docker rmi ${candidate.id}`);
            if (result.code === 0) removed++;
            else failed++;
          }
        }

        const untilFilter = g.buildCacheKeepHours > 0
          ? ` --filter until=${g.buildCacheKeepHours}h`
          : "";
        await runOrThrow(g, `docker builder prune -f${untilFilter}`);

        const after = await readUsage(g);
        const freeBefore = before.disk?.freeBytes ?? 0;
        const freeAfter = after.disk?.freeBytes ?? 0;

        const result = {
          applied: true,
          imagesRemoved: removed,
          imagesFailed: failed,
          freedBytes: Math.max(0, freeAfter - freeBefore),
          freeBytesBefore: freeBefore,
          freeBytesAfter: freeAfter,
          timestamp: new Date().toISOString(),
        };

        context.logger.info(
          "{host}: removed {removed} images ({failed} refused), freed {freed}. Free space {before} -> {after}.",
          {
            host: g.sshHost,
            removed,
            failed,
            freed: humanBytes(result.freedBytes),
            before: humanBytes(freeBefore),
            after: humanBytes(freeAfter),
          },
        );
        await context.writeResource("reclaim", "reclaim", result);
        return result;
      },
    },
  },
};
