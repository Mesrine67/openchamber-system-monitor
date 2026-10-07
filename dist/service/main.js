// src/service/main.ts
import http from "node:http";

// src/service/collectors/cpu-mem.ts
import os from "node:os";

// src/shared/stats.ts
var SAMPLE_INTERVAL_MS = 2000;
var HISTORY_LENGTH = 60;
var IDLE_STOP_MS = 30000;
var DISK_INTERVAL_MS = 30000;
var RETRY_UNAVAILABLE_MS = 60000;
var FAILURES_BEFORE_UNAVAILABLE = 3;
var WARN_PERCENT = 90;
var CRITICAL_PERCENT = 95;
var levelForPercent = (percent) => {
  if (percent >= CRITICAL_PERCENT)
    return "critical";
  if (percent >= WARN_PERCENT)
    return "warn";
  return null;
};
var unavailable = (reason, tool = null) => ({
  status: "unavailable",
  reason,
  tool
});
var busiestGpu = (gpus) => {
  if (gpus.status !== "ok")
    return null;
  let busiest = null;
  for (const device of gpus.devices) {
    if (device.utilization !== null && (busiest === null || device.utilization > busiest))
      busiest = device.utilization;
  }
  return busiest;
};
var diskPercent = (disk) => disk.total > 0 ? disk.used / disk.total * 100 : 0;

// src/service/collectors/exec.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
var EXEC_TIMEOUT_MS = 3000;
var run = async (commands, args, timeout = EXEC_TIMEOUT_MS, env = process.env) => {
  for (const command of commands) {
    const result = await new Promise((resolve) => {
      execFile(command, args, { timeout, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (!error) {
          resolve({ ok: true, stdout });
          return;
        }
        resolve({ ok: false, missing: "code" in error && error.code === "ENOENT" });
      });
    });
    if (result.ok || !result.missing)
      return result;
  }
  return { ok: false, missing: true };
};
var readText = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

// src/service/collectors/parse-memory.ts
var KIB = 1024;
var MIB = 1024 * 1024;
var field = (text, pattern) => {
  const match = pattern.exec(text);
  if (!match?.[1])
    return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};
var parseVmStat = (text) => {
  const pageSize = field(text, /page size of (\d+) bytes/);
  const anonymous = field(text, /^Anonymous pages:\s+(\d+)\./m);
  const purgeable = field(text, /^Pages purgeable:\s+(\d+)\./m);
  const wired = field(text, /^Pages wired down:\s+(\d+)\./m);
  const compressed = field(text, /^Pages occupied by compressor:\s+(\d+)\./m);
  if (pageSize === null || anonymous === null || wired === null || compressed === null)
    return null;
  const app = Math.max(0, anonymous - (purgeable ?? 0));
  return (app + wired + compressed) * pageSize;
};
var SWAP_UNITS = { K: KIB, M: MIB, G: MIB * 1024 };
var parseSwapUsage = (text) => {
  const read = (name) => {
    const match = new RegExp(`${name} = ([\\d.]+)([KMG])`).exec(text);
    if (!match?.[1] || !match[2])
      return null;
    const unit = SWAP_UNITS[match[2]];
    const value = Number(match[1]);
    return unit && Number.isFinite(value) ? Math.round(value * unit) : null;
  };
  const total = read("total");
  const used = read("used");
  return total === null || used === null ? null : { used, total };
};
var parseWindowsPageFile = (text) => {
  let value;
  try {
    value = JSON.parse(text.trim() || "null");
  } catch {
    return null;
  }
  const rows = Array.isArray(value) ? value : value === null ? [] : [value];
  let total = 0;
  let used = 0;
  for (const row of rows) {
    if (typeof row !== "object" || row === null)
      continue;
    const allocated = Number(Reflect.get(row, "AllocatedBaseSize"));
    const current = Number(Reflect.get(row, "CurrentUsage"));
    if (!Number.isFinite(allocated) || !Number.isFinite(current) || allocated < 0 || current < 0)
      continue;
    total += allocated * MIB;
    used += current * MIB;
  }
  return total > 0 ? { total, used: Math.min(used, total) } : null;
};
var parseMeminfo = (text) => {
  const read = (name) => field(text, new RegExp(`^${name}:\\s+(\\d+) kB`, "m"));
  const total = read("MemTotal");
  const available = read("MemAvailable");
  if (total === null || available === null)
    return null;
  return {
    total: total * KIB,
    available: available * KIB,
    swapTotal: (read("SwapTotal") ?? 0) * KIB,
    swapFree: (read("SwapFree") ?? 0) * KIB
  };
};
var parseCgroupMemory = (input) => {
  const limitText = input.limit?.trim();
  const usageText = input.usage?.trim();
  if (!limitText || !usageText || limitText === "max")
    return null;
  const limit = Number(limitText);
  const usage = Number(usageText);
  if (!Number.isFinite(limit) || !Number.isFinite(usage) || limit <= 0 || limit >= 2 ** 60)
    return null;
  const inactive = input.stat ? field(input.stat, /^(?:total_)?inactive_file (\d+)$/m) ?? 0 : 0;
  return { used: Math.max(0, usage - inactive), total: limit };
};

// src/service/collectors/windows.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
var systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
var POWERSHELL = [`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, "powershell.exe"];
var NVIDIA_SMI_WIN32 = ["nvidia-smi.exe", `${systemRoot}\\System32\\nvidia-smi.exe`];
var POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
var powerShellEnv = (source = process.env) => {
  const hasModulePath = Object.keys(source).some((name) => name.toUpperCase() === "PSMODULEPATH");
  return hasModulePath ? source : { ...source, PSModulePath: "" };
};
var runPowerShell = (script, timeout) => run(POWERSHELL, [...POWERSHELL_ARGS, script], timeout, powerShellEnv());
var gpuLoopScript = (parentPid) => `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { exit }
  $e = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Filter "Name LIKE '%engtype_3D'" | Select-Object Name, UtilizationPercentage)
  $m = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name, DedicatedUsage, DedicatedLimit, SharedUsage, SharedLimit)
  [Console]::Out.WriteLine((@{ engines = $e; memory = $m } | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 2
}
`;
var createGpuLoop = () => {
  let child = null;
  let line = null;
  let missing = false;
  let waiters = [];
  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending)
      resolve();
  };
  const start = (candidates) => {
    const [command, ...rest] = candidates;
    if (!command) {
      missing = true;
      wake();
      return;
    }
    const proc = spawn(command, [...POWERSHELL_ARGS, gpuLoopScript(process.pid)], {
      env: powerShellEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    child = proc;
    proc.once("error", (error) => {
      if (child !== proc)
        return;
      child = null;
      if ("code" in error && error.code === "ENOENT")
        start(rest);
      else
        wake();
    });
    proc.once("exit", () => {
      if (child === proc)
        child = null;
      wake();
    });
    if (proc.stdout) {
      createInterface({ input: proc.stdout }).on("line", (next) => {
        if (!next.trim().startsWith("{"))
          return;
        line = next;
        wake();
      });
    }
  };
  return {
    latest: async (waitMs) => {
      if (missing)
        return { missing: true };
      if (!child) {
        line = null;
        start(POWERSHELL);
      }
      if (line === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== done);
            resolve();
          }, waitMs);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          waiters.push(done);
        });
      }
      if (missing)
        return { missing: true };
      return line === null ? { missing: false } : { line };
    },
    stop: () => {
      const proc = child;
      child = null;
      line = null;
      proc?.kill();
    }
  };
};

// src/service/collectors/parse-cpu.ts
var clampPercent = (value) => Math.min(100, Math.max(0, value));
var cpuUsage = (previous, next) => {
  if (previous.length === 0 || previous.length !== next.length)
    return null;
  let busyAll = 0;
  let totalAll = 0;
  const perCore = [];
  for (let index = 0;index < next.length; index++) {
    const before = previous[index];
    const after = next[index];
    if (!before || !after)
      return null;
    const busy = after.user - before.user + (after.nice - before.nice) + (after.sys - before.sys) + (after.irq - before.irq);
    const total = busy + (after.idle - before.idle);
    busyAll += busy;
    totalAll += total;
    perCore.push(total > 0 ? clampPercent(busy / total * 100) : 0);
  }
  if (totalAll <= 0)
    return null;
  return { total: clampPercent(busyAll / totalAll * 100), perCore };
};
var parseCpuMax = (text) => {
  const [quota, period] = (text ?? "").trim().split(/\s+/);
  if (!quota || !period || quota === "max")
    return null;
  const cores = Number(quota) / Number(period);
  return Number.isFinite(cores) && cores > 0 ? cores : null;
};
var parseCfsQuota = (quota, period) => {
  const quotaValue = Number((quota ?? "").trim());
  const periodValue = Number((period ?? "").trim());
  if (!Number.isFinite(quotaValue) || !Number.isFinite(periodValue) || quotaValue <= 0 || periodValue <= 0)
    return null;
  return quotaValue / periodValue;
};
var parseCpuStatUsage = (text) => {
  const match = /^usage_usec (\d+)$/m.exec(text ?? "");
  return match?.[1] ? Number(match[1]) : null;
};
var limitedCpuUsage = (previousUsec, nextUsec, elapsedMs, limitCores) => {
  if (elapsedMs <= 0 || limitCores <= 0 || nextUsec < previousUsec)
    return null;
  const usedMs = (nextUsec - previousUsec) / 1000;
  return clampPercent(usedMs / (elapsedMs * limitCores) * 100);
};

// src/service/collectors/cpu-mem.ts
var CGROUP = "/sys/fs/cgroup";
var SWAP_INTERVAL_MS = 1e4;
var WINDOWS_PAGEFILE_QUERY = "Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize, CurrentUsage | ConvertTo-Json -Compress";
var coreTimes = () => os.cpus().map((cpu) => cpu.times);
var readCgroupCpu = async () => {
  const v2Limit = await readText(`${CGROUP}/cpu.max`);
  if (v2Limit !== null) {
    return { limitCores: parseCpuMax(v2Limit), usageUsec: parseCpuStatUsage(await readText(`${CGROUP}/cpu.stat`)) };
  }
  for (const dir of ["cpu,cpuacct", "cpu"]) {
    const quota = await readText(`${CGROUP}/${dir}/cpu.cfs_quota_us`);
    if (quota === null)
      continue;
    const limitCores = parseCfsQuota(quota, await readText(`${CGROUP}/${dir}/cpu.cfs_period_us`));
    const usageNs = Number((await readText(`${CGROUP}/${dir}/cpuacct.usage`) ?? await readText(`${CGROUP}/cpuacct/cpuacct.usage`) ?? "").trim());
    return { limitCores, usageUsec: Number.isFinite(usageNs) && usageNs > 0 ? usageNs / 1000 : null };
  }
  return { limitCores: null, usageUsec: null };
};
var readCgroupMemory = async () => {
  const v2 = parseCgroupMemory({
    limit: await readText(`${CGROUP}/memory.max`),
    usage: await readText(`${CGROUP}/memory.current`),
    stat: await readText(`${CGROUP}/memory.stat`)
  });
  if (v2)
    return v2;
  return parseCgroupMemory({
    limit: await readText(`${CGROUP}/memory/memory.limit_in_bytes`),
    usage: await readText(`${CGROUP}/memory/memory.usage_in_bytes`),
    stat: await readText(`${CGROUP}/memory/memory.stat`)
  });
};
var createCpuMemCollector = (platform, container, now) => {
  let previousTimes = [];
  let previousCgroup = null;
  let swap = null;
  let windowsPageFile = null;
  const readSwap = async () => {
    const at = now();
    if (swap && at - swap.at < SWAP_INTERVAL_MS)
      return swap.value;
    const result = await run(["/usr/sbin/sysctl", "sysctl"], ["vm.swapusage"]);
    swap = { value: result.ok ? parseSwapUsage(result.stdout) : null, at };
    return swap.value;
  };
  const readWindowsPageFile = async () => {
    const at = now();
    if (windowsPageFile && at - windowsPageFile.at < SWAP_INTERVAL_MS)
      return windowsPageFile.value;
    const result = await runPowerShell(WINDOWS_PAGEFILE_QUERY, 5000);
    const value = result.ok ? parseWindowsPageFile(result.stdout) : null;
    windowsPageFile = { value, at };
    return value;
  };
  const readCgroupBaseline = async () => {
    if (!container)
      return;
    const { usageUsec } = await readCgroupCpu();
    previousCgroup = usageUsec === null ? null : { usageUsec, at: now() };
  };
  return {
    prime: async () => {
      previousTimes = coreTimes();
      await readCgroupBaseline();
    },
    cpu: async () => {
      const times = coreTimes();
      const host = cpuUsage(previousTimes, times);
      previousTimes = times;
      const load = platform === "win32" ? null : os.loadavg();
      const base = {
        cores: times.length,
        model: os.cpus()[0]?.model.trim() || null,
        load: load ? [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0] : null
      };
      if (container) {
        const { limitCores, usageUsec } = await readCgroupCpu();
        const before = previousCgroup;
        const at = now();
        previousCgroup = usageUsec === null ? null : { usageUsec, at };
        if (limitCores !== null) {
          const total = before && usageUsec !== null ? limitedCpuUsage(before.usageUsec, usageUsec, at - before.at, limitCores) : null;
          if (total === null)
            return unavailable("failed");
          return { status: "ok", total, perCore: [], limitCores, ...base };
        }
      }
      if (!host)
        return unavailable("failed");
      return { status: "ok", total: host.total, perCore: host.perCore, limitCores: null, ...base };
    },
    memory: async () => {
      if (container) {
        const limited = await readCgroupMemory();
        if (limited)
          return {
            status: "ok",
            used: limited.used,
            total: limited.total,
            available: Math.max(0, limited.total - limited.used),
            swapUsed: null,
            swapTotal: null
          };
      }
      if (platform === "linux") {
        const info = parseMeminfo(await readText("/proc/meminfo") ?? "");
        if (!info)
          return unavailable("failed");
        return {
          status: "ok",
          used: info.total - info.available,
          total: info.total,
          available: info.available,
          swapUsed: info.swapTotal > 0 ? info.swapTotal - info.swapFree : null,
          swapTotal: info.swapTotal > 0 ? info.swapTotal : null
        };
      }
      if (platform === "darwin") {
        const [vm, swapUsage] = await Promise.all([run(["/usr/bin/vm_stat", "vm_stat"], []), readSwap()]);
        if (!vm.ok)
          return unavailable(vm.missing ? "tool-missing" : "failed", "vm_stat");
        const used = parseVmStat(vm.stdout);
        if (used === null)
          return unavailable("failed");
        return {
          status: "ok",
          used,
          total: os.totalmem(),
          available: Math.max(0, os.totalmem() - used),
          swapUsed: swapUsage && swapUsage.total > 0 ? swapUsage.used : null,
          swapTotal: swapUsage && swapUsage.total > 0 ? swapUsage.total : null
        };
      }
      const total = os.totalmem();
      const used = total - os.freemem();
      const pageFile = platform === "win32" ? await readWindowsPageFile() : null;
      return {
        status: "ok",
        used,
        total,
        available: total - used,
        swapUsed: pageFile?.used ?? null,
        swapTotal: pageFile?.total ?? null
      };
    }
  };
};

// src/service/collectors/computer.ts
var WINDOWS_COMPUTER_INFO = `
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
var numberOrNull = (value) => {
  const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
};
var stringOrNull = (value) => typeof value === "string" && value.trim() && !/^to be filled by o\.e\.m\.?$/i.test(value.trim()) ? value.trim() : null;
var parseComputerInfo = (text) => {
  let value;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const read = (key) => Reflect.get(value, key);
  return {
    manufacturer: stringOrNull(read("manufacturer")),
    model: stringOrNull(read("model")),
    firmware: stringOrNull(read("firmware")),
    osName: stringOrNull(read("osName")),
    osVersion: stringOrNull(read("osVersion")),
    osDisplayVersion: stringOrNull(read("osDisplayVersion")),
    osBuild: stringOrNull(read("osBuild")),
    displayAdapters: Array.isArray(read("displayAdapters")) ? read("displayAdapters").filter((item) => typeof item === "string" && item.trim().length > 0) : [],
    physicalCores: numberOrNull(read("physicalCores")),
    logicalProcessors: numberOrNull(read("logicalProcessors")),
    cpuMaxMHz: numberOrNull(read("cpuMaxMHz")),
    memoryModules: numberOrNull(read("memoryModules")),
    memorySpeedMHz: numberOrNull(read("memorySpeedMHz"))
  };
};
var readComputerInfo = async (platform) => {
  if (platform !== "win32")
    return unavailable("unsupported");
  const result = await runPowerShell(WINDOWS_COMPUTER_INFO, 1e4);
  if (!result.ok)
    return unavailable(result.missing ? "tool-missing" : "failed", "powershell");
  return parseComputerInfo(result.stdout) ?? unavailable("failed");
};

// src/service/collectors/parse-disks.ts
var KIB2 = 1024;
var parseDf = (text) => {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[5])
      continue;
    rows.push({
      filesystem: match[1],
      size: Number(match[2]) * KIB2,
      used: Number(match[3]) * KIB2,
      available: Number(match[4]) * KIB2,
      mount: match[5]
    });
  }
  return rows;
};
var DARWIN_HIDDEN = /^\/(System\/Volumes\/(?!Data$)|Volumes\/Recovery$|private\/var\/vm$|Library\/Developer\/CoreSimulator\/)/;
var darwinDisks = (rows) => {
  const containers = new Map;
  for (const row of rows) {
    if (!row.filesystem.startsWith("/dev/") || DARWIN_HIDDEN.test(row.mount) || row.size <= 0)
      continue;
    const key = `${row.size}:${row.available}`;
    const entry = containers.get(key) ?? { mounts: [], size: row.size, available: row.available };
    entry.mounts.push(row.mount);
    containers.set(key, entry);
  }
  return [...containers.values()].map((entry) => {
    const mount = entry.mounts.includes("/") ? "/" : entry.mounts.sort((a, b) => a.length - b.length)[0] ?? "/";
    const label = mount.startsWith("/Volumes/") ? mount.slice("/Volumes/".length) || null : null;
    return { mount, label, used: entry.size - entry.available, total: entry.size };
  }).sort(byMount);
};
var LINUX_HIDDEN_MOUNT = /^\/(proc|sys|dev|run|snap)(\/|$)|^\/etc\//;
var linuxDisks = (rows, container) => {
  const byDevice = new Map;
  for (const row of rows) {
    const real = row.filesystem.startsWith("/dev/") && !row.filesystem.startsWith("/dev/loop");
    const containerRoot = container && row.mount === "/";
    if (!(real || containerRoot) || LINUX_HIDDEN_MOUNT.test(row.mount) || row.size <= 0)
      continue;
    const existing = byDevice.get(row.filesystem);
    if (!existing || row.mount.length < existing.mount.length)
      byDevice.set(row.filesystem, row);
  }
  const byFigures = new Map;
  for (const row of byDevice.values()) {
    const key = `${row.size}:${row.used}:${row.available}`;
    const existing = byFigures.get(key);
    if (!existing || row.mount === "/" || existing.mount !== "/" && row.mount.length < existing.mount.length) {
      byFigures.set(key, row);
    }
  }
  return [...byFigures.values()].map((row) => ({ mount: row.mount, label: null, used: row.used, total: row.used + row.available })).sort(byMount);
};
var parseWindowsDisks = (text) => {
  let parsed;
  try {
    parsed = JSON.parse(text.trim() || "null");
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
  const disks = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null)
      continue;
    const mount = Reflect.get(row, "DeviceID");
    const label = Reflect.get(row, "VolumeName");
    const size = Number(Reflect.get(row, "Size"));
    const free = Number(Reflect.get(row, "FreeSpace"));
    if (typeof mount !== "string" || !Number.isFinite(size) || !Number.isFinite(free) || size <= 0)
      continue;
    const fileSystem = Reflect.get(row, "FileSystem");
    const driveType = Number(Reflect.get(row, "DriveType"));
    disks.push({
      mount,
      label: typeof label === "string" && label.trim() ? label.trim() : null,
      used: size - free,
      total: size,
      ...typeof fileSystem === "string" && fileSystem.trim() ? { fileSystem: fileSystem.trim() } : {},
      ...driveType === 2 ? { driveType: "removable" } : driveType === 3 ? { driveType: "fixed" } : {}
    });
  }
  return disks.sort(byMount);
};
function byMount(left, right) {
  if (left.mount === "/")
    return -1;
  if (right.mount === "/")
    return 1;
  return left.mount.localeCompare(right.mount);
}

// src/service/collectors/disks.ts
var WINDOWS_DISKS = 'Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3" | Select-Object DeviceID, VolumeName, Size, FreeSpace, FileSystem, DriveType | ConvertTo-Json -Compress';
var WINDOWS_TIMEOUT_MS = 1e4;
var DF = ["/bin/df", "/usr/bin/df", "df"];
var readDf = async () => {
  const local = await run(DF, ["-kPl"]);
  if (local.ok)
    return local;
  const all = await run(DF, ["-kP"]);
  if (all.ok)
    return all;
  return unavailable(all.missing ? "tool-missing" : "failed", "df");
};
var readDisks = async (platform, container) => {
  if (platform === "win32") {
    const result = await runPowerShell(WINDOWS_DISKS, WINDOWS_TIMEOUT_MS);
    if (!result.ok)
      return unavailable(result.missing ? "tool-missing" : "failed", "powershell");
    return parseWindowsDisks(result.stdout) ?? unavailable("failed");
  }
  if (platform === "darwin" || platform === "linux") {
    const df = await readDf();
    if (!("ok" in df))
      return df;
    const rows = parseDf(df.stdout);
    if (rows.length === 0)
      return unavailable("failed");
    return platform === "darwin" ? darwinDisks(rows) : linuxDisks(rows, container);
  }
  return unavailable("unsupported");
};

// src/service/collectors/gpu.ts
import { readdir } from "node:fs/promises";

// src/service/collectors/parse-gpu.ts
var MIB2 = 1024 * 1024;
var percent = (value) => value === null || !Number.isFinite(value) ? null : Math.min(100, Math.max(0, value));
var numberOrNull2 = (text) => {
  if (text === undefined)
    return null;
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) ? value : null;
};
var parseIoreg = (text) => {
  const devices = [];
  for (const block of text.split(/^\+-o /m).slice(1)) {
    const stats = /"PerformanceStatistics" = \{([^}]*)\}/.exec(block)?.[1];
    if (stats === undefined)
      continue;
    const read = (key) => {
      const match = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\%]/g, "\\$&")}"=(\\d+)`).exec(stats);
      return match?.[1] ? Number(match[1]) : null;
    };
    const model = /"model" = (?:"([^"]+)"|<"([^"]+)">)/.exec(block);
    const className = /^(\S+)/.exec(block)?.[1] ?? "GPU";
    devices.push({
      name: model?.[1] ?? model?.[2] ?? className,
      utilization: percent(read("Device Utilization %") ?? read("GPU Activity(%)")),
      memUsed: read("In use system memory") ?? read("vramUsedBytes"),
      memTotal: null
    });
  }
  return devices;
};
var parseNvidiaSmi = (text) => {
  const devices = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim())
      continue;
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 4)
      continue;
    const total = numberOrNull2(parts.pop());
    const used = numberOrNull2(parts.pop());
    const utilization = numberOrNull2(parts.pop());
    devices.push({
      name: parts.join(", ") || "NVIDIA GPU",
      utilization: percent(utilization),
      memUsed: used === null ? null : used * MIB2,
      memTotal: total === null ? null : total * MIB2
    });
  }
  return devices;
};
var parseAmdCards = (cards) => cards.filter((card) => card.vendor?.trim() === "0x1002" && card.busy !== null).map((card) => ({
  name: `AMD GPU (${card.card})`,
  utilization: percent(numberOrNull2(card.busy ?? undefined)),
  memUsed: numberOrNull2(card.vramUsed ?? undefined),
  memTotal: numberOrNull2(card.vramTotal ?? undefined)
}));
var asArray = (value) => {
  if (Array.isArray(value))
    return value;
  return value === null || value === undefined ? [] : [value];
};
var LUID = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i;
var toNumber = (value) => {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : null;
  if (typeof value === "string")
    return numberOrNull2(value);
  return null;
};
var toName = (value) => typeof value === "string" ? value : null;
var parseWindowsGpu = (line) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null)
    return null;
  const record = (value, key) => typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  const luidOf = (value) => LUID.exec(toName(record(value, "Name")) ?? "")?.[1]?.toLowerCase() ?? null;
  const adapters = new Map;
  for (const engine of asArray(record(parsed, "engines"))) {
    const luid = luidOf(engine);
    const value = toNumber(record(engine, "UtilizationPercentage"));
    if (!luid || value === null)
      continue;
    const entry = adapters.get(luid) ?? { utilization: 0, memUsed: null, memBudget: null, sharedMemUsed: null, sharedMemTotal: null };
    entry.utilization += value;
    adapters.set(luid, entry);
  }
  for (const row of asArray(record(parsed, "memory"))) {
    const luid = luidOf(row);
    const value = toNumber(record(row, "DedicatedUsage"));
    const budget = toNumber(record(row, "DedicatedLimit"));
    const sharedUsed = toNumber(record(row, "SharedUsage"));
    const sharedBudget = toNumber(record(row, "SharedLimit"));
    const entry = luid ? adapters.get(luid) : undefined;
    if (!entry)
      continue;
    if (value !== null)
      entry.memUsed = (entry.memUsed ?? 0) + value;
    if (budget !== null)
      entry.memBudget = (entry.memBudget ?? 0) + budget;
    if (sharedUsed !== null)
      entry.sharedMemUsed = (entry.sharedMemUsed ?? 0) + sharedUsed;
    if (sharedBudget !== null)
      entry.sharedMemTotal = (entry.sharedMemTotal ?? 0) + sharedBudget;
  }
  const devices = [...adapters.entries()].sort(([left], [right]) => left.localeCompare(right));
  return devices.map(([, entry], index) => ({
    name: devices.length === 1 ? "GPU" : `GPU ${index + 1}`,
    utilization: percent(entry.utilization),
    memUsed: entry.memUsed,
    memTotal: null,
    ...entry.memBudget === null ? {} : { memBudget: entry.memBudget },
    ...entry.sharedMemUsed === null ? {} : { sharedMemUsed: entry.sharedMemUsed },
    ...entry.sharedMemTotal === null ? {} : { sharedMemTotal: entry.sharedMemTotal }
  }));
};

// src/service/collectors/gpu.ts
var NVIDIA_ARGS = ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"];
var WINDOWS_FIRST_SAMPLE_MS = 8000;
var found = (devices) => devices.length > 0 ? { status: "ok", devices } : unavailable("no-device");
var readNvidia = async (commands) => {
  const result = await run(commands, NVIDIA_ARGS);
  if (!result.ok)
    return { missing: result.missing };
  return { devices: parseNvidiaSmi(result.stdout) };
};
var readAmdCards = async () => {
  const entries = await readdir("/sys/class/drm").catch(() => []);
  const cards = entries.filter((name) => /^card\d+$/.test(name));
  return Promise.all(cards.map(async (card) => {
    const base = `/sys/class/drm/${card}/device`;
    const [vendor, busy, vramUsed, vramTotal] = await Promise.all([
      readText(`${base}/vendor`),
      readText(`${base}/gpu_busy_percent`),
      readText(`${base}/mem_info_vram_used`),
      readText(`${base}/mem_info_vram_total`)
    ]);
    return { card, vendor, busy, vramUsed, vramTotal };
  }));
};
var createGpuCollector = (platform) => {
  if (platform === "darwin") {
    return {
      read: async () => {
        const result = await run(["/usr/sbin/ioreg", "ioreg"], ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]);
        if (!result.ok)
          return unavailable(result.missing ? "tool-missing" : "failed", "ioreg");
        return found(parseIoreg(result.stdout));
      },
      stop: () => {
        return;
      }
    };
  }
  if (platform === "linux") {
    return {
      read: async () => {
        const nvidia = await readNvidia(["nvidia-smi", "/usr/bin/nvidia-smi"]);
        if ("devices" in nvidia && nvidia.devices.length > 0)
          return { status: "ok", devices: nvidia.devices };
        const amd = parseAmdCards(await readAmdCards());
        if (amd.length > 0)
          return { status: "ok", devices: amd };
        if ("missing" in nvidia && !nvidia.missing)
          return unavailable("failed", "nvidia-smi");
        return unavailable("no-device");
      },
      stop: () => {
        return;
      }
    };
  }
  if (platform === "win32") {
    const loop = createGpuLoop();
    let useNvidia = true;
    return {
      read: async () => {
        if (useNvidia) {
          const nvidia = await readNvidia(NVIDIA_SMI_WIN32);
          if ("devices" in nvidia && nvidia.devices.length > 0)
            return { status: "ok", devices: nvidia.devices };
          if ("missing" in nvidia && nvidia.missing)
            useNvidia = false;
        }
        const sample = await loop.latest(WINDOWS_FIRST_SAMPLE_MS);
        if ("missing" in sample)
          return sample.missing ? unavailable("tool-missing", "powershell") : unavailable("failed");
        const devices = parseWindowsGpu(sample.line);
        return devices === null ? unavailable("failed") : found(devices);
      },
      stop: () => {
        useNvidia = true;
        loop.stop();
      }
    };
  }
  return { read: async () => unavailable("unsupported"), stop: () => {
    return;
  } };
};

// src/service/env.ts
import { existsSync } from "node:fs";
import { readFile as readFile2 } from "node:fs/promises";
var currentPlatform = () => {
  const value = process.platform;
  return value === "darwin" || value === "linux" || value === "win32" ? value : "other";
};
var CONTAINER_CGROUP = /(docker|kubepods|containerd|libpod|lxc)/;
var looksLikeContainer = (input) => input.dockerenv || input.containerenv || CONTAINER_CGROUP.test(input.initCgroup ?? "");
var detectContainer = async (platform) => {
  if (platform !== "linux")
    return false;
  const initCgroup = await readFile2("/proc/1/cgroup", "utf8").catch(() => null);
  return looksLikeContainer({
    dockerenv: existsSync("/.dockerenv"),
    containerenv: existsSync("/run/.containerenv"),
    initCgroup
  });
};

// src/service/sampler.ts
import os2 from "node:os";

// src/service/warnings.ts
var SUSTAINED_SAMPLES = 30;
var sustainedHigh = (history) => {
  if (history.length < SUSTAINED_SAMPLES)
    return false;
  return history.slice(-SUSTAINED_SAMPLES).every((value) => value !== null && value >= WARN_PERCENT);
};
var evaluateWarnings = (input) => {
  const warnings = [];
  if (input.cpu.status === "ok" && sustainedHigh(input.cpuHistory)) {
    warnings.push({ kind: "cpu", target: null, level: "warn" });
  }
  if (input.memory.status === "ok" && input.memory.total > 0) {
    const level = levelForPercent(input.memory.used / input.memory.total * 100);
    if (level)
      warnings.push({ kind: "memory", target: null, level });
  }
  if (sustainedHigh(input.gpuHistory)) {
    warnings.push({ kind: "gpu", target: null, level: "warn" });
  }
  if (input.disks.status === "ok") {
    for (const disk of input.disks.items) {
      const level = levelForPercent(diskPercent(disk));
      if (level)
        warnings.push({ kind: "disk", target: disk.mount, level });
    }
  }
  return warnings;
};

// src/service/sampler.ts
var PRIME_MS = 500;
var COMPUTER_INFO_INTERVAL_MS = 5 * 60000;
var freshSource = () => ({ value: unavailable("failed"), lastGood: null, failures: 0, retryAt: 0 });
var settle = (source, result, now) => {
  if (result.status === "ok") {
    source.value = result;
    source.lastGood = result;
    source.failures = 0;
    source.retryAt = 0;
    return;
  }
  if (result.reason === "failed") {
    source.failures += 1;
    if (source.failures < FAILURES_BEFORE_UNAVAILABLE) {
      source.value = source.lastGood ?? result;
      return;
    }
  }
  source.value = result;
  source.lastGood = null;
  source.retryAt = now + RETRY_UNAVAILABLE_MS;
};
var safely = async (read) => {
  try {
    return await read();
  } catch {
    return unavailable("failed");
  }
};
var due = (source, now) => source.retryAt <= now;
var pushHistory = (history, value) => {
  history.push(value);
  if (history.length > HISTORY_LENGTH)
    history.splice(0, history.length - HISTORY_LENGTH);
};
var createSampler = (deps) => {
  let generation = 0;
  let active = false;
  let lastRequest = 0;
  let cancelTimer = null;
  let first = null;
  let snapshot = null;
  let cpu = freshSource();
  let memory = freshSource();
  let gpu = freshSource();
  let disks = freshSource();
  let disksDueAt = 0;
  let computerInfo = null;
  let computerInfoDueAt = 0;
  let cpuHistory = [];
  let gpuHistory = [];
  const reset = () => {
    cpu = freshSource();
    memory = freshSource();
    gpu = freshSource();
    disks = freshSource();
    disksDueAt = 0;
    computerInfo = null;
    computerInfoDueAt = 0;
    cpuHistory = [];
    gpuHistory = [];
    snapshot = null;
  };
  const stop = () => {
    generation += 1;
    active = false;
    first = null;
    cancelTimer?.();
    cancelTimer = null;
    deps.gpu.stop();
    reset();
  };
  const tick = async (current) => {
    const now = deps.now();
    const readDisks = due(disks, now) && now >= disksDueAt;
    const readComputerInfo = deps.computerInfo !== undefined && now >= computerInfoDueAt;
    const [cpuResult, memoryResult, gpuResult, diskResult, computerInfoResult] = await Promise.all([
      due(cpu, now) ? safely(deps.cpuMem.cpu) : null,
      due(memory, now) ? safely(deps.cpuMem.memory) : null,
      due(gpu, now) ? safely(deps.gpu.read) : null,
      readDisks ? safely(deps.disks) : null,
      readComputerInfo ? safely(deps.computerInfo) : null
    ]);
    if (current !== generation)
      return;
    const settledAt = deps.now();
    if (cpuResult)
      settle(cpu, cpuResult, settledAt);
    if (memoryResult)
      settle(memory, memoryResult, settledAt);
    if (gpuResult)
      settle(gpu, gpuResult, settledAt);
    if (diskResult) {
      settle(disks, Array.isArray(diskResult) ? { status: "ok", items: diskResult, sampledAt: settledAt } : diskResult, settledAt);
      disksDueAt = settledAt + DISK_INTERVAL_MS;
    }
    if (computerInfoResult) {
      computerInfo = "status" in computerInfoResult ? null : computerInfoResult;
      computerInfoDueAt = settledAt + COMPUTER_INFO_INTERVAL_MS;
    }
    pushHistory(cpuHistory, cpu.value.status === "ok" ? cpu.value.total : null);
    pushHistory(gpuHistory, busiestGpu(gpu.value));
    snapshot = {
      sampledAt: settledAt,
      environment: {
        platform: deps.platform,
        container: deps.container,
        computer: {
          hostName: os2.hostname() || null,
          operatingSystem: [deps.platform === "win32" ? "Windows" : deps.platform === "darwin" ? "macOS" : os2.type(), os2.release()].filter(Boolean).join(" ") || null,
          architecture: os2.arch() || null,
          uptimeSeconds: Math.floor(os2.uptime()),
          details: computerInfo
        }
      },
      cpu: cpu.value,
      memory: memory.value,
      gpus: gpu.value,
      disks: disks.value,
      history: { cpu: [...cpuHistory], gpu: [...gpuHistory] },
      warnings: evaluateWarnings({
        cpu: cpu.value,
        memory: memory.value,
        disks: disks.value,
        cpuHistory,
        gpuHistory
      })
    };
  };
  const loop = (current) => {
    cancelTimer = deps.schedule(() => {
      cancelTimer = null;
      if (current !== generation)
        return;
      if (deps.now() - lastRequest >= IDLE_STOP_MS) {
        stop();
        return;
      }
      tick(current).finally(() => {
        if (current === generation)
          loop(current);
      });
    }, SAMPLE_INTERVAL_MS);
  };
  const start = () => {
    active = true;
    const current = generation;
    return (async () => {
      await deps.cpuMem.prime().catch(() => {
        return;
      });
      await deps.wait(PRIME_MS);
      if (current !== generation)
        return;
      await tick(current);
      if (current === generation)
        loop(current);
    })();
  };
  return {
    stats: async () => {
      lastRequest = deps.now();
      if (!active)
        first = start();
      if (first)
        await first;
      if (!snapshot)
        throw new Error("Sampling stopped before the first reading.");
      return snapshot;
    },
    stop,
    running: () => active
  };
};

// src/service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var platform = currentPlatform();
var container = await detectContainer(platform);
var now = () => Date.now();
var sampler = createSampler({
  now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  platform,
  container,
  cpuMem: createCpuMemCollector(platform, container, now),
  gpu: createGpuCollector(platform),
  disks: () => readDisks(platform, container),
  computerInfo: () => readComputerInfo(platform)
});
var send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
var server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    send(res, 401, { error: "unauthorized" });
    return;
  }
  const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
  if (pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (pathname === "/stats" && req.method === "GET") {
    sampler.stats().then((stats) => send(res, 200, stats), () => send(res, 503, { error: "not-ready" }));
    return;
  }
  if (pathname === "/open-storage-settings" && req.method === "POST" && platform === "win32") {
    runPowerShell("Start-Process 'ms-settings:storagesense'", 5000).then((result) => send(res, result.ok ? 200 : 500, { opened: result.ok }));
    return;
  }
  send(res, 404, { error: "not-found" });
});
var shutdown = () => {
  sampler.stop();
  server.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.listen(port, "127.0.0.1");
