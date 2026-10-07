import { unavailable, type ComputerInfo, type Platform, type Unavailable } from '../../shared/stats.ts';
import { runPowerShell } from './windows.ts';

export const WINDOWS_COMPUTER_INFO = `
$ErrorActionPreference = 'SilentlyContinue'
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$bios = Get-CimInstance Win32_BIOS
$cpu = @(Get-CimInstance Win32_Processor | Select-Object NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed)
$ram = @(Get-CimInstance Win32_PhysicalMemory | Select-Object Speed)
$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion)
$displayVersion = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction SilentlyContinue).DisplayVersion
@{
  manufacturer = $cs.Manufacturer
  model = $cs.Model
  firmware = $bios.SMBIOSBIOSVersion
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
  };
};

export const readComputerInfo = async (platform: Platform): Promise<ComputerInfo | Unavailable> => {
  if (platform !== 'win32') return unavailable('unsupported');
  const result = await runPowerShell(WINDOWS_COMPUTER_INFO, 10_000);
  if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'powershell');
  return parseComputerInfo(result.stdout) ?? unavailable('failed');
};
