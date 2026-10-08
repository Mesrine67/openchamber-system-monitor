# WSL manager coverage

System Monitor adds an optional WSL manager for Windows-hosted OpenChamber. It follows the OpenChamber theme, font, locale and SDK controls. It does not create a parallel WSL UI theme or desktop application.

## Implemented

| Area | Extension behavior |
| --- | --- |
| Installed distributions | List, status, default, WSL version, install source, detected virtual-disk file size and guest OS/kernel details for running distributions. Search and filter by state, WSL version and source. |
| Running guest readings | Root filesystem capacity, process count, and Windows GPU integration checks. xrdp is exposed only when a valid port is detected. Memory is shown once as shared WSL 2 VM memory when `free` is installed; it is not a per-distribution reading. CPU use per distribution remains unavailable because the WSL host API does not provide a reliable per-distro CPU measurement. |
| On-demand guest diagnostics | For a running WSL 2 distribution, inspect a bounded process sample formed from the top 100 CPU and top 100 memory entries, merged by PID, plus up to 100 TCP/UDP listening sockets, guest IPv4/IPv6 addresses, the IPv4 default gateway and configured DNS servers. The process view supports local name/PID search and CPU/memory sorting. CPU and memory percentages are guest process readings, not per-distribution host attribution. The explicitly configured global networking mode is shown when readable; it is not presented as proof of effective runtime mode. Process command lines and user names are not collected. Missing `ps`, `ss` or `ip` is reported as unavailable. No process control is exposed. |
| Global WSL | Show WSL/kernel versions and default distro/version; load the official `wsl --list --online` catalog on request; update WSL, set the default version, and shut down after a typed confirmation. |
| Distribution lifecycle | Start, stop, restart, set default, switch WSL 1/2 with a backup warning and typed confirmation, and open Terminal, Explorer, VS Code or detected xrdp. |
| Install and backup | Install a selected entry from Microsoft's own online WSL catalog; import and export TAR archives; clone or rename through an export/import staging archive, checking destination paths and preserving recovery archives on failed imports. |
| Configuration | Read and edit `%UserProfile%\\.wslconfig` and a distribution's `/etc/wsl.conf`. Save requires typing the exact confirmation phrase and a notice describing the impact of WSL settings. Set default Linux user validates the account and updates only the `[user]` section. |
| Apply configuration | Saved global and per-distribution configuration targets remain visible as pending until a successful full WSL shutdown or a successful start/restart of the affected distribution. This state is stored through the OpenChamber extension storage API and contains only the target kind and distro name. |
| Disk management | Move, resize, sparse mode and compact operations are available as fixed WSL CLI actions. Long-running or disruptive actions require typed confirmation. They run with OpenChamber's current privileges and may be unavailable when that process is not elevated. |

WSL calls start only when the user opens this tab. The view polls at a 30-second interval while visible. WSL 1 and stopped distributions are not launched to gather Linux guest readings. Registration metadata is cached for five minutes; live guest details for twenty seconds. At most three running distributions are probed concurrently.

## Deliberately outside extension scope

This is not 100% feature parity with [WSL UI](https://github.com/octasoft-ltd/wsl-ui). WSL UI is a standalone elevated desktop application; an OpenChamber extension is a sandboxed iframe plus a host service with the user's current privileges. The extension therefore does not implement:

- physical/VHD disk mount and unmount, which require elevated host operations;
- UAC elevation prompts or an administrator shell;
- arbitrary custom shell actions, command templates or regex-targeted execution;
- arbitrary rootfs URLs, container/Podman images, LXC catalogs or custom distribution manifests;
- Linux desktop provisioning scripts or automatic xrdp repair;
- a system tray, startup behavior or independent application settings;
- WSL UI's private theme editor or language selector (the OpenChamber theme/locale is authoritative);
- detailed distro installation paths/creation dates or reliable CPU-by-distro usage;
- WSL UI's native semantic configuration editor and mounted-disk status panel.

These omissions avoid arbitrary code installation/execution, admin elevation, duplicated host preferences and invented metrics. WSL 2-only virtual disk operations are hidden for WSL 1 distributions. The extension shows unavailable readings as unavailable rather than fabricating a value.

## Service and security model

The panel calls only authenticated local service routes:

- `GET /wsl`: installed distributions and live details for already-running distros.
- `GET /wsl/diagnostics?distro=<name>`: bounded process, listening-port, and (when systemd is available) service-state diagnostics for one already-running WSL 2 distribution, plus local network configuration readings.
- `GET /wsl/catalog`: official WSL online distribution list; this network-backed Microsoft CLI command runs only after the user requests the catalog.
- `GET /wsl/config`: read a supported global or per-distribution configuration file.
- `POST /wsl/config`: save a bounded configuration after exact typed confirmation.
- `POST /wsl/action`: enqueue one validated WSL operation.
- `GET /wsl/jobs/<uuid>`: read the result of an enqueued operation.

The service checks the OpenChamber bearer token before these routes, listens on loopback only, and does not expose an arbitrary command endpoint. WSL names, versions and Windows paths are validated in `src/shared/wsl.ts`. External process calls use fixed `execFile` argument arrays, no shell interpolation for Windows-side commands, bounded output and operation-specific timeouts. The two fixed Linux probes contain no user text; a distro name is passed as its own argument. Destructive actions require the exact distribution name or a specific typed phrase in the panel and are revalidated at the service boundary.

`src/service/collectors/parse-wsl.ts` and `parse-wsl-conf.ts` contain pure parsers; fixtures under `test/fixtures/` are sanitized. Do not move WSL sampling into the System Monitor sampler or startup path.

Guest addresses, gateway and DNS values are read locally from `hostname -I`, `ip route` and `/etc/resolv.conf` only when the user requests a diagnostic. Service state is read with a fixed `systemctl list-units` command; unsupported/missing systemd is reported as unavailable, and no service control action is exposed. This does not test DNS reachability, Windows-to-WSL connectivity, firewall decisions or active sockets beyond the existing local listener listing. NAT and mirrored networking have different localhost behavior; see Microsoft's [WSL networking guidance](https://learn.microsoft.com/en-us/windows/wsl/networking) and [systemd support documentation](https://learn.microsoft.com/en-us/windows/wsl/systemd).
