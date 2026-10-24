# @sntxrr/docker-reclaim

Measure what a Docker host's disk is actually spent on, plan what can be freed
without destroying a rollback target, and free it.

## The problem it solves

The command people reach for is the wrong one.

`docker image prune` — dangling, or even `-a` — **never touches the build
cache**. On any host that builds its own images, the build cache is usually
most of the footprint. On the host this model was written against:

| | Size | Reclaimable | Reached by `docker image prune -a`? |
| --- | --- | --- | --- |
| Build cache | 59.5 GB | 56.8 GB (95%) | **no** |
| Images | 36.6 GB | 19.1 GB (52%) | yes |

That host was at 85% full. Pruning images — the obvious move, and the only
thing most Docker tooling automates — would have left 77% of the problem in
place. The number that would have told you this is `docker system df`, which
nothing was reading.

## What it does differently

Three behaviours are deliberate, because each one corresponds to a way the
obvious command does damage or lies.

**`docker image prune -a` deletes your rollback targets.** It removes every
image no container references — which is exactly the set of previous versions
you would roll back to. This model protects the newest `keepVersions` tags of
each repository and removes specific image IDs, so reclaiming space does not
quietly cost you the ability to go back.

**`docker builder prune -af` deletes the cache that makes the next build
fast.** Cache that is minutes old is the most valuable cache there is. Pruning
here is age-filtered (`--filter until=`), so a scheduled run takes cold layers
and leaves the working set alone.
The prune does run with `-a`: without it BuildKit leaves out records shared
with the image store, and on a Docker engine an age-filtered prune then frees
almost nothing. Old layers that a recent build still sits on are kept by
BuildKit either way, so Docker's "reclaimable" build-cache figure is an upper
bound, not what a reclaim will free.

**A bare `docker builder prune` goes to whichever builder is current.** That
can be a `docker-container` builder, or a `docker`-driver builder pointed at
*another host's* engine, and the prune would then delete cache somewhere this
model never measured. The prune therefore names the engine's own builder,
`--builder "$(docker context show)"` (buildx names each context's
docker-driver builder after the context), and the `engine-builder` pre-flight
check below refuses `reclaim` unless that builder exists and uses the `docker`
driver.

**Docker's sizes are rounded human strings.** `59.53GB` is not a byte count,
and SI vs. binary is a real 7% at terabyte scale. Parsing is explicit and
unit-aware, and the freed figure `reclaim` reports is *measured* — free space
observed before and after — not a sum of estimates.

## Methods

| Method    | Writes? | Effect |
| --------- | ------- | ------ |
| `observe` | no      | Reports what Docker holds by class, how much is reclaimable, and free space on the data root. |
| `plan`    | no      | Reports exactly which images would be removed, which are protected and why, and Docker's reclaimable build-cache figure (an upper bound on what the age-filtered prune frees). |
| `reclaim` | **yes** | Frees space. Dry-run unless passed `apply: true`. |

`observe` is the one to schedule. It is read-only, cheap, and produces the
number you assert a threshold against — so a workflow can prune only when the
host actually needs it, rather than on a timer that fires whether or not there
is anything to reclaim.

## Pre-flight check

| Check | Label | Runs before | Refuses when |
| ----- | ----- | ----------- | ------------ |
| `engine-builder` | `live` | `reclaim` (dry runs too) | `docker buildx inspect "$(docker context show)"` fails, or reports a driver other than `docker`. |

Skip it with `--skip-check engine-builder` (or `--skip-check-label live`) only
when you know where the prune lands. swamp does not run pre-flight checks for a
workflow step placed on a worker; the `--builder` pin in the command still
applies there, so the prune cannot drift to another builder, but a host
without buildx then fails at the prune instead of at the check.

## What is never removed

| Protection | Applies to |
| ---------- | ---------- |
| `in-use` | Any image ID referenced by a container, **running or stopped**. |
| `kept-version` | The newest `keepVersions` tagged images of each repository. |

Both are computed before anything is deleted, which is what lets `plan` tell
you the truth about what `reclaim` will do.

In-use images are resolved with `docker inspect` on container IDs rather than
by reading the `Image` column of `docker ps`. That column prints whatever name
the container was *created* with — a tag that may since have moved to a
different image, which would make the wrong image look safe.

A dangling image (`<none>:<none>`) is always a candidate and never consumes a
keep slot: it has no tag left, so nothing can name it and no rollback can reach
it.

## Usage

```bash
swamp model create @sntxrr/docker-reclaim/host docker-host \
  --global-arg sshHost=docker.example.com \
  --global-arg sshUser=deploy \
  --global-arg keepVersions=2 \
  --global-arg buildCacheKeepHours=168

# Read-only. Safe at any frequency.
swamp model @sntxrr/docker-reclaim/host method run observe docker-host

# Read-only. Shows exactly what would go, and what is protected.
swamp model @sntxrr/docker-reclaim/host method run plan docker-host

# Dry run — reports, removes nothing.
swamp model @sntxrr/docker-reclaim/host method run reclaim docker-host

# Actually free the space.
swamp model @sntxrr/docker-reclaim/host method run reclaim docker-host \
  --arg apply=true
```

### A Docker engine on this machine (`sshHost: local`)

For a Docker engine on the machine swamp runs on — Docker Desktop on a
workstation, say — there is no SSH server to reach. Set `sshHost` to the
reserved word `local` and each command runs through `sh -c` as the invoking
user instead. The commands are identical, so every protection below applies
unchanged; only the transport differs. `sshUser` and the host key settings are
ignored.

Point `dataRoot` at the filesystem that actually backs the engine's storage.
On Docker Desktop for macOS `/var/lib/docker` does not exist on the host; the
disk image lives on the data volume, so use `/System/Volumes/Data`:

```bash
swamp model create @sntxrr/docker-reclaim/host workstation-docker \
  --global-arg sshHost=local \
  --global-arg dataRoot=/System/Volumes/Data
```

Docker Desktop's disk image is a sparse file. Space freed inside it reaches the
host filesystem only as the engine releases blocks, which is why `reclaim`
reports `freedBytes` from free space measured before and after, never from
Docker's own "reclaimable" figure.

### Reclaim only when it is worth it

Each method writes its own data instance — `usage`, `plan`, `reclaim` — so an
expression always gets the schema it expects, whichever method ran last. A
workflow can therefore gate on measured state rather than pruning on a blind
schedule:

```yaml
steps:
  - name: measure
    model: docker-host
    method: observe

  - name: reclaim
    model: docker-host
    method: reclaim
    arguments:
      apply: true
    # Only when the disk is filling AND there is something worth taking.
    guard: >-
      data.latest("docker-host", "usage").attributes.disk.usedPercent > 80 &&
      data.latest("docker-host", "usage").attributes.totalReclaimableBytes > 5000000000
```

## Data instances

| Instance  | Written by | Holds |
| --------- | ---------- | ----- |
| `usage`   | `observe`  | Per-class sizes, reclaimable bytes, disk free. |
| `plan`    | `plan`     | Removal candidates and protections. |
| `reclaim` | `reclaim`  | What a reclaim actually did, and space measured freed. |

They are deliberately separate. One shared instance would make
`data.latest(model, "current")` return whichever *method* ran last, with a
different schema each time — and an expression over a field that is missing
dies during evaluation, which in a step with `allowFailure: true` reports
SUCCEEDED while doing nothing.

## Global arguments

| Argument | Default | Meaning |
| -------- | ------- | ------- |
| `sshHost` | *required* | Hostname or IP of the Docker host, or `local` to run on this machine via `sh -c`. **No default** — this model runs destructive commands, and a default host is a way to run them somewhere unintended. |
| `sshUser` | `root` | SSH user. Needs to be able to talk to the Docker socket. Ignored when `sshHost` is `local`. |
| `keepVersions` | `2` | Newest tagged images kept per repository. `0` keeps none. |
| `buildCacheKeepHours` | `168` | Keep build cache newer than this. `0` prunes all of it. |
| `dataRoot` | `/var/lib/docker` | Path used to measure free space. Should be on the filesystem holding Docker's data root. |
| `strictHostKeyChecking` | `accept-new` | SSH host key policy: `yes`, `accept-new`, or `no`. |
| `knownHostsFile` | *unset* | Explicit `known_hosts` path, for runtimes whose `HOME` is not the operator's. |

## On host key checking

Host key verification is **on** by default. `accept-new` pins a host on first
contact and refuses a changed key thereafter; `yes` requires the key to already
be known.

`no` is available and is never the default. A model whose entire purpose is
running destructive commands as a privileged user is the last place to accept
an unverified host key, and `StrictHostKeyChecking=no` paired with
`UserKnownHostsFile=/dev/null` — a common shortcut in SSH-based tooling — means
every connection silently trusts whatever answers.

## Requirements

- SSH access to the host, key-based (`BatchMode=yes` — a run will not sit on a
  password prompt). Not needed with `sshHost: local`, where the invoking user
  must be able to reach the local Docker socket instead.
- The SSH user can reach the Docker socket, via the `docker` group or
  equivalent.
- Docker CLI on the host supporting `docker system df --format`,
  `docker images --format` and `docker context show`, with the buildx plugin
  (`docker buildx inspect`, `docker builder prune --builder -a --filter`).
  Docker Engine 23+ and Docker Desktop ship it; on a distribution package it
  may be separate (`docker-buildx`).

## What it does not do

- **Volumes.** `docker volume prune` deletes data, not cache. This model
  reports volume usage in `observe` and will not remove one.
- **Containers.** It never stops, removes or restarts anything.
- **Compose lifecycle.** Use [`@keeb/docker`](https://github.com/keeb/swamp-docker)
  for that; this model deliberately does not overlap with it.
