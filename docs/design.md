# System Monitor V2 design

## Product surfaces

System Monitor has three distinct surfaces backed by one service snapshot:

1. **Work Status** stays compact: a shared health state and CPU, memory, busiest GPU, and fullest valid disk.
2. **Rail panel** is a summary and diagnostic workspace with Overview, Performance, Storage, Hardware, Health, Optimization, and Settings tabs. Its header stays available while scrolling. CPU and storage use secondary segmented controls instead of stacking every detail.
3. **Full-page dashboard** reuses the panel entry and adds a responsive, wider layout. OpenChamber registers it as `contributes.page`; the host's Extension pages menu opens it. SDK `openSurface` is for rail surfaces and does not open contributed full pages.

The UI remains vanilla TypeScript. SDK UI controls provide host-consistent buttons, badges, progress, tabs, selects, switches, banners, and spinners. CSS uses `--oc-*` variables, keeps `color-scheme` synchronized with the host, and disables motion under `prefers-reduced-motion`. Overview nodes persist between readings. Other views patch their existing DOM where the structure is stable; settings controls are rebuilt only when entering that tab or changing context.

These decisions follow the official [extension guide](https://docs.openchamber.dev/extensions/), [SDK overview](https://docs.openchamber.dev/sdk/), [host API](https://docs.openchamber.dev/sdk/host/), and [UI Kit](https://docs.openchamber.dev/sdk/ui/). In particular, a contributed page is discovered by the host's Extension pages menu, storage is provided by the host, and the panel itself remains a sandboxed UI surface.

## Data ownership and contracts

`src/service/` collects, samples, evaluates warnings, and computes health. Both sandboxed frames render the same authenticated `GET /stats` snapshot. `src/shared/stats.ts` is the sole source of metric contracts, availability states, settings validation, thresholds, and bounds. `src/shared/health.ts` calculates the common health state for the rail, dashboard, and Work Status.

Every source is `ok` with measured values or `unavailable` with a reason (`pending`, `disabled`, `tool-missing`, `no-device`, `unsupported`, or `failed`). Optional numeric values remain `null`/omitted when absent. Parsers are pure functions; collectors own OS calls and turn failures into source-specific unavailability. A failure in one collector cannot make `/stats` fail for the others.

## Sampling and history

The sampler primes CPU counters, collects CPU/memory/GPU at 2-second ticks, and runs slower collectors independently:

| Cadence | Sources |
| --- | --- |
| 2 s | CPU, memory, GPU |
| 5 s | Network rates, disk activity |
| 10 s | Top processes, temperature sensors |
| 30 s | Battery, disk capacity |
| 5 min | Static computer/OS details |

The first optional collectors are staggered after the fast reading. Windows PowerShell is not launched on every fast tick; Windows GPU uses a bounded long-lived helper and exits when sampling pauses/stops. Failed sources retain the last good value for two transient failures, then report unavailable and retry after a minute. Unsupported/no-device results remain explicit.

Each display series is a 60-point ring. The selected history window determines the resolution: 2 minutes at 2 s, 5 minutes at 5 s, 15 minutes at 15 s, or 30 minutes at 30 s. Changing the window clears that series so points are never mislabeled with a different interval. CPU/GPU sustained-warning calculations use a separate two-minute, 2-second ring, so visual downsampling does not delay or weaken alerts. All history is memory bounded and is cleared when the sampler idles for 30 seconds.

Disk capacity is sampled every 30 seconds; disk I/O and network counters every 5 seconds. Rates require two counter readings and stay null before a baseline or after a counter reset. No public-IP lookup or other internet request is made.

## Platform sources and limitations

Collectors and pure parsers are under `src/service/collectors/`:

- **CPU/memory:** Node CPU counters on all platforms; Linux cgroup limits, `/proc/meminfo`, PSI and sysfs current frequency where available; macOS `vm_stat` and `sysctl vm.swapusage`; Windows Node memory totals and pagefile CIM data.
- **GPU:** NVIDIA `nvidia-smi` with basic-query fallback if optional sensor columns are unsupported; Linux AMD utilization/VRAM from DRM sysfs; Windows WMI 3D-engine and WDDM memory counters; macOS `ioreg` accelerator statistics. Values not exposed by a driver stay unavailable.
- **Storage:** `df` parsing with APFS shared-container folding, Linux duplicate/bind/virtual-filesystem filtering, Windows logical volumes; disk activity uses Linux `/proc/diskstats` and Windows performance counters. macOS disk activity is unavailable.
- **Network:** Linux `/proc/net/dev` plus routes and sysfs link speed; macOS `netstat` plus route; Windows adapter statistics plus default-route CIM/PowerShell. Only active interfaces are listed where the OS gives a reliable state.
- **Processes:** bounded `/proc` reads on Linux, Windows performance CIM, and `ps` on macOS. The UI receives only the configured top 5/10/20, without command line or path collection; no process action is offered.
- **Battery/temperature/hardware:** OS-native sources only. Some sensor families are not safely exposed without vendor utilities or elevated privileges and remain unavailable. Hardware collection avoids serial numbers and product keys.

Containers are detected and use cgroup CPU/memory limits where present. Other platforms or fields use host/OS fallbacks only when the values are known to be meaningful.

## Settings, warnings, and recommendations

The panel stores validated extension preferences via `host.storage` and sends the same bounded JSON to the local service's `/settings` endpoint. The service accepts only a small JSON body, normalizes enumerated choices and clamps thresholds; no setting becomes a command or path.

Optional network/process/battery/sensor collectors can be disabled. Core CPU/memory/GPU/disk data stays active for Work Status and health. Defaults: memory/disk 85% warning and 95% critical; CPU/GPU 85% warning and 95% critical when sustained for 60 seconds; swap warning at 50%. CPU/GPU sustained durations can be 30/60/120 seconds. Warning state is calculated once, then reused by every surface.

Optimization is recommendation-only. The current Windows disk recommendation offers one explicit action that opens the OS Storage settings page. No cache cleanup, file deletion, registry change, service change, restart, or process termination is performed.

## Security and privacy

The service listens only on `127.0.0.1` and requires the per-instance bearer token OpenChamber supplies. Requests are limited to `/health`, `/stats`, validated `/settings`, and a fixed Windows Storage-settings action. The extension makes no network requests, has no telemetry, and never executes user-supplied text. PowerShell scripts and arguments are constants; subprocesses have timeouts and the GPU helper is terminated on pause/idle/shutdown.

Metrics remain local. Copied diagnostics exclude hostnames, usernames, home paths, serials, disk device/mount identifiers, process rows, and credentials. They contain platform/OS family, hardware model names where available, coarse metric values, volume ordinals/capacities, and warning types.

## Verification

`test/` covers pure Linux/macOS/Windows parsing, settings normalization, warning duration, health, sampler cadence, capped history, idle/pause behavior, and frame contracts. `scripts/smoke.mjs` starts the built service with OpenChamber's minimal environment and checks the live HTTP contract. `scripts/preview.ts` is a local browser shim for visual layout checks; it is not a substitute for verifying the installed extension in OpenChamber.

Required release checks are `bun run typecheck`, `bun test`, `bun run build`, `bun run check`, `node scripts/smoke.mjs`, and a visual pass through `bun run preview`. No version or release is created by this V2 implementation before those checks pass.
