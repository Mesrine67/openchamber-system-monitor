import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { cpuUsage, limitedCpuUsage, parseCfsQuota, parseCpuMax, parseCpuStatUsage } from '../src/service/collectors/parse-cpu.ts';
import { darwinDisks, linuxDisks, parseDf, parseWindowsDisks } from '../src/service/collectors/parse-disks.ts';
import { parseAmdCards, parseIoreg, parseNvidiaSmi, parseWindowsGpu } from '../src/service/collectors/parse-gpu.ts';
import { parseCgroupMemory, parseMeminfo, parseSwapUsage, parseVmStat } from '../src/service/collectors/parse-memory.ts';
import { powerShellEnv } from '../src/service/collectors/windows.ts';
import { looksLikeContainer } from '../src/service/env.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const KIB = 1024;
const MIB = 1024 * 1024;

describe('memory', () => {
  test('vm_stat counts app + wired + compressed like Activity Monitor', () => {
    // anonymous 639921 − purgeable 22359 + wired 209310 + compressor 295637, 16 KiB pages
    expect(parseVmStat(fixture('darwin-vm_stat.txt'))).toBe((639921 - 22359 + 209310 + 295637) * 16384);
  });

  test('vm_stat without the needed lines is unknown, not 0', () => {
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1.\n')).toBeNull();
    expect(parseVmStat('')).toBeNull();
  });

  test('sysctl vm.swapusage', () => {
    expect(parseSwapUsage(fixture('darwin-swapusage.txt'))).toEqual({ total: 1024 * MIB, used: Math.round(0.75 * MIB) });
    expect(parseSwapUsage('total = 2.00G  used = 512.00M  free = 1.50G')).toEqual({ total: 2 * 1024 * MIB, used: 512 * MIB });
    expect(parseSwapUsage('garbage')).toBeNull();
  });

  test('/proc/meminfo uses MemAvailable', () => {
    expect(parseMeminfo(fixture('linux-meminfo.txt'))).toEqual({
      total: 65616748 * KIB,
      available: 46351904 * KIB,
      swapTotal: 33520636 * KIB,
      swapFree: 26849020 * KIB,
    });
    expect(parseMeminfo('MemTotal: 1 kB')).toBeNull();
  });

  test('cgroup memory subtracts inactive page cache, like docker stats', () => {
    expect(parseCgroupMemory({ limit: '536870912\n', usage: '970752\n', stat: 'anon 151552\ninactive_file 4096\nactive_file 1\n' }))
      .toEqual({ used: 970752 - 4096, total: 536870912 });
    expect(parseCgroupMemory({ limit: '536870912', usage: '1000', stat: 'total_inactive_file 10\n' }))
      .toEqual({ used: 990, total: 536870912 });
  });

  test('cgroup memory without a limit falls back to the machine', () => {
    expect(parseCgroupMemory({ limit: 'max\n', usage: '1000', stat: null })).toBeNull();
    expect(parseCgroupMemory({ limit: '9223372036854771712', usage: '1000', stat: null })).toBeNull();
    expect(parseCgroupMemory({ limit: null, usage: '1000', stat: null })).toBeNull();
  });
});

describe('cpu', () => {
  const core = (busy: number, idle: number) => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 });

  test('usage per core and overall', () => {
    const usage = cpuUsage([core(0, 0), core(0, 0)], [core(50, 50), core(100, 0)]);
    expect(usage).toEqual({ total: 75, perCore: [50, 100] });
  });

  test('no baseline or changed core count is unknown', () => {
    expect(cpuUsage([], [core(1, 1)])).toBeNull();
    expect(cpuUsage([core(0, 0)], [core(1, 1), core(1, 1)])).toBeNull();
    expect(cpuUsage([core(5, 5)], [core(5, 5)])).toBeNull();
  });

  test('cgroup v2 cpu.max', () => {
    expect(parseCpuMax('150000 100000\n')).toBe(1.5);
    expect(parseCpuMax('max 100000\n')).toBeNull();
    expect(parseCpuMax(null)).toBeNull();
  });

  test('cgroup v1 quota', () => {
    expect(parseCfsQuota('200000\n', '100000\n')).toBe(2);
    expect(parseCfsQuota('-1', '100000')).toBeNull();
  });

  test('cpu.stat usage and share of the limit', () => {
    expect(parseCpuStatUsage('usage_usec 2500000\nuser_usec 1\n')).toBe(2_500_000);
    expect(parseCpuStatUsage('')).toBeNull();
    // 1 s of CPU time in 2 s with a 1-core limit is 50 %.
    expect(limitedCpuUsage(0, 1_000_000, 2000, 1)).toBe(50);
    expect(limitedCpuUsage(0, 9_000_000, 2000, 1)).toBe(100);
    expect(limitedCpuUsage(10, 5, 2000, 1)).toBeNull();
  });

  test('container detection', () => {
    expect(looksLikeContainer({ dockerenv: true, containerenv: false, initCgroup: '0::/' })).toBe(true);
    expect(looksLikeContainer({ dockerenv: false, containerenv: true, initCgroup: null })).toBe(true);
    expect(looksLikeContainer({ dockerenv: false, containerenv: false, initCgroup: '12:cpu:/kubepods/burstable/pod1' })).toBe(true);
    expect(looksLikeContainer({ dockerenv: false, containerenv: false, initCgroup: '0::/init.scope\n' })).toBe(false);
  });
});

describe('gpu', () => {
  test('ioreg on Apple Silicon', () => {
    expect(parseIoreg(fixture('darwin-ioreg-apple-silicon.txt'))).toEqual([
      { name: 'Apple M5 Pro', utilization: 37, memUsed: 989822976, memTotal: null },
    ]);
  });

  test('ioreg without accelerators', () => {
    expect(parseIoreg('')).toEqual([]);
  });

  test('nvidia-smi, including a name with a comma and [N/A]', () => {
    expect(parseNvidiaSmi(fixture('nvidia-smi-two.txt'))).toEqual([
      { name: 'NVIDIA GeForce RTX 4090', utilization: 87, memUsed: 20480 * MIB, memTotal: 24564 * MIB },
      { name: 'NVIDIA RTX A6000, Ada', utilization: null, memUsed: 1024 * MIB, memTotal: 49140 * MIB },
    ]);
    expect(parseNvidiaSmi('')).toEqual([]);
  });

  test('AMD sysfs keeps only AMD cards with a busy counter', () => {
    expect(parseAmdCards([
      { card: 'card0', vendor: '0x1002\n', busy: '42\n', vramUsed: '1048576\n', vramTotal: '8589934592\n' },
      { card: 'card1', vendor: '0x8086\n', busy: null, vramUsed: null, vramTotal: null },
    ])).toEqual([{ name: 'AMD GPU (card0)', utilization: 42, memUsed: 1048576, memTotal: 8589934592 }]);
  });

  test('Windows WMI sums 3D engines per adapter', () => {
    expect(parseWindowsGpu(fixture('windows-gpu.json'))).toEqual([
      { name: 'GPU 1', utilization: 43, memUsed: 2147483648, memTotal: null },
      { name: 'GPU 2', utilization: 0, memUsed: 0, memTotal: null },
    ]);
  });

  test('Windows WMI with one adapter, capped at 100 %', () => {
    const line = JSON.stringify({
      engines: [
        { Name: 'pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D', UtilizationPercentage: '80' },
        { Name: 'pid_2_luid_0x0_0x1_phys_0_eng_0_engtype_3D', UtilizationPercentage: 70 },
      ],
      memory: { Name: 'luid_0x0_0x1_phys_0', DedicatedUsage: 5 },
    });
    expect(parseWindowsGpu(line)).toEqual([{ name: 'GPU', utilization: 100, memUsed: 5, memTotal: null }]);
  });

  test('Windows WMI without GPU classes and broken lines', () => {
    expect(parseWindowsGpu('{"engines":[],"memory":[]}')).toEqual([]);
    expect(parseWindowsGpu('not json')).toBeNull();
  });
});

describe('disks', () => {
  test('macOS folds the APFS container and hides system volumes', () => {
    expect(darwinDisks(parseDf(fixture('darwin-df.txt')))).toEqual([
      { mount: '/', label: null, used: (971298980 - 856829720) * KIB, total: 971298980 * KIB },
    ]);
  });

  test('macOS keeps external volumes, with spaces in the mount', () => {
    const disks = darwinDisks(parseDf(fixture('darwin-df-external.txt')));
    expect(disks.map((disk) => disk.mount)).toEqual(['/', '/Volumes/My Stick']);
    expect(disks[1]).toEqual({ mount: '/Volumes/My Stick', label: 'My Stick', used: 31249344 * KIB, total: 62498688 * KIB });
  });

  test('Linux host: real devices only, percent like df', () => {
    expect(linuxDisks(parseDf(fixture('linux-df.txt')), false)).toEqual([
      { mount: '/', label: null, used: 177670168 * KIB, total: (177670168 + 255988096) * KIB },
      { mount: '/boot', label: null, used: 206200 * KIB, total: (206200 + 753904) * KIB },
    ]);
  });

  test('Linux container: overlay root, no /etc bind mounts or /proc masks', () => {
    expect(linuxDisks(parseDf(fixture('linux-container-df.txt')), true)).toEqual([
      { mount: '/', label: null, used: 177670404 * KIB, total: (177670404 + 255987860) * KIB },
    ]);
  });

  test('Linux container: a bind mount of the same filesystem is not a second disk', () => {
    const text = [
      'Filesystem           1024-blocks    Used Available Capacity Mounted on',
      'overlay              456943168 177672284 255985980  41% /',
      '/dev/md2             456943168 177672284 255985980  41% /app',
      '/dev/sdb1            100 10 90  10% /data',
    ].join('\n');
    expect(linuxDisks(parseDf(text), true).map((disk) => disk.mount)).toEqual(['/', '/data']);
  });

  test('Linux skips loop devices and keeps one mount per device', () => {
    const text = [
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      '/dev/sda1 100 50 50 50% /',
      '/dev/sda1 100 50 50 50% /var/lib/docker',
      '/dev/loop3 10 10 0 100% /snap/core/1',
      '/dev/sdb1 200 20 180 10% /data',
    ].join('\n');
    expect(linuxDisks(parseDf(text), false).map((disk) => disk.mount)).toEqual(['/', '/data']);
  });

  test('Windows: one disk is an object, more are an array', () => {
    expect(parseWindowsDisks(fixture('windows-disks-one.json'))).toEqual([
      { mount: 'C:', label: 'Windows', used: 136363114496 - 40536576000, total: 136363114496 },
    ]);
    const many = parseWindowsDisks(fixture('windows-disks-many.json'));
    expect(many?.map((disk) => [disk.mount, disk.label])).toEqual([['C:', 'Windows'], ['D:', null]]);
    expect(parseWindowsDisks('')).toEqual([]);
    expect(parseWindowsDisks('{oops')).toBeNull();
  });
});

describe('windows environment', () => {
  test('PowerShell gets the system module path when the host dropped it', () => {
    const env = powerShellEnv({ Path: 'C:\\Windows' });
    expect(env.PSModulePath).toEndWith('\\System32\\WindowsPowerShell\\v1.0\\Modules');
    expect(env.Path).toBe('C:\\Windows');
  });

  test('an existing module path is kept, whatever its case', () => {
    const source = { PSMODULEPATH: 'C:\\Mine' };
    expect(powerShellEnv(source)).toBe(source);
  });
});
