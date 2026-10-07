import { unavailable, type NetworkStats, type Platform, type Unavailable } from '../../shared/stats.ts';
import { readText, run } from './exec.ts';
import { parseDarwinDefaultRoute, parseDarwinNetstat, parseDefaultRoute, parseProcNetDev, parseWindowsNetwork } from './parse-network.ts';
import { runPowerShell } from './windows.ts';

const WINDOWS_NETWORK = `
$ErrorActionPreference = 'SilentlyContinue'
$defaultRoute = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
$defaultIndex = if ($defaultRoute) { $defaultRoute.InterfaceIndex } else { $null }
@(Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object {
  $stats = $_ | Get-NetAdapterStatistics
  $isDefault = $null
  if ($null -ne $defaultIndex) { $isDefault = $_.ifIndex -eq $defaultIndex }
  [pscustomobject]@{ Name = $_.Name; ReceivedBytes = $stats.ReceivedBytes; SentBytes = $stats.SentBytes; Default = $isDefault; LinkSpeed = $_.LinkSpeed }
}) | ConvertTo-Json -Compress
`;

const activeLinuxInterfaces = async (interfaces: ReturnType<typeof parseProcNetDev>) => Promise.all(
  interfaces.map(async (item) => {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(item.name)) return null;
    const [state, speed] = await Promise.all([
      readText(`/sys/class/net/${item.name}/operstate`),
      readText(`/sys/class/net/${item.name}/speed`),
    ]);
    if (state?.trim() === 'down') return null;
    const mbps = speed?.trim() ? Number(speed.trim()) : NaN;
    return { ...item, linkSpeedBps: Number.isFinite(mbps) && mbps > 0 ? mbps * 1_000_000 : null };
  }),
);

export const readNetwork = async (platform: Platform, now: number): Promise<NetworkStats | Unavailable> => {
  let interfaces;
  if (platform === 'linux') {
    const [dev, route] = await Promise.all([readText('/proc/net/dev'), readText('/proc/net/route')]);
    if (dev === null) return unavailable('failed');
    interfaces = (await activeLinuxInterfaces(parseProcNetDev(dev, route === null ? null : parseDefaultRoute(route))))
      .filter((item): item is NonNullable<typeof item> => item !== null);
  } else if (platform === 'darwin') {
    const [result, route] = await Promise.all([
      run(['/usr/sbin/netstat', '/usr/bin/netstat', 'netstat'], ['-ibn']),
      run(['/sbin/route', '/usr/sbin/route', 'route'], ['-n', 'get', 'default']),
    ]);
    if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'netstat');
    interfaces = parseDarwinNetstat(result.stdout);
    const defaultInterface = route.ok ? parseDarwinDefaultRoute(route.stdout) : null;
    if (defaultInterface) interfaces = interfaces.map((item) => ({ ...item, isDefault: item.name === defaultInterface }));
  } else if (platform === 'win32') {
    const result = await runPowerShell(WINDOWS_NETWORK, 8_000);
    if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'powershell');
    interfaces = parseWindowsNetwork(result.stdout);
    if (interfaces === null) return unavailable('failed');
  } else return unavailable('unsupported');

  return interfaces.length === 0
    ? unavailable('no-device')
    : { status: 'ok', interfaces, sampledAt: now };
};
