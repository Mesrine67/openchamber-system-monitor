---
name: system-monitor-diagnostics
description: Diagnose OpenChamber System Monitor readings, missing metrics, extension loading, and service failures using the current host's available tools.
---

# OpenChamber System Monitor diagnostics

Use this workflow when the user asks about the OpenChamber System Monitor extension, its readings, missing devices, alerts, or startup/performance.

## Ground rules

- First establish which OpenChamber host is active: Windows, WSL/Linux, or a remote OpenChamber service. Metrics belong to the machine running the host service.
- Use only tools that are actually available in the current session. A plugin skill does not itself grant access to the desktop, OpenChamber service, or WSL.
- Inspect the repository's `AGENTS.md`, extension manifest, and relevant source before proposing source changes.
- Distinguish a genuinely unsupported reading from a collector failure. Unknown readings remain unavailable; never invent zero values.
- Prefer bounded, read-only diagnostics. Do not expose tokens, credentials, serial numbers, personal paths, or full environment dumps in reports.
- Keep the OpenChamber application source separate from the extension repository unless the user explicitly asks to modify OpenChamber itself.
- Never claim that the UI was tested unless it was opened and observed in the actual host. Report build/test evidence separately from live UI evidence.

## Diagnostic sequence

1. Capture the exact symptom, extension version, OpenChamber version, OS, and whether the host is local or remote.
2. Inspect current extension files and recent git state before editing. Preserve local work and upstream attribution.
3. Trace the affected metric or UI through its shared contract, collector/service, frame/panel/status entry, translations, and tests.
4. Reproduce with the smallest safe check available. Use sanitized fixtures for parser work and bounded process output for live checks.
5. Fix the underlying cause with a platform-aware fallback. Add parser fixtures/tests for new output formats.
6. Run the repository's documented checks. State exactly which checks passed and whether the actual OpenChamber UI was verified.

## Reporting

Summarize the cause, files changed, validation performed, remaining platform limits, and any user action required. Do not imply a GitHub commit, push, tag, or release happened unless the remote confirms it.
