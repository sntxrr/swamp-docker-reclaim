import { assertEquals } from "jsr:@std/assert@1";
import {
  humanBytes,
  type ImageRow,
  parseDf,
  parseImages,
  parseSize,
  parseSystemDf,
  planImages,
  reclaimableOf,
  sshArgs,
} from "./docker_host.ts";

// --- parseSize -------------------------------------------------------------
// Docker mixes SI and binary suffixes. Getting this wrong is a silent 7% at
// GB scale and grows from there, so every suffix it emits is pinned.

Deno.test("parseSize handles the SI suffixes docker prints", () => {
  assertEquals(parseSize("0B"), 0);
  assertEquals(parseSize("512B"), 512);
  assertEquals(parseSize("1kB"), 1_000);
  assertEquals(parseSize("36.56GB"), 36_560_000_000);
  assertEquals(parseSize("59.53GB"), 59_530_000_000);
});

Deno.test("parseSize distinguishes binary suffixes from SI", () => {
  assertEquals(parseSize("1KiB"), 1024);
  assertEquals(parseSize("1MiB"), 1_048_576);
  assertEquals(parseSize("1GiB"), 1_073_741_824);
});

Deno.test("parseSize tolerates whitespace and a bare number", () => {
  assertEquals(parseSize("1.5 GB"), 1_500_000_000);
  assertEquals(parseSize("904"), 904);
});

Deno.test("parseSize reads the leading value of a reclaimable column", () => {
  // `docker system df` writes reclaimable as "56.76GB (95%)".
  assertEquals(parseSize("56.76GB (95%)"), 56_760_000_000);
});

Deno.test("parseSize returns 0 rather than NaN for junk", () => {
  // One unparseable row must not poison a total by making it NaN.
  assertEquals(parseSize(""), 0);
  assertEquals(parseSize("N/A"), 0);
  assertEquals(parseSize(undefined), 0);
  assertEquals(parseSize(null), 0);
  assertEquals(parseSize("12ZB"), 0);
});

Deno.test("parseSize passes a real number straight through", () => {
  assertEquals(parseSize(4096), 4096);
});

// --- parseSystemDf ---------------------------------------------------------

const DF_JSON = `
{"Type":"Images","TotalCount":"68","Active":"34","Size":"36.56GB","Reclaimable":"19.09GB (52%)"}
{"Type":"Containers","TotalCount":"35","Active":"35","Size":"904.6MB","Reclaimable":"0B (0%)"}
{"Type":"Local Volumes","TotalCount":"40","Active":"18","Size":"3.085GB","Reclaimable":"59.21MB (1%)"}
{"Type":"Build Cache","TotalCount":"1036","Active":"0","Size":"59.53GB","Reclaimable":"56.76GB"}
`;

Deno.test("parseSystemDf reads every row", () => {
  const rows = parseSystemDf(DF_JSON);
  assertEquals(rows.length, 4);
  assertEquals(rows[0].type, "Images");
  assertEquals(rows[0].total, 68);
  assertEquals(rows[0].active, 34);
  assertEquals(rows[3].type, "Build Cache");
  assertEquals(rows[3].reclaimableBytes, 56_760_000_000);
});

Deno.test("parseSystemDf skips malformed lines instead of throwing", () => {
  // A docker version that adds a row or prints a warning must not break the
  // read path — observe is the method you run when something is already wrong.
  const rows = parseSystemDf(
    `WARNING: something\n{"Type":"Images","Size":"1GB","Reclaimable":"0B"}\nnot json\n{`,
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].type, "Images");
});

Deno.test("reclaimableOf matches type case-insensitively", () => {
  const rows = parseSystemDf(DF_JSON);
  assertEquals(reclaimableOf(rows, "build cache"), 56_760_000_000);
  assertEquals(reclaimableOf(rows, "Containers"), 0);
  assertEquals(reclaimableOf(rows, "Nothing"), 0);
});

// --- parseDf ---------------------------------------------------------------

Deno.test("parseDf reads 1K blocks into bytes", () => {
  const out = [
    "Filesystem     1024-blocks      Used Available Capacity Mounted on",
    "/dev/sda3        206435328 167772160  30408704      85% /",
  ].join("\n");
  const disk = parseDf(out, "/var/lib/docker");
  assertEquals(disk?.totalBytes, 206_435_328 * 1024);
  assertEquals(disk?.freeBytes, 30_408_704 * 1024);
  // used/(used+avail), as df's Capacity measures it — not used/total, which
  // would be 81.3% here, because a filesystem reserves blocks only root may
  // use. A threshold set from one and read from the other fires at the wrong
  // time.
  assertEquals(disk?.usedPercent, 84.7);
  assertEquals(disk?.path, "/var/lib/docker");
});

Deno.test("parseDf does not ceiling the way df prints", () => {
  // Real numbers from the host this was written against: df's Capacity column
  // shows "45%" for a true 44.03%. A guard on `> 80` must not fire at 79.01%,
  // so the precise value is what gets stored.
  const out = [
    "Filesystem 1024-blocks Used Available Capacity Mounted on",
    "/dev/sda3 206435328 86915768 110476716 45% /",
  ].join("\n");
  assertEquals(parseDf(out, "/")?.usedPercent, 44);
});

Deno.test("parseDf reports 0% for a filesystem with no blocks", () => {
  const out = "Filesystem 1024-blocks Used Available Capacity Mounted on\ntmpfs 0 0 0 0% /empty";
  assertEquals(parseDf(out, "/empty")?.usedPercent, 0);
});

Deno.test("parseDf returns null on output with no record", () => {
  assertEquals(parseDf("", "/"), null);
  assertEquals(parseDf("Filesystem 1024-blocks Used Available Capacity", "/"), null);
});

// --- parseImages -----------------------------------------------------------

Deno.test("parseImages reads the tab-separated listing", () => {
  const out = [
    "abc123def456\tghcr.io/gethomepage/homepage\tv0.9.10\t2026-08-01 10:00:00 +0000 UTC\t512MB",
    "def456abc123\t<none>\t<none>\t2026-07-01 10:00:00 +0000 UTC\t1.2GB",
  ].join("\n");
  const rows = parseImages(out);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].repository, "ghcr.io/gethomepage/homepage");
  assertEquals(rows[0].tag, "v0.9.10");
  assertEquals(rows[0].sizeBytes, 512_000_000);
  assertEquals(rows[1].repository, "<none>");
});

Deno.test("parseImages ignores blank lines", () => {
  assertEquals(parseImages("\n\n  \n").length, 0);
});

// --- planImages ------------------------------------------------------------
// This is the function that decides what gets deleted. Every protection has a
// test, because the failure mode is silent and unrecoverable.

function img(
  id: string,
  repository: string,
  tag: string,
  sizeBytes = 100,
): ImageRow {
  return { id, repository, tag, createdAt: "", sizeBytes };
}

Deno.test("planImages never removes an image a container references", () => {
  const images = [img("aaa", "app", "v3"), img("bbb", "app", "v2")];
  const plan = planImages(images, new Set(["bbb"]), 0);
  assertEquals(plan.remove.map((c) => c.id), ["aaa"]);
  assertEquals(plan.protect, [{ id: "bbb", ref: "app:v2", reason: "in-use" }]);
});

Deno.test("planImages keeps the newest N tags per repository", () => {
  // The whole point: `docker image prune -a` deletes these, and they are
  // exactly what a rollback needs.
  const images = [
    img("v5", "app", "5"),
    img("v4", "app", "4"),
    img("v3", "app", "3"),
    img("v2", "app", "2"),
  ];
  const plan = planImages(images, new Set(), 2);
  assertEquals(plan.protect.map((p) => p.id), ["v5", "v4"]);
  assertEquals(plan.remove.map((c) => c.id), ["v3", "v2"]);
  assertEquals(plan.protect.every((p) => p.reason === "kept-version"), true);
});

Deno.test("planImages counts kept versions per repository, not globally", () => {
  const images = [
    img("a2", "alpha", "2"),
    img("a1", "alpha", "1"),
    img("b2", "beta", "2"),
    img("b1", "beta", "1"),
  ];
  const plan = planImages(images, new Set(), 1);
  assertEquals(plan.protect.map((p) => p.id).sort(), ["a2", "b2"]);
  assertEquals(plan.remove.map((c) => c.id).sort(), ["a1", "b1"]);
});

Deno.test("planImages always removes dangling images, keepVersions aside", () => {
  // A dangling image has no tag left, so nothing can name it and no rollback
  // can reach it. It never consumes a keep slot.
  const images = [
    img("d1", "<none>", "<none>"),
    img("t1", "app", "1"),
  ];
  const plan = planImages(images, new Set(), 5);
  assertEquals(plan.remove.map((c) => c.reason), ["dangling"]);
  assertEquals(plan.protect.map((p) => p.id), ["t1"]);
});

Deno.test("planImages protects an in-use image before counting keeps", () => {
  // An in-use image must not silently occupy a keep slot, or the effective
  // number of rollback targets is one fewer than configured.
  const images = [
    img("run", "app", "3"),
    img("old", "app", "2"),
    img("older", "app", "1"),
  ];
  const plan = planImages(images, new Set(["run"]), 1);
  assertEquals(plan.protect.map((p) => [p.id, p.reason]), [
    ["run", "in-use"],
    ["old", "kept-version"],
  ]);
  assertEquals(plan.remove.map((c) => c.id), ["older"]);
});

Deno.test("planImages with keepVersions 0 still protects in-use images", () => {
  const plan = planImages([img("x", "app", "1")], new Set(["x"]), 0);
  assertEquals(plan.remove.length, 0);
  assertEquals(plan.protect.length, 1);
});

Deno.test("planImages totals the bytes it proposes to free", () => {
  const images = [img("a", "app", "3", 1_000), img("b", "app", "2", 2_500)];
  const plan = planImages(images, new Set(), 0);
  assertEquals(plan.removeBytes, 3_500);
});

Deno.test("planImages names an untagged image by id", () => {
  const plan = planImages([img("abc123", "<none>", "<none>")], new Set(), 0);
  assertEquals(plan.remove[0].ref, "abc123");
});

// --- sshArgs ---------------------------------------------------------------
// The security posture of this model is one array of flags. It gets a test.

Deno.test("sshArgs keeps host key checking on by default", () => {
  const args = sshArgs("host.example.com", "deploy", "docker ps");
  assertEquals(args.includes("StrictHostKeyChecking=accept-new"), true);
  assertEquals(args.includes("StrictHostKeyChecking=no"), false);
  // Never discard the known_hosts file by default — that is what makes
  // `accept-new` meaningless.
  assertEquals(args.some((a) => a.includes("/dev/null")), false);
});

Deno.test("sshArgs puts the command last, after the destination", () => {
  const args = sshArgs("host.example.com", "deploy", "docker system df");
  assertEquals(args[args.length - 1], "docker system df");
  assertEquals(args[args.length - 2], "deploy@host.example.com");
});

Deno.test("sshArgs honours an explicit known_hosts file", () => {
  const args = sshArgs("host.example.com", "deploy", "true", {
    knownHostsFile: "/etc/swamp/known_hosts",
  });
  assertEquals(args.includes("UserKnownHostsFile=/etc/swamp/known_hosts"), true);
});

Deno.test("sshArgs allows an explicit opt-out but only when asked", () => {
  const args = sshArgs("host.example.com", "deploy", "true", {
    strictHostKeyChecking: "no",
  });
  assertEquals(args.includes("StrictHostKeyChecking=no"), true);
});

Deno.test("sshArgs runs non-interactively so a run cannot hang on a prompt", () => {
  assertEquals(sshArgs("h", "u", "true").includes("BatchMode=yes"), true);
});

// --- humanBytes ------------------------------------------------------------

Deno.test("humanBytes renders round units", () => {
  assertEquals(humanBytes(0), "0 B");
  assertEquals(humanBytes(-5), "0 B");
  assertEquals(humanBytes(512), "512 B");
  assertEquals(humanBytes(59_530_000_000), "59.53 GB");
});
