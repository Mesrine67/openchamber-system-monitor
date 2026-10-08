# AGENTS.md

OpenChamber extension (SDK `@openchamber/sdk`, manifest in `package.json` → `openchamber`). A host-spawned Node service measures; two sandboxed iframes draw.

## Layout

- `src/shared/stats.ts`: the `/stats` contract, settings bounds, thresholds and history limits. Both sides import it; `src/shared/health.ts` owns the shared health calculation.
- `src/service/`: authenticated localhost service, staggered sampler, validated settings endpoint, warnings and OS/container detection.
- `src/service/collectors/parse-*.ts`: **pure** parsers, text in, typed values out. Platform collectors gather CPU/memory/GPU, storage/activity, network, processes, battery, sensors and static hardware.
- `src/shared/wsl.ts`, `src/service/wsl.ts`, and `src/panel/wsl-view.ts`: optional Windows-only WSL management, typed contracts, fixed-command service operations, and a theme-aware panel tab. WSL work is lazy: never query or start distributions during service startup or normal metric sampling.
- `src/frame/`: shared frame code: host wiring, poller, `/stats` boundary check, formatting, sparklines and UI helpers.
- `src/panel/`: rail summary, diagnostic tabs, Settings and the responsive full-page entry.
- `src/status/`: compact Work Status section; do not turn it into the full dashboard.
- `src/i18n/messages.ts` and `src/i18n/monitor.ts`: host labels and System Monitor labels across the OpenChamber locale set.
- `test/`: `bun test`; `test/fixtures/` holds sanitized tool output for all supported platform parsers.
- `scripts/build.ts` builds `dist/`; `scripts/smoke.mjs` starts the built service and checks a live answer; `scripts/preview.ts` hosts both frames in a browser.

## Commands

```bash
bun run check              # typecheck + tests + build
node scripts/smoke.mjs     # smoke test against this machine
SMOKE_RUNTIME=bun node scripts/smoke.mjs
bun run preview            # frames in a browser via a stand-in host (scripts/preview.ts)
```

The preview only polls while its tab is visible, like inside OpenChamber. Its page-mode button simulates the host Extension pages menu because the SDK cannot open contributed pages through `openSurface`.

## Rules

- A missing value is `null` or `unavailable`, never 0. A parser that cannot read its input returns `null`.
- Every new source gets a pure parser and a sanitized fixture with representative OS output. Strip hostnames, usernames, serial numbers, personal paths, and other identifiers from fixtures.
- Collectors never throw into the sampler; one failing source must not hide the others.
- The service runs with a minimal environment (PATH, HOME, temp, locale, Windows system variables). Call system tools by absolute path first, then the bare name. Windows PowerShell hangs when `PSModulePath` is unset or only the system folder, so always start it through `powerShellEnv()` (it sets it empty); `scripts/smoke.mjs` uses the exact variable list OpenChamber passes.
- Frames are classic IIFE bundles in a sandboxed iframe: no network, no ESM, no Node APIs. Talk to the service only through `host.serviceRequest`; persist extension preferences with `host.storage`.
- WSL endpoints are `/wsl`, `/wsl/catalog`, `/wsl/config`, `/wsl/action`, and `/wsl/jobs/<id>`. Validate actions and arguments in `src/shared/wsl.ts`; use `execFile` with fixed argument arrays, bounded input/output, typed confirmation for destructive or lengthy operations, and no user-provided shell text. WSL probes must remain on demand from the WSL tab.
- Style with the host theme variables (`--oc-*`) and keep `color-scheme` following `data-oc-theme`; without it a dark host paints the iframe white.
- New UI text goes into `src/i18n/monitor.ts` for the supported locale set; avoid hard-coded labels in panel/status views. Keep placeholders consistent and cover locale completeness in tests.
- Run `bun run build` after every source change and commit `dist/` with it. CI fails when `dist/` is stale.
- No runtime dependencies besides `@openchamber/sdk`, which is bundled.
- Thresholds live in `src/shared/stats.ts`; do not duplicate them.

## Releasing

1. Bump `version` in `package.json`, add a section to `CHANGELOG.md`.
2. `bun run check`, commit including `dist/`.
3. Tag `vX.Y.Z` and push the tag; create a GitHub release from it.

OpenChamber compares the installed `version` with the repository's and offers the update.
