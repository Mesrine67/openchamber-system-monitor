# System Monitor for OpenChamber

System Monitor is a local OpenChamber extension for monitoring and diagnosing the machine that runs the OpenChamber service. It keeps Work Status compact, offers a focused rail panel, and contributes a full-page dashboard for deeper inspection.

## What it includes

- **Work Status:** compact health, CPU, memory, GPU, and fullest-volume readings.
- **Rail panel:** Overview, Performance, Storage, Hardware, Health, Optimization, and Settings views. CPU history can switch between overall and per-core; storage separates capacity from activity.
- **Full-page dashboard:** open System Monitor from OpenChamber’s **Extension pages** menu. The SDK does not let an extension open its contributed page programmatically; the rail button explains where to find it.
- **Health and recommendations:** shared health state, configurable warning/critical thresholds, and read-only suggestions. The only current system action opens Windows Storage settings.
- **Diagnostics:** copy a sanitized Markdown/JSON summary that omits hostnames, user paths, disk identifiers, and process lists.
- **History:** bounded 60-point display history. A 2/5/15/30-minute window uses a matching 2/5/15/30-second sample interval; sustained alerts keep their own short high-resolution buffer.

The UI uses OpenChamber SDK controls and `--oc-*` theme tokens. It follows host theme changes, supports reduced-motion preferences, and avoids recreating the overview DOM on each fast update.

## Install

You need OpenChamber 2.0.1 or newer on desktop or web. Extensions are not loaded in VS Code or mobile clients.

1. Open **Settings → Extensions**.
2. Add `https://github.com/Mesrine67/openchamber-system-monitor`.
3. Review and allow the local service permissions shown by OpenChamber.
4. Open the rail panel for live metrics. Use **Extension pages → System Monitor** for the full dashboard.

OpenChamber checks the installed manifest version against the repository when you ask it to check for extension updates. This repository keeps `dist/` committed so the Git install works without a local build.

## Collection and platform support

All measurements stay on the machine running the OpenChamber service. An OpenChamber client connected to a remote service sees that remote machine. Missing sensors are reported as unavailable; an unknown reading is never substituted with zero.

| Module | Windows | Linux | macOS |
| --- | --- | --- | --- |
| CPU | Usage, per-core usage, core count, load unavailable | Usage, per-core usage, load average, current frequency when sysfs exposes it | Usage, per-core usage, load average |
| Memory | Used/total and pagefile when readable | Used/available, cache, commit, swap, PSI pressure when exposed; cgroup limits in containers | Activity-Monitor-style used memory and swap |
| GPU | NVIDIA `nvidia-smi` metrics when supported; otherwise WMI 3D usage and WDDM memory | NVIDIA `nvidia-smi`; AMD sysfs utilization/VRAM where exposed | `ioreg` accelerator utilization and shared-memory usage where exposed |
| Storage capacity | Fixed and removable volumes | Local mounted filesystems with duplicate/bind mounts filtered | Volumes with shared APFS capacity folded together |
| Storage activity | Performance counters when available | Kernel disk counters | Unavailable |
| Network | Active adapters, default route, link speed and byte rates | Active interfaces, default route, link speed and byte rates | Interface counters and default route when available |
| Processes | Top CPU/memory via Windows performance counters | Bounded `/proc` scan | Bounded `ps` snapshot |
| Battery | Battery systems only | power-supply sysfs | `pmset` |
| Temperature | NVIDIA sensors when available | hwmon and NVIDIA sensors when available | Unavailable through this extension |
| Hardware | Computer, OS, CPU, memory and display-adapter details where WMI exposes them | DMI/sysfs and OS details where readable | `sysctl` and OS details where exposed |

Optional sensor fields such as GPU power, fan speed, temperature, memory pressure, disk response time, battery health, or current CPU frequency are only shown when the OS or driver provides them. Serial numbers and product keys are not collected.

## Sampling and resource use

- CPU, memory, and GPU sampling: every 2 seconds while a frame is actively requesting stats.
- Network and disk activity: every 5 seconds.
- Processes and temperatures: every 10 seconds.
- Battery: every 30 seconds.
- Disk capacity: every 30 seconds.
- Static computer information: every 5 minutes.
- The sampler stops after 30 seconds without a visible consumer, terminates its long-lived GPU helper, and drops history.

The settings page controls display refresh, history window, optional data modules, process-list size, alert thresholds, and pause/resume. Disabling an optional module reports `disabled` explicitly. CPU, memory, GPU, and capacity remain the core readings.

## Health and privacy

Defaults are 85% warning and 95% critical for memory and disk. CPU/GPU alerts require the configured sustained duration (60 seconds by default); swap alerts default to 50%. Change thresholds in the extension Settings tab.

The service binds to `127.0.0.1`, checks OpenChamber’s bearer token on every endpoint, and has no external listener, analytics, telemetry, or cloud dependency. System actions are explicit; monitoring and recommendations do not delete files, stop processes, edit the registry, or disable services. Process names/PIDs stay in the UI and are excluded from copied diagnostics.

## Development

Requires Bun and Node 22+.

```bash
bun install
bun run typecheck
bun test
bun run build
node scripts/smoke.mjs
bun run preview
```

`bun run check` combines typecheck, tests, and build. `bun run preview` starts a local service and a lightweight host shim with theme/language controls, extension storage, POST forwarding, and a simulated full-page view. It is a development preview, not an OpenChamber host integration test.

The package is vanilla TypeScript and OpenChamber SDK UI: no React or charting dependency. Pure parsers live beside platform collectors; tests use sanitized Linux, Windows, and macOS fixtures. See [docs/design.md](docs/design.md) for the V2 architecture and limits.

## License

[MIT](LICENSE)
