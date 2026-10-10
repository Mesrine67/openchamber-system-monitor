# OpenChamber System Tools

A portable Agent Plugin package for Codex and compatible ChatGPT desktop plugin workflows. It bundles two skills:

- `system-monitor-diagnostics`: investigate extension metrics, loading, and service problems.
- `wsl-system-inspection`: inspect Windows/WSL and guide explicitly authorized changes safely.

The plugin uses the active host's existing tools. It is not an OpenChamber extension, does not add an MCP connection, does not grant Windows/WSL permissions, and cannot access a local PC from a cloud-only session. There is no telemetry or external service.

## Install from this repository in Codex desktop

Add this repository as a Git marketplace using the `codex/openai-plugin` ref and the `.agents/plugins` sparse path, then choose **Mesrine67 System Tools** in the plugin directory and install **OpenChamber System Tools**. The marketplace catalog and plugin package are within `.agents/plugins`, so one sparse path is sufficient.

In the Add Marketplace dialog:

- Source: `Mesrine67/openchamber-system-monitor`
- Git ref: `codex/openai-plugin`
- Partial paths (one per line): `.agents/plugins` and `plugins/openchamber-system-tools`

The catalog is under `.agents/plugins`; the package itself is under `plugins/openchamber-system-tools`. Both paths must be included in the sparse checkout so Codex can read the catalog and resolve its package.

For command-line installation, use `codex plugin marketplace add Mesrine67/openchamber-system-monitor --ref codex/openai-plugin --sparse .agents/plugins --sparse plugins/openchamber-system-tools`, then restart the desktop app and select the plugin in the Plugins Directory.

## OpenAI public directory

This repository release is a Git marketplace distribution for local testing and personal/team use. It does not automatically publish the package into OpenAI's universal public Plugins Directory. Public directory submission is a separate OpenAI review/publishing process; an MCP-backed public plugin additionally needs a remote HTTPS MCP service. This package intentionally ships skills only.

## Package contents

`plugin.json` follows the portable Agent Plugins schema. `skills/` contains the two workflows. The repository marketplace manifest is at `.agents/plugins/marketplace.json`.
