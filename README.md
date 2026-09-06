# swamp-docker-reclaim

A [swamp](https://github.com/systeminit/swamp) extension for reclaiming disk on
a Docker host — measuring what the disk is actually spent on, planning what can
be freed without destroying a rollback target, and freeing it.

**The full documentation is [`extensions/models/README.md`](extensions/models/README.md)**,
which is also what ships with the extension.

## Why

`docker image prune` — dangling, or even `-a` — **never touches the build
cache**, and on a host that builds its own images the build cache is usually
most of the footprint. On the host this was written against, the build cache
was 59.5 GB of a 77 GB reclaim. Pruning images, the only thing most Docker
tooling automates, would have left 77% of the problem in place.

Meanwhile `docker image prune -a` removes every image no container references
— which is precisely the set of previous versions you would roll back to.

This model measures first, protects rollback targets and hot build cache, and
is dry-run by default.

## Install

```bash
swamp extension pull @sntxrr/docker-reclaim
```

## Quick start

```bash
swamp model create @sntxrr/docker-reclaim/host docker-host \
  --global-arg sshHost=docker.example.com \
  --global-arg sshUser=deploy

swamp model @sntxrr/docker-reclaim/host method run observe docker-host
swamp model @sntxrr/docker-reclaim/host method run plan docker-host
swamp model @sntxrr/docker-reclaim/host method run reclaim docker-host --arg apply=true
```

## Layout

```
extensions/models/
├── manifest.yaml          # extension manifest
├── docker_host.ts         # the @sntxrr/docker-reclaim/host model
├── docker_host_test.ts    # unit tests for the pure core
├── README.md              # full documentation (ships with the extension)
└── LICENSE.md
```

## Development

```bash
# Bundled deno is not on PATH.
~/.swamp/deno/deno test extensions/models/docker_host_test.ts
~/.swamp/deno/deno check extensions/models/docker_host.ts

swamp extension fmt     extensions/models/manifest.yaml --check --json
swamp extension quality extensions/models/manifest.yaml --json
```

Every function that decides what gets deleted is pure and exported, so the
protection logic is unit-tested rather than only observed in production. The
failure mode here is silent and unrecoverable, which is why `planImages` has a
test per protection.

## License

MIT. See [`extensions/models/LICENSE.md`](extensions/models/LICENSE.md).
