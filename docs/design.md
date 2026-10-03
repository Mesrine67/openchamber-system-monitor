# Design

Agreed 2026-10-04 before implementation.

## Goal

An OpenChamber extension for all users that shows the load of the machine OpenChamber runs on: a detailed rail panel and a compact section in the Work Status panel. macOS, Linux and Windows. All OpenChamber languages. Fixed thresholds, no settings in 1.0.

## Approach

The service measures and computes; the frames only draw. One service per OpenChamber instance samples every 2 s while a frame asks, keeps a 60-point ring buffer (2 minutes) and evaluates the warning rules. Both frames fetch the same finished snapshot from `GET /stats`, so they never disagree and the history survives closing the panel. Rejected: frames computing deltas themselves (duplicate logic, diverging views); a native helper binary (cross-compilation, unsigned binaries, no clear gain).

## Contract

`src/shared/stats.ts`. Every source (`cpu`, `memory`, `gpus`, `disks`) is either `ok` with values or `unavailable` with a reason (`tool-missing`, `no-device`, `unsupported`, `failed`). Unknown values are `null`.

## Sampling

- First request primes the CPU baseline, waits 500 ms, measures, then ticks every 2 s.
- 30 s without a request: stop, end helper processes, drop the history.
- Disks every 30 s. A failing source keeps its last value for two failures and reports `unavailable` on the third; anything unavailable is retried after 60 s.

## Sources

See the README table. Decisions worth knowing:

- macOS memory follows Activity Monitor (`vm_stat`: anonymous − purgeable + wired + compressed); `os.freemem()` would show a Mac as nearly full.
- APFS volumes share their container's space; volumes with equal size and free space are folded into one disk.
- Linux containers (`/.dockerenv`, `/run/.containerenv`, `/proc/1/cgroup`) use cgroup v2 (v1 fallback) limits. Without a limit, host values, still marked *Container*. Bind mounts with identical figures are one filesystem.
- Windows GPU: WMI classes `Win32_PerfFormattedData_GPUPerformanceCounters_*` from one long-lived PowerShell loop. Their names are not localised, unlike `typeperf` counter paths, and the loop avoids PowerShell's start-up cost per tick. The loop exits when the service process is gone.

## Warnings and badge

Disk and memory: warn at 90 %, critical at 95 %. CPU and GPU: warn after 60 s at or above 90 %. The badge counts active warnings; the status section sets it only when the set of warnings changes, so opening the panel (which clears it) does not bring it straight back.

## Out of scope for 1.0

Settings, network, disk I/O, temperatures, battery, processes, container detection on macOS/Windows hosts, VS Code and mobile (OpenChamber loads no extensions there).
