import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WslAction, WslActionResult, WslCatalog, WslConfigDocument, WslConfigUpdate, WslDiagnostics, WslDistribution, WslSnapshot } from '../shared/wsl.ts';
import { decodeWslText, parseWslCatalog, parseWslDefaultVersion, parseWslDiagnostics, parseWslDistroDetails, parseWslList, parseWslRegistrationMetadata, parseWslVersions } from './collectors/parse-wsl.ts';
import { withDefaultWslUser } from './collectors/parse-wsl-conf.ts';
import { runPowerShell } from './collectors/windows.ts';

const root = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
const wslExe = join(root, 'System32', 'wsl.exe');
const knownName = (value: string) => value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f/\\]/.test(value) && !value.startsWith('-');
const cleanError = (value: string): string => decodeWslText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) || 'WSL a retourné une erreur sans détail.';

type CommandResult = { ok: true; stdout: string } | { ok: false; missing: boolean; error: string };

const runWsl = (args: string[], timeoutMs = 15_000): Promise<CommandResult> => new Promise((resolve) => {
  execFile(wslExe, args, { encoding: 'buffer', timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    const output = decodeWslText(stdout ?? '');
    if (!error) { resolve({ ok: true, stdout: output }); return; }
    const missing = 'code' in error && error.code === 'ENOENT';
    resolve({ ok: false, missing, error: cleanError(decodeWslText(stderr ?? '') || output || error.message) });
  });
});

const unavailable = (reason: WslSnapshot['reason'], error: string | null): WslSnapshot => ({
  supported: false, reason, version: null, defaultVersion: null, kernelVersion: null, wslgVersion: null,
  memoryUsedBytes: null, memoryTotalBytes: null, distributions: [], sampledAt: Date.now(), error,
});

const distroMetadataScript = `$ErrorActionPreference = 'SilentlyContinue'
$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
$rows = @()
if (Test-Path -LiteralPath $root) {
  $rows = @(Get-ChildItem -LiteralPath $root | ForEach-Object {
    $entry = Get-ItemProperty -LiteralPath $_.PSPath
    $disk = $null
    $vhd = if ($entry.BasePath) { Join-Path $entry.BasePath 'ext4.vhdx' } else { $null }
    if ($vhd -and (Test-Path -LiteralPath $vhd)) { $disk = (Get-Item -LiteralPath $vhd).Length }
    [pscustomobject]@{
      Name = [string]$entry.DistributionName
      Source = if ($entry.PackageFamilyName) { 'store' } elseif ($entry.BasePath) { 'imported' } else { 'unknown' }
      VirtualDiskBytes = $disk
    }
  })
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $rows -Compress))`;

let metadataCache: { expiresAt: number; items: Map<string, { source: WslDistribution['source']; virtualDiskBytes: number | null }> } | null = null;
const readRegistrationMetadata = async (): Promise<Map<string, { source: WslDistribution['source']; virtualDiskBytes: number | null }>> => {
  if (metadataCache && metadataCache.expiresAt > Date.now()) return metadataCache.items;
  const result = await runPowerShell(distroMetadataScript, 12_000);
  const items = new Map<string, { source: WslDistribution['source']; virtualDiskBytes: number | null }>();
  if (result.ok) {
    for (const row of parseWslRegistrationMetadata(result.stdout)) {
      items.set(row.name.toLocaleLowerCase(), { source: row.source, virtualDiskBytes: row.virtualDiskBytes });
    }
  }
  metadataCache = { expiresAt: Date.now() + 5 * 60_000, items };
  return items;
};

type WslDistroDetails = ReturnType<typeof parseWslDistroDetails>;
type EnrichedWslDistro = { distribution: WslDistribution; memoryUsedBytes: number | null; memoryTotalBytes: number | null };
const detailsCache = new Map<string, { expiresAt: number; details: WslDistroDetails }>();

const enrichDistro = async (distro: WslDistribution): Promise<EnrichedWslDistro> => {
  if (distro.state !== 'running') return { distribution: distro, memoryUsedBytes: null, memoryTotalBytes: null };
  const cacheKey = distro.name.toLocaleLowerCase();
  const cached = detailsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const { memoryUsedBytes, memoryTotalBytes, ...details } = cached.details;
    return { distribution: { ...distro, ...details }, memoryUsedBytes, memoryTotalBytes };
  }
  // Fixed command: distribution names are separate execFile arguments and are validated before use.
  const probe = [
    'printf "__OS__\\n"; cat /etc/os-release 2>/dev/null || true',
    'printf "\\n__KERNEL__=%s\\n" "$(uname -r 2>/dev/null)"',
    'printf "__MEM__\\n"; free -b 2>/dev/null | grep "^Mem:" || true',
    'printf "__DISK__\\n"; df -B1 / 2>/dev/null | tail -n 1',
    'printf "__PROCS__=%s\\n" "$(ps -e --no-headers 2>/dev/null | wc -l)"',
    'printf "__GPU__=%s,%s,%s,%s\\n" "$(test -e /dev/dxg && echo 1 || echo 0)" "$(test -e /usr/lib/wsl/lib/libcuda.so.1 && echo 1 || echo 0)" "$(command -v nvidia-ctk >/dev/null 2>&1 && echo 1 || echo 0)" "$(test -f /etc/cdi/nvidia.yaml && echo 1 || echo 0)"',
    'printf "__XRDP__=%s\\n" "$(awk -F= \'/^[[:space:]]*port[[:space:]]*=/{gsub(/[[:space:]]/, \"\", $2); if ($2 ~ /^[0-9]+$/) {print $2; exit}}\' /etc/xrdp/xrdp.ini 2>/dev/null)"',
  ].join('; ');
  const result = await runWsl(['--distribution', distro.name, '--exec', 'sh', '-c', probe], 10_000);
  if (!result.ok) return { distribution: distro, memoryUsedBytes: null, memoryTotalBytes: null };
  const details = parseWslDistroDetails(result.stdout);
  detailsCache.set(cacheKey, { expiresAt: Date.now() + 20_000, details });
  const { memoryUsedBytes, memoryTotalBytes, ...distributionDetails } = details;
  return { distribution: { ...distro, ...distributionDetails }, memoryUsedBytes, memoryTotalBytes };
};

export const readWslSnapshot = async (): Promise<WslSnapshot> => {
  if (process.platform !== 'win32') return unavailable('unsupported', 'La gestion WSL est disponible lorsque le service OpenChamber tourne sur Windows.');
  const [versionResult, listResult, statusResult, metadata] = await Promise.all([
    runWsl(['--version']), runWsl(['--list', '--verbose']), runWsl(['--status']), readRegistrationMetadata(),
  ]);
  if (listResult.ok === false) {
    return unavailable(listResult.missing ? 'tool-missing' : 'failed', listResult.error);
  }
  const version = versionResult.ok ? parseWslVersions(versionResult.stdout) : { version: null, kernelVersion: null, wslgVersion: null };
  const distributions = parseWslList(listResult.stdout).map((distro) => ({
    ...distro,
    ...(metadata.get(distro.name.toLocaleLowerCase()) ?? {}),
  }));
  const enriched = new Array<EnrichedWslDistro>(distributions.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(3, distributions.length) }, async () => {
    while (nextIndex < distributions.length) {
      const index = nextIndex++;
      const distro = distributions[index];
      if (distro) enriched[index] = await enrichDistro(distro);
    }
  }));
  // WSL 2 distributions share one utility VM; WSL 1 does not report this VM metric.
  const vmMemory = enriched.find((entry) => entry?.distribution.state === 'running' && entry.distribution.version === 2 && entry.memoryTotalBytes !== null);
  return {
    supported: true,
    reason: null,
    ...version,
    defaultVersion: statusResult.ok ? parseWslDefaultVersion(statusResult.stdout) : null,
    memoryUsedBytes: vmMemory?.memoryUsedBytes ?? null,
    memoryTotalBytes: vmMemory?.memoryTotalBytes ?? null,
    distributions: enriched.map((entry) => entry?.distribution).filter((entry): entry is WslDistribution => entry !== undefined),
    sampledAt: Date.now(),
    error: versionResult.ok ? null : versionResult.error,
  };
};

/** Collects bounded, read-only diagnostics only for a running WSL 2 distribution. */
export const readWslDiagnostics = async (name: string): Promise<WslDiagnostics> => {
  if (process.platform !== 'win32') throw new Error('Le service OpenChamber doit tourner sur Windows pour diagnostiquer WSL.');
  if (!knownName(name)) throw new Error('Nom de distribution invalide.');
  const snapshot = await readWslSnapshot();
  const distro = snapshot.distributions.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!distro || distro.state !== 'running' || distro.version !== 2) {
    throw new Error('Sélectionne une distribution WSL 2 en cours d’exécution.');
  }
  const probe = [
    'printf "__PROCESSES__\\n"; if command -v ps >/dev/null 2>&1; then ps -eo pid=,comm=,%cpu=,%mem= 2>/dev/null | awk \'$2 != "sh" && $2 != "ps" && $2 != "awk" && $2 != "sort" && $2 != "head"\' | sort -k3,3nr | head -n 10; else printf "__UNAVAILABLE__\\n"; fi',
    'printf "__PORTS__\\n"; if command -v ss >/dev/null 2>&1; then ss -H -lntu 2>/dev/null | awk \'{print $1 " " $5}\' | head -n 100; else printf "__UNAVAILABLE__\\n"; fi',
  ].join('; ');
  const result = await runWsl(['--distribution', distro.name, '--exec', 'sh', '-c', probe], 10_000);
  if (!result.ok) throw new Error(result.error);
  return { distro: distro.name, ...parseWslDiagnostics(result.stdout), sampledAt: Date.now() };
};

let catalogCache: { expiresAt: number; value: WslCatalog } | null = null;

export const readWslCatalog = async (force = false): Promise<WslCatalog> => {
  if (process.platform !== 'win32') return { supported: false, items: [], error: 'La liste des distributions WSL est disponible sur Windows.' };
  if (!force && catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.value;
  const result = await runWsl(['--list', '--online'], 30_000);
  const value: WslCatalog = result.ok
    ? { supported: true, items: parseWslCatalog(result.stdout), error: null }
    : { supported: false, items: [], error: result.error };
  catalogCache = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
};

export const readWslConfig = async (kind: 'global' | 'distribution', distro?: string): Promise<WslConfigDocument> => {
  if (process.platform !== 'win32') throw new Error('WSL configuration is available when the OpenChamber service runs on Windows.');
  if (kind === 'global') {
    const path = join(process.env.USERPROFILE || homedir(), '.wslconfig');
    try { return { target: { kind }, exists: true, text: await readFile(path, 'utf8') }; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { target: { kind }, exists: false, text: '' };
      throw error;
    }
  }
  if (!distro || !knownName(distro)) throw new Error('Invalid WSL distribution.');
  const result = await runWsl([
    '--distribution', distro, '--user', 'root', '--exec', 'sh', '-c',
    'if [ -f /etc/wsl.conf ]; then printf "__EXISTS__\\n"; cat /etc/wsl.conf; else printf "__MISSING__\\n"; fi',
  ]);
  if (!result.ok) throw new Error(result.error);
  const marker = result.stdout.indexOf('__EXISTS__\n');
  if (marker < 0) return { target: { kind, distro }, exists: false, text: '' };
  return { target: { kind, distro }, exists: true, text: result.stdout.slice(marker + '__EXISTS__\n'.length) };
};

export const saveWslConfig = async (update: WslConfigUpdate): Promise<void> => {
  if (process.platform !== 'win32') throw new Error('WSL configuration is available when the OpenChamber service runs on Windows.');
  if (Buffer.byteLength(update.text, 'utf8') > 16_384 || update.text.includes('\0')) throw new Error('WSL configuration must be at most 16 KB and cannot contain NUL characters.');
  if (update.kind === 'global') {
    const path = join(process.env.USERPROFILE || homedir(), '.wslconfig');
    const temporary = join(dirname(path), `.wslconfig.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, update.text, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return;
  }

  if (!knownName(update.distro)) throw new Error('Invalid WSL distribution.');
  const encoded = Buffer.from(update.text, 'utf8').toString('base64');
  const script = `set -eu
temporary="$(mktemp /etc/wsl.conf.XXXXXX)"
trap 'rm -f "$temporary"' EXIT
printf '%s' "$1" | base64 -d > "$temporary"
chmod 644 "$temporary"
mv -f "$temporary" /etc/wsl.conf
trap - EXIT`;
  const result = await runWsl(['--distribution', update.distro, '--user', 'root', '--exec', 'sh', '-c', script, 'sh', encoded]);
  if (!result.ok) throw new Error(result.error);
};

const launchDetached = (command: string, args: string[]): Promise<WslActionResult> => new Promise((resolve) => {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  child.once('error', (error) => resolve({ ok: false, message: cleanError(error.message) }));
  child.once('spawn', () => {
    child.unref();
    resolve({ ok: true, message: 'Commande lancée.' });
  });
});

const failed = (result: Extract<CommandResult, { ok: false }>): WslActionResult => ({ ok: false, message: result.error });
const success = (message: string): WslActionResult => ({ ok: true, message });

const pathExists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const isKnownDistro = async (name: string): Promise<boolean | null> => {
  const result = await runWsl(['--list', '--verbose']);
  if (!result.ok) return null;
  return parseWslList(result.stdout).some(({ name: installed }) => installed.toLocaleLowerCase() === name.toLocaleLowerCase());
};

const createWslCopy = async (source: string, newDistro: string, location: string, version: 1 | 2): Promise<WslActionResult> => {
  if (await pathExists(location)) return { ok: false, message: 'Le dossier de destination existe déjà. Choisis un nouveau dossier.' };
  const parentExists = await lstat(dirname(location)).then((stat) => stat.isDirectory()).catch(() => false);
  if (!parentExists) return { ok: false, message: 'Le dossier parent doit déjà exister.' };
  const alreadyInstalled = await isKnownDistro(newDistro);
  if (alreadyInstalled === null) return { ok: false, message: 'Impossible de vérifier les distributions déjà installées.' };
  if (alreadyInstalled) return { ok: false, message: `${newDistro} existe déjà.` };
  const archive = join(dirname(location), `.openchamber-wsl-copy-${randomUUID()}.tar`);
  const exported = await runWsl(['--export', source, archive], 900_000);
  if (!exported.ok) {
    await rm(archive, { force: true }).catch(() => undefined);
    return failed(exported);
  }
  const imported = await runWsl(['--import', newDistro, location, archive, '--version', String(version)], 900_000);
  if (!imported.ok) return { ok: false, message: `${imported.error} L’archive de secours est conservée ici : ${archive}` };
  try { await rm(archive); }
  catch { return success(`${newDistro} créée. L’archive temporaire n’a pas pu être supprimée : ${archive}`); }
  return success(`${newDistro} créée.`);
};

const distroPortProbe = 'awk -F= \'/^[[:space:]]*port[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); if ($2 ~ /^[0-9]+$/) {print $2; exit}}\' /etc/xrdp/xrdp.ini 2>/dev/null';

const openDistroTerminal = (distro: string): Promise<WslActionResult> =>
  launchDetached('wt.exe', ['-w', '0', 'new-tab', '--', wslExe, '--distribution', distro]);

export const runWslAction = async (action: WslAction): Promise<WslActionResult> => {
  if (process.platform !== 'win32') return { ok: false, message: 'Cette action nécessite le service OpenChamber sur Windows.' };
  if ('distro' in action && !knownName(action.distro)) return { ok: false, message: 'Nom de distribution invalide.' };
  const run = (args: string[], timeout = 30_000) => runWsl(args, timeout);
  switch (action.action) {
    case 'start': {
      const result = await openDistroTerminal(action.distro);
      return result.ok ? success(`${action.distro} démarrée dans Windows Terminal.`) : result;
    }
    case 'stop': {
      const result = await run(['--terminate', action.distro]);
      return result.ok ? success(`${action.distro} arrêtée.`) : failed(result);
    }
    case 'restart': {
      const stop = await run(['--terminate', action.distro]);
      if (!stop.ok) return failed(stop);
      const start = await openDistroTerminal(action.distro);
      return start.ok ? success(`${action.distro} redémarrée dans Windows Terminal.`) : start;
    }
    case 'set-default': {
      const result = await run(['--set-default', action.distro]);
      return result.ok ? success(`${action.distro} est la distribution par défaut.`) : failed(result);
    }
    case 'set-default-version': {
      const result = await run(['--set-default-version', String(action.version)]);
      return result.ok ? success(`WSL ${action.version} sera la version utilisée pour les nouvelles distributions.`) : failed(result);
    }
    case 'update-wsl': {
      const result = await run(['--update', '--web-download'], 900_000);
      return result.ok ? success('La mise à jour de WSL est terminée. Redémarre WSL si Windows le demande.') : failed(result);
    }
    case 'set-version': {
      const result = await run(['--set-version', action.distro, String(action.version)], 600_000);
      return result.ok ? success(`${action.distro} convertie en WSL ${action.version}.`) : failed(result);
    }
    case 'set-default-user': {
      const target = ['--distribution', action.distro, '--user', 'root', '--exec'];
      const userCheck = await run([...target, 'id', '-u', action.username]);
      if (!userCheck.ok) return failed(userCheck);
      const readConfig = await run([...target, 'sh', '-c', 'if [ -f /etc/wsl.conf ]; then cat /etc/wsl.conf; fi']);
      if (!readConfig.ok) return failed(readConfig);
      if (Buffer.byteLength(readConfig.stdout, 'utf8') > 24 * 1024) {
        return { ok: false, message: '/etc/wsl.conf dépasse la taille prise en charge (24 Ko).' };
      }
      const encodedConfig = Buffer.from(withDefaultWslUser(readConfig.stdout, action.username), 'utf8').toString('base64');
      const writeConfig = `set -eu
temporary="$(mktemp /etc/wsl.conf.XXXXXX)"
trap 'rm -f "$temporary"' EXIT
printf '%s' "$1" | base64 -d > "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" /etc/wsl.conf
trap - EXIT`;
      const result = await run([...target, 'sh', '-c', writeConfig, 'sh', encodedConfig]);
      return result.ok ? success(`Utilisateur par défaut configuré pour ${action.distro}. Redémarre la distribution pour appliquer le changement.`) : failed(result);
    }
    case 'install': {
      const result = await run(['--install', '--distribution', action.distro, '--no-launch'], 900_000);
      return result.ok ? success(`${action.distro} installée.`) : failed(result);
    }
    case 'export': {
      if (await pathExists(action.file)) return { ok: false, message: 'Le fichier cible existe déjà. Choisis un nouveau chemin pour ne pas l’écraser.' };
      const result = await run(['--export', action.distro, action.file], 900_000);
      return result.ok ? success(`Archive exportée vers ${action.file}.`) : failed(result);
    }
    case 'import': {
      if (await pathExists(action.location)) return { ok: false, message: 'Le dossier d’installation existe déjà. Choisis un nouveau dossier vide.' };
      const source = await lstat(action.file).then((stat) => stat.isFile()).catch(() => false);
      if (!source) return { ok: false, message: 'L’archive d’import est introuvable ou n’est pas un fichier.' };
      const result = await run(['--import', action.distro, action.location, action.file, '--version', String(action.version)], 900_000);
      return result.ok ? success(`${action.distro} importée.`) : failed(result);
    }
    case 'clone': {
      if (!knownName(action.newDistro)) return { ok: false, message: 'Nom de la nouvelle distribution invalide.' };
      const copied = await createWslCopy(action.distro, action.newDistro, action.location, action.version);
      return copied.ok ? success(`${action.distro} clonée sous ${action.newDistro}.`) : copied;
    }
    case 'rename': {
      if (!knownName(action.newDistro) || action.newDistro.toLocaleLowerCase() === action.distro.toLocaleLowerCase()) {
        return { ok: false, message: 'Le nouveau nom de distribution est invalide ou identique à l’ancien.' };
      }
      const copied = await createWslCopy(action.distro, action.newDistro, action.location, action.version);
      if (!copied.ok) return copied;
      const unregister = await run(['--unregister', action.distro], 120_000);
      if (!unregister.ok) {
        return { ok: false, message: `${action.newDistro} a été créée, mais ${action.distro} n’a pas pu être désinscrite. Les deux distributions restent disponibles. ${unregister.error}` };
      }
      return success(`${action.distro} renommée en ${action.newDistro}.`);
    }
    case 'move': {
      if (await pathExists(action.location)) return { ok: false, message: 'Le dossier de destination existe déjà. Choisis un nouveau dossier.' };
      const result = await run(['--manage', action.distro, '--move', action.location], 900_000);
      return result.ok ? success(`${action.distro} déplacée.`) : failed(result);
    }
    case 'resize': {
      const shutdown = await run(['--shutdown'], 120_000);
      if (!shutdown.ok) return failed(shutdown);
      const result = await run(['--manage', action.distro, '--resize', action.size], 600_000);
      return result.ok ? success(`${action.distro} redimensionnée. Les distributions WSL ont été arrêtées.`) : failed(result);
    }
    case 'compact': {
      const trim = await run(['--distribution', action.distro, '--user', 'root', '--exec', 'fstrim', '-av'], 120_000);
      if (!trim.ok) return { ok: false, message: `Impossible de libérer les blocs inutilisés avant la compaction : ${trim.error}` };
      const shutdown = await run(['--shutdown'], 120_000);
      if (!shutdown.ok) return failed(shutdown);
      const result = await run(['--manage', action.distro, '--compact'], 600_000);
      return result.ok ? success(`${action.distro} compactée. Les distributions WSL ont été arrêtées.`) : failed(result);
    }
    case 'set-sparse': {
      const result = await run(['--manage', action.distro, '--set-sparse', String(action.enabled)]);
      return result.ok ? success(`Mode sparse ${action.enabled ? 'activé' : 'désactivé'} pour ${action.distro}.`) : failed(result);
    }
    case 'shutdown': {
      const result = await run(['--shutdown'], 120_000);
      return result.ok ? success('Toutes les distributions WSL ont été arrêtées.') : failed(result);
    }
    case 'force-shutdown': {
      const result = await run(['--shutdown', '--force'], 120_000);
      return result.ok ? success('Arrêt forcé de WSL terminé.') : failed(result);
    }
    case 'unregister': {
      const result = await run(['--unregister', action.distro], 120_000);
      return result.ok ? success(`${action.distro} désinscrite et données de distribution supprimées.`) : failed(result);
    }
    case 'open-terminal':
      return openDistroTerminal(action.distro);
    case 'open-files':
      return launchDetached(join(root, 'explorer.exe'), [`\\\\wsl.localhost\\${action.distro}\\`]);
    case 'open-vscode':
      return launchDetached('code.exe', ['--remote', `wsl+${action.distro}`, '/home']);
    case 'open-rdp': {
      const portResult = await run(['--distribution', action.distro, '--exec', 'sh', '-c', distroPortProbe], 10_000);
      if (!portResult.ok) return failed(portResult);
      const port = Number(portResult.stdout.trim().split('\n').at(-1));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return { ok: false, message: 'Aucun port xrdp valide n’a été détecté dans /etc/xrdp/xrdp.ini.' };
      }
      return launchDetached(join(root, 'System32', 'mstsc.exe'), ['/v:localhost:' + port]);
    }
  }
};
