# AGENTS.md

OpenChamber extension (SDK `@openchamber/sdk`, manifest in `package.json` → `openchamber`). A host-spawned Node service measures; two sandboxed iframes draw.

## Layout

- `src/shared/stats.ts`: the `/stats` contract, limits and thresholds. Both sides import it.
- `src/service/`: the service. `main.ts` (HTTP on 127.0.0.1, token check), `sampler.ts` (2 s tick, 30 s idle stop, history, failure policy), `warnings.ts`, `env.ts` (platform, container).
- `src/service/collectors/parse-*.ts`: **pure** parsers, text in, typed values out. `cpu-mem.ts`, `gpu.ts`, `disks.ts`, `windows.ts` run the tools and call the parsers.
- `src/frame/`: shared frame code: host wiring, poller, `/stats` boundary check, formatting, UI helpers.
- `src/panel/`, `src/status/`: the rail panel and the Work Status section.
- `src/i18n/messages.ts`: all 13 OpenChamber locales.
- `test/`: `bun test`; `test/fixtures/` holds real tool output.
- `scripts/build.ts` builds `dist/`; `scripts/smoke.mjs` starts the built service and checks a live answer; `scripts/preview.ts` hosts both frames in a browser.

## Commands

```bash
bun run check              # typecheck + tests + build
node scripts/smoke.mjs     # smoke test against this machine
SMOKE_RUNTIME=bun node scripts/smoke.mjs
bun run preview            # frames in a browser via a stand-in host (scripts/preview.ts)
```

The preview only polls while its tab is visible, like inside OpenChamber.

## Rules

- A missing value is `null` or `unavailable`, never 0. A parser that cannot read its input returns `null`.
- Every new source gets a pure parser and a fixture with real output. Strip serial numbers and other identifiers from fixtures.
- Collectors never throw into the sampler; one failing source must not hide the others.
- The service runs with a minimal environment (PATH, HOME, temp, locale, Windows system variables). Call system tools by absolute path first, then the bare name. Windows PowerShell hangs without `PSModulePath`, so always start it through `powerShellEnv()`; `scripts/smoke.mjs` uses the exact variable list OpenChamber passes.
- Frames are classic IIFE bundles in a sandboxed iframe: no network, no ESM, no Node APIs. Talk to the service only through `host.serviceRequest`.
- Style with the host theme variables (`--oc-*`) and keep `color-scheme` following `data-oc-theme`; without it a dark host paints the iframe white.
- New UI text goes into all 13 locales with the same placeholders; `test/frame.test.ts` enforces it.
- Run `bun run build` after every source change and commit `dist/` with it. CI fails when `dist/` is stale.
- No runtime dependencies besides `@openchamber/sdk`, which is bundled.
- Thresholds live in `src/shared/stats.ts`; do not duplicate them.

## Releasing

1. Bump `version` in `package.json`, add a section to `CHANGELOG.md`.
2. `bun run check`, commit including `dist/`.
3. Tag `vX.Y.Z` and push the tag; create a GitHub release from it.

OpenChamber compares the installed `version` with the repository's and offers the update.
