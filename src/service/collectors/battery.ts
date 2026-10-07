import { readdir } from 'node:fs/promises';

import { unavailable, type BatteryStats, type Platform, type Unavailable } from '../../shared/stats.ts';
import { readText, run } from './exec.ts';
import { parseDarwinBattery, parseLinuxBattery, parseWindowsBattery } from './parse-battery.ts';
import { runPowerShell } from './windows.ts';

const WINDOWS_BATTERY = `
$ErrorActionPreference = 'Stop'
try {
  $batteries = @(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime, FullChargeCapacity, DesignCapacity)
  if ($batteries.Count -eq 0) { [Console]::Out.WriteLine('[]') }
  else { ConvertTo-Json -InputObject $batteries -Compress }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

const linuxBattery = async (): Promise<BatteryStats | Unavailable> => {
  let devices: string[];
  try { devices = await readdir('/sys/class/power_supply'); }
  catch { return unavailable('failed'); }
  let acOnline: string | null = null;
  const candidates: string[] = [];
  for (const device of devices.slice(0, 64)) {
    const path = `/sys/class/power_supply/${device}`;
    const [type, online] = await Promise.all([readText(`${path}/type`), readText(`${path}/online`)]);
    if (type?.trim() === 'Battery') candidates.push(path);
    if (online?.trim() === '1' || online?.trim() === '0') acOnline = online.trim();
  }
  const path = candidates[0];
  if (!path) return unavailable('no-device');
  const [capacity, status, energyNow, energyFull, energyFullDesign, powerNow] = await Promise.all([
    readText(`${path}/capacity`), readText(`${path}/status`), readText(`${path}/energy_now`),
    readText(`${path}/energy_full`), readText(`${path}/energy_full_design`), readText(`${path}/power_now`),
  ]);
  const result = parseLinuxBattery({ capacity, status, energyNow, energyFull, energyFullDesign, powerNow, acOnline });
  return result ?? unavailable('failed');
};

export const readBattery = async (platform: Platform): Promise<BatteryStats | Unavailable> => {
  if (platform === 'linux') return linuxBattery();
  if (platform === 'darwin') {
    const result = await run(['/usr/bin/pmset', 'pmset'], ['-g', 'batt']);
    if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'pmset');
    return parseDarwinBattery(result.stdout) ?? unavailable('no-device');
  }
  if (platform === 'win32') {
    const result = await runPowerShell(WINDOWS_BATTERY, 8_000);
    if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'powershell');
    const value = parseWindowsBattery(result.stdout);
    const output = result.stdout.trim();
    return value ?? (output === '[]' ? unavailable('no-device') : unavailable('failed'));
  }
  return unavailable('unsupported');
};
