import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { parseDarwinBattery, parseLinuxBattery, parseWindowsBattery } from '../src/service/collectors/parse-battery.ts';
import { diskActivityFromDelta, parseProcDiskStats, parseWindowsDiskActivity } from '../src/service/collectors/parse-disk-activity.ts';
import { parseHwmonReading, parseNvidiaTemperatures } from '../src/service/collectors/parse-sensors.ts';
import { parseDarwinDefaultRoute, parseDarwinNetstat, parseDefaultRoute, parseProcNetDev, parseWindowsNetwork, deriveNetworkRates } from '../src/service/collectors/parse-network.ts';
import { parseLinuxProcessMemory, parseLinuxProcessStat, parseLinuxTotalCpuTicks, parsePsProcesses, parseWindowsProcesses } from '../src/service/collectors/parse-processes.ts';
import { evaluateHealth } from '../src/shared/health.ts';
import { DEFAULT_MONITOR_SETTINGS, diskPercent, fullestDisk, normalizeMonitorSettings, unavailable } from '../src/shared/stats.ts';
import { evaluateWarnings } from '../src/service/warnings.ts';
import { parseMemoryPressure } from '../src/service/collectors/parse-memory.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('network parsers', () => {
  test('Linux reads byte counters, filters loopback and resolves an active default route', () => {
    const iface = parseDefaultRoute(fixture('linux-network-route.txt'));
    expect(iface).toBe('eth0');
    expect(parseProcNetDev(fixture('linux-network-dev.txt'), iface)).toEqual([{
      name: 'eth0', receivedBytes: 123456, sentBytes: 654321,
      downloadBytesPerSecond: null, uploadBytesPerSecond: null, isDefault: true, linkSpeedBps: null,
    }]);
    expect(parseDefaultRoute('Iface Destination Gateway Flags\neth0 00000000 00000000 0000')).toBeNull();
  });

  test('Darwin uses the named Ibytes/Obytes columns, not collision counters', () => {
    expect(parseDarwinNetstat(fixture('darwin-netstat.txt'))).toEqual([{
      name: 'en0', receivedBytes: 76543210, sentBytes: 12345678,
      downloadBytesPerSecond: null, uploadBytesPerSecond: null, isDefault: null, linkSpeedBps: null,
    }]);
    expect(parseDarwinDefaultRoute("route to: default\ninterface: en0\n" )).toBe('en0');
  });

  test('Windows preserves the default interface and link speed', () => {
    expect(parseWindowsNetwork(fixture('windows-network.json'))).toEqual([
      { name: 'Ethernet', receivedBytes: 12345, sentBytes: 67890, downloadBytesPerSecond: null, uploadBytesPerSecond: null, isDefault: true, linkSpeedBps: 1_000_000_000 },
      { name: 'Wi-Fi', receivedBytes: 100, sentBytes: 200, downloadBytesPerSecond: null, uploadBytesPerSecond: null, isDefault: false, linkSpeedBps: 866_700_000 },
    ]);
    expect(parseWindowsNetwork('{bad')).toBeNull();
  });

  test('rates require a previous sample and reject counter resets', () => {
    const before = parseWindowsNetwork('[{"Name":"Ethernet","ReceivedBytes":100,"SentBytes":50}]')!;
    const after = parseWindowsNetwork('[{"Name":"Ethernet","ReceivedBytes":300,"SentBytes":150}]')!;
    expect(deriveNetworkRates(after, before, 2_000)[0]).toMatchObject({ downloadBytesPerSecond: 100, uploadBytesPerSecond: 50 });
    const reset = parseWindowsNetwork('[{"Name":"Ethernet","ReceivedBytes":1,"SentBytes":2}]')!;
    expect(deriveNetworkRates(reset, before, 2_000)[0]).toMatchObject({ downloadBytesPerSecond: null, uploadBytesPerSecond: null });
  });
});

describe('process parsers', () => {
  test('Linux handles parentheses in the process name and parses RSS', () => {
    const fields = Array.from({ length: 40 }, () => '0');
    fields[10] = '12'; fields[11] = '3';
    expect(parseLinuxProcessStat(`42 (worker (child)) R ${fields.join(' ')}`)).toEqual({ pid: 42, name: 'worker (child)', cpuTicks: 15 });
    expect(parseLinuxProcessMemory('VmRSS: 1024 kB\n')).toBe(1024 * 1024);
    expect(parseLinuxTotalCpuTicks('cpu  1 2 3 4 5 6 7 8')).toBe(36);
  });

  test('Windows IDProcess casing is accepted and private memory is kept', () => {
    expect(parseWindowsProcesses(fixture('windows-processes.json'))).toEqual([
      { pid: 55, name: 'browser', cpuPercent: 320, memoryBytes: 104857600 },
      { pid: 99, name: 'service', cpuPercent: 40, memoryBytes: 52428800 },
    ]);
  });

  test('macOS ps output parses CPU and resident memory', () => {
    expect(parsePsProcesses('  123 /Applications/Editor.app/Contents/MacOS/Editor  12.5  204800\n')).toEqual([
      { pid: 123, name: 'Editor', cpuPercent: 12.5, memoryBytes: 204800 * 1024 },
    ]);
  });
});

describe('disk activity', () => {
  test('Linux diskstats counters become rates only after a baseline sample', () => {
    const first = parseProcDiskStats(fixture('linux-diskstats.txt'));
    expect(diskActivityFromDelta(first, null, 0).every((item) => item.readBytesPerSecond === null)).toBe(true);
    const second = parseProcDiskStats('259 0 nvme0n1 1010 0 20100 60 910 0 18100 70 0 140 130');
    expect(diskActivityFromDelta(second, first, 2_000)[0]).toMatchObject({
      device: 'nvme0n1', readBytesPerSecond: 25_600, writeBytesPerSecond: 25_600,
      readIops: 5, writeIops: 5, activePercent: 1,
    });
  });

  test('Windows disk performance counters are parsed by drive letter', () => {
    const rows = parseWindowsDiskActivity('[{"Name":"C:","DiskReadBytesPersec":1024,"DiskWriteBytesPersec":2048,"DiskReadsPersec":2,"DiskWritesPersec":3,"PercentDiskTime":5,"AvgDisksecPerRead":0.01,"AvgDisksecPerWrite":0.02},{"Name":"_Total","DiskReadBytesPersec":0}]');
    expect(rows).toEqual([{ device: 'C:', readBytesPerSecond: 1024, writeBytesPerSecond: 2048, readIops: 2, writeIops: 3, activePercent: 5, responseMs: 15 }]);
  });
});

describe('battery and temperatures', () => {
  test('Linux only calculates remaining time with a real power reading', () => {
    expect(parseLinuxBattery({ capacity: '75', status: 'Discharging', energyNow: '1800000', energyFull: '2400000', energyFullDesign: '3000000', powerNow: '3600000', acOnline: '0' }))
      .toEqual({ status: 'ok', percent: 75, state: 'discharging', acConnected: false, remainingSeconds: 1800, healthPercent: 80 });
    expect(parseLinuxBattery({ capacity: '75', status: 'Discharging', energyNow: '1800000', energyFull: null, energyFullDesign: null, powerNow: null, acOnline: null })?.remainingSeconds).toBeNull();
  });

  test('Windows and macOS battery state/time are parsed without inventing health', () => {
    expect(parseWindowsBattery('[{"EstimatedChargeRemaining":62,"BatteryStatus":6,"EstimatedRunTime":120}]')).toMatchObject({ percent: 62, state: 'charging', remainingSeconds: 7200, healthPercent: null });
    expect(parseDarwinBattery(fixture('darwin-battery.txt'))).toMatchObject({ percent: 72, state: 'discharging', acConnected: false, remainingSeconds: 11640 });
    expect(parseDarwinBattery("Now drawing from 'AC Power'\n-InternalBattery-0 100%; charged; (0:00 remaining)")?.state).toBe('full');
  });

  test('sensor parsers reject out-of-range data and preserve named readings', () => {
    expect(parseHwmonReading('k10temp', 'Tctl', '65000\n')).toEqual({ name: 'k10temp Tctl', kind: 'cpu', temperatureC: 65 });
    expect(parseHwmonReading('chip', 'probe', '999999')).toBeNull();
    expect(parseNvidiaTemperatures('NVIDIA RTX, 62\n')).toEqual([{ name: 'NVIDIA RTX GPU', kind: 'gpu', temperatureC: 62 }]);
  });
});

describe('settings and health', () => {
  test('settings are normalized at the service boundary and thresholds remain ordered', () => {
    const value = normalizeMonitorSettings({
      ...DEFAULT_MONITOR_SETTINGS,
      refreshSeconds: 99,
      historyMinutes: 999,
      modules: { network: false, processes: true, battery: false, sensors: true },
      thresholds: { ...DEFAULT_MONITOR_SETTINGS.thresholds, memoryWarning: 99, memoryCritical: 65 },
    });
    expect(value.refreshSeconds).toBe(2);
    expect(value.historyMinutes).toBe(2);
    expect(value.modules).toMatchObject({ network: false, battery: false });
    expect(value.thresholds.memoryWarning).toBeLessThan(value.thresholds.memoryCritical);
  });

  test('health state is shared and invalid zero-capacity disks stay unknown', () => {
    const unavailableSource = unavailable('unsupported');
    const state = evaluateHealth({
      cpu: unavailableSource, memory: unavailableSource, gpus: unavailableSource, disks: unavailableSource,
      network: unavailableSource, processes: unavailableSource, battery: unavailableSource, sensors: unavailableSource, warnings: [],
    });
    expect(state.state).toBe('unavailable');
    expect(diskPercent({ mount: 'C:', label: null, used: 0, total: 0 })).toBeNull();
    expect(fullestDisk({ status: 'ok', items: [{ mount: 'C:', label: null, used: 0, total: 0 }], sampledAt: 1 })).toBeNull();
  });

  test('Linux PSI pressure is unavailable when the kernel omits the file', () => {
    expect(parseMemoryPressure('some avg10=0.25 avg60=0.10 avg300=0.02 total=5')).toBe('low');
    expect(parseMemoryPressure('some avg10=2.5 avg60=1.0 avg300=0.5 total=5')).toBe('medium');
    expect(parseMemoryPressure('')).toBeNull();
  });

  test('alert thresholds and sustained duration follow local settings', () => {
    const settings = normalizeMonitorSettings({ thresholds: { ...DEFAULT_MONITOR_SETTINGS.thresholds, memoryWarning: 70, memoryCritical: 90, sustainedSeconds: 30 } });
    const warnings = evaluateWarnings({
      cpu: { status: 'ok', total: 90, perCore: [], load: null, cores: 1, limitCores: null, model: null },
      memory: { status: 'ok', used: 80, total: 100, swapUsed: null, swapTotal: null },
      disks: { status: 'ok', sampledAt: 0, items: [] },
      cpuHistory: Array.from({ length: 15 }, () => 90), gpuHistory: [],
    }, settings);
    expect(warnings).toEqual([{ kind: 'cpu', target: null, level: 'warn' }, { kind: 'memory', target: null, level: 'warn' }]);
  });
});
