---
name: wsl-system-inspection
description: Safely inspect and manage Windows Subsystem for Linux from a local Windows host, with clear limits and confirmation before impactful changes.
---

# Windows and WSL system inspection

Use this workflow for Windows/WSL inventory, troubleshooting, resource usage, configuration review, and carefully scoped maintenance.

## Establish the execution host

- Confirm that the active execution environment is the user's Windows PC before using Windows commands. If the session is cloud-only, remote, or Linux without Windows interop, explain that it cannot inspect the PC.
- On Windows, prefer `wsl.exe` with fixed argument arrays and bounded output. On Linux inside WSL, use Linux read-only tools and do not assume they can manage the Windows host.
- This skill is guidance, not an MCP server or a permission grant. It does not create a persistent connection to OpenChamber, Windows, or WSL.

## Read-only inventory first

Use targeted commands such as:

- `wsl.exe --status`
- `wsl.exe --version`
- `wsl.exe --list --verbose`
- `wsl.exe --list --online` only when the user asks about available distributions and network lookup is appropriate
- Read `%UserProfile%\.wslconfig` only if present; redact usernames and other personal paths from copied output.
- Inside a running distro, use bounded commands such as `uname -a`, `df -h`, `free -h`, `uptime`, and a short process listing.

Do not start stopped distributions merely to collect information. Ask before launching a distro if that would change its state.

## Changes and safety

- Explain the exact planned change and its effect before modifying `.wslconfig`, installing/importing/removing a distribution, changing defaults or WSL versions, terminating a distro, compacting a VHD, or changing networking/systemd settings.
- Require clear user authorization for the specific operation. Never unregister a distribution, delete/overwrite a VHD or root filesystem, or run cleanup that removes user data without explicit confirmation of the exact target.
- Do not pass user-provided text through a shell. Use fixed commands/argument arrays and validate paths before file operations.
- Prefer reversible edits: back up the existing config, change only the requested setting, and provide a rollback path.
- Never run arbitrary downloaded scripts as administrator or request elevated access without explaining why it is necessary.

## Troubleshooting

1. Record Windows build, WSL version, distro state/version, and the exact error; redact usernames and secrets.
2. Compare the observed condition with current official Microsoft documentation when version-sensitive behavior matters.
3. Change one variable at a time and verify with `wsl.exe --status` or the relevant read-only command.
4. Report whether commands ran on Windows or inside a specific Linux distribution. Do not conflate host metrics with guest metrics.
