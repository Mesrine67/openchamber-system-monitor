import os from 'node:os';

import { unavailable, type ComputerInfo, type Platform, type Unavailable } from '../../shared/stats.ts';
import { readText, run } from './exec.ts';
import { runPowerShell } from './windows.ts';

export const WINDOWS_COMPUTER_INFO = `
$ErrorActionPreference = 'SilentlyContinue'
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$bios = Get-CimInstance Win32_BIOS
$board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1 Manufacturer, Product
$cpu = @(Get-CimInstance Win32_Processor | Select-Object NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed)
$ram = @(Get-CimInstance Win32_PhysicalMemory | Select-Object Speed)
$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion)
$displayVersion = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction SilentlyContinue).DisplayVersion
@{
  manufacturer = $cs.Manufacturer
  model = $cs.Model
  firmware = $bios.SMBIOSBIOSVersion
  motherboard = if ($board.Manufacturer -or $board.Product) { "$($board.Manufacturer) $($board.Product)".Trim() } else { $null }
  osName = $os.Caption
  osVersion = $os.Version
  osDisplayVersion = $displayVersion
  osBuild = $os.BuildNumber
  displayAdapters = @($gpu | ForEach-Object { if ($_.Name) { if ($_.DriverVersion) { "$($_.Name) · $($_.DriverVersion)" } else { $_.Name } } })
  physicalCores = [int](($cpu | Measure-Object NumberOfCores -Sum).Sum)
  logicalProcessors = [int](($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum)
  cpuMaxMHz = [int](($cpu | Measure-Object MaxClockSpeed -Maximum).Maximum)
  memoryModules = $ram.Count
  memorySpeedMHz = if ($ram.Count -gt 0) { [int](($ram | Measure-Object Speed -Average).Average) } else { $null }
} | ConvertTo-Json -Compress
`;

const numberOrNull = (value: unknown): number | null => {
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() && !/^to be filled by o\.e\.m\.?$/i.test(value.trim())
    ? value.trim()
    : null;

/** Parse the stable hardware/OS details returned by the Windows CIM query. */
export const parseComputerInfo = (text: string): ComputerInfo | null => {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const read = (key: string) => Reflect.get(value, key) as unknown;
  return {
    manufacturer: stringOrNull(read('manufacturer')),
    model: stringOrNull(read('model')),
    firmware: stringOrNull(read('firmware')),
    osName: stringOrNull(read('osName')),
    osVersion: stringOrNull(read('osVersion')),
    osDisplayVersion: stringOrNull(read('osDisplayVersion')),
    osBuild: stringOrNull(read('osBuild')),
    displayAdapters: Array.isArray(read('displayAdapters'))
      ? (read('displayAdapters') as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [],
    physicalCores: numberOrNull(read('physicalCores')),
    logicalProcessors: numberOrNull(read('logicalProcessors')),
    cpuMaxMHz: numberOrNull(read('cpuMaxMHz')),
    memoryModules: numberOrNull(read('memoryModules')),
    memorySpeedMHz: numberOrNull(read('memorySpeedMHz')),
    motherboard: stringOrNull(read('motherboard')),
  };
};

const parseReleaseFile = (text: string): Record<string, string> => Object.fromEntries(
  text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) return [];
    return [[match[1], match[2].replace(/^"|"$/g, '')]];
  }),
);

const readLinuxInfo = async (): Promise<ComputerInfo> => {
  const [dmi, release, cpuInfo, maxFrequency] = await Promise.all([
    Promise.all(['sys_vendor', 'product_name', 'bios_version', 'board_vendor', 'board_name'].map((name) => readText(`/sys/class/dmi/id/${name}`))),
    readText('/etc/os-release'), readText('/proc/cpuinfo'), readText('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq'),
  ]);
  const [manufacturer, model, firmware, boardVendor, boardName] = dmi;
  const coreIds = new Set<string>();
  for (const block of (cpuInfo ?? '').split(/\n\s*\n/)) {
    const physical = /^physical id\s*:\s*(\S+)/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\S+)/m.exec(block)?.[1];
    if (physical && core) coreIds.add(`${physical}:${core}`);
  }
  const frequencyKHz = Number(maxFrequency?.trim());
  const osRelease = parseReleaseFile(release ?? '');
  const displayAdapters: string[] = [];
  return {
    manufacturer: stringOrNull(manufacturer), model: stringOrNull(model), firmware: stringOrNull(firmware),
    osName: osRelease.NAME || 'Linux', osVersion: os.release(), osDisplayVersion: osRelease.PRETTY_NAME || null,
    osBuild: os.release() || null, displayAdapters,
    physicalCores: coreIds.size || null,
    logicalProcessors: os.cpus().length || null,
    cpuMaxMHz: Number.isFinite(frequencyKHz) && frequencyKHz > 0 ? Math.round(frequencyKHz / 1000) : null,
    memoryModules: null, memorySpeedMHz: null,
    motherboard: [stringOrNull(boardVendor), stringOrNull(boardName)].filter(Boolean).join(' ') || null,
  };
};

const readDarwinInfo = async (): Promise<ComputerInfo | Unavailable> => {
  const [hardware, version, build] = await Promise.all([
    run(['/usr/sbin/sysctl', 'sysctl'], ['-n', 'hw.model', 'hw.physicalcpu', 'hw.logicalcpu', 'hw.cpufrequency_max']),
    run(['/usr/bin/sw_vers', 'sw_vers'], ['-productVersion']),
    run(['/usr/bin/sw_vers', 'sw_vers'], ['-buildVersion']),
  ]);
  if (!hardware.ok) return unavailable(hardware.missing ? 'tool-missing' : 'failed', 'sysctl');
  const values = hardware.stdout.trim().split(/\r?\n/);
  const toNumber = (value: string | undefined): number | null => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  };
  const frequencyHz = toNumber(values[3]);
  return {
    manufacturer: 'Apple', model: values[0]?.trim() || null, firmware: null,
    osName: 'macOS', osVersion: version.ok ? version.stdout.trim() || null : os.release(),
    osDisplayVersion: version.ok ? version.stdout.trim() || null : null,
    osBuild: build.ok ? build.stdout.trim() || null : null,
    displayAdapters: [], physicalCores: toNumber(values[1]), logicalProcessors: toNumber(values[2]),
    cpuMaxMHz: frequencyHz === null ? null : Math.round(frequencyHz / 1_000_000),
    memoryModules: null, memorySpeedMHz: null, motherboard: null,
  };
};

export const readComputerInfo = async (platform: Platform): Promise<ComputerInfo | Unavailable> => {
  if (platform === 'linux') return readLinuxInfo();
  if (platform === 'darwin') return readDarwinInfo();
  if (platform === 'win32') {
    const result = await runPowerShell(WINDOWS_COMPUTER_INFO, 10_000);
    if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'powershell');
    return parseComputerInfo(result.stdout) ?? unavailable('failed');
  }
  return unavailable('unsupported');
};
