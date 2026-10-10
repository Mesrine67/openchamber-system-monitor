import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { parseWslCatalog, parseWslDefaultVersion, parseWslDiagnostics, parseWslDistroDetails, parseWslList, parseWslRegistrationMetadata, parseWslVersions } from '../src/service/collectors/parse-wsl.ts';
import { withDefaultWslUser, withWslConfigSetting } from '../src/service/collectors/parse-wsl-conf.ts';
import { addWslPendingRestart, clearWslPendingRestart, inspectWslConfig, normalizeWslPendingRestarts, parseWslAction, parseWslConfigUpdate } from '../src/shared/wsl.ts';

describe('WSL parser', () => {
  test('validates, deduplicates and clears persisted pending restart targets', () => {
    const targets = normalizeWslPendingRestarts([
      { kind: 'global' }, { kind: 'global' },
      { kind: 'distribution', distro: 'Ubuntu' }, { kind: 'distribution', distro: 'ubuntu' },
      { kind: 'distribution', distro: '../unsafe' }, null,
    ]);
    expect(targets).toEqual([{ kind: 'global' }, { kind: 'distribution', distro: 'Ubuntu' }]);
    expect(addWslPendingRestart(targets, { kind: 'distribution', distro: 'Fedora' })).toEqual([
      { kind: 'global' }, { kind: 'distribution', distro: 'Ubuntu' }, { kind: 'distribution', distro: 'Fedora' },
    ]);
    expect(clearWslPendingRestart(targets, { kind: 'distribution', distro: 'ubuntu' })).toEqual([{ kind: 'global' }]);
    expect(clearWslPendingRestart(targets)).toEqual([]);
  });

  test('summarizes known WSL settings without losing unknown settings and flags risky behavior', () => {
    const result = inspectWslConfig('[wsl2]\r\nmemory=8GB\r\nprocessors = 6\r\nnetworkingMode=none\r\ncustomFutureOption=value\r\n[boot]\r\nsystemd=true\r\ncommand=service docker start\r\n');
    expect(result.insights).toEqual([
      { section: 'wsl2', key: 'memory', value: '8GB' },
      { section: 'wsl2', key: 'processors', value: '6' },
      { section: 'wsl2', key: 'networkingmode', value: 'none' },
      { section: 'boot', key: 'systemd', value: 'true' },
      { section: 'boot', key: 'command', value: 'service docker start' },
    ]);
    expect(result.hasBootCommand).toBe(true);
    expect(result.networkingDisabled).toBe(true);
  });

  test('summarizes common global and experimental settings with case-insensitive keys', () => {
    const result = inspectWslConfig('[wsl2]\nnestedVirtualization=true\ndebugConsole=true\n[experimental]\nsparseVhd=true\nbestEffortDnsParsing=true\n[general]\ninstanceIdleTimeout=-1');
    expect(result.insights).toEqual([
      { section: 'wsl2', key: 'nestedvirtualization', value: 'true' },
      { section: 'wsl2', key: 'debugconsole', value: 'true' },
      { section: 'experimental', key: 'sparsevhd', value: 'true' },
      { section: 'experimental', key: 'besteffortdnsparsing', value: 'true' },
      { section: 'general', key: 'instanceidletimeout', value: '-1' },
    ]);
  });

  test('recognizes additional guided settings for WSL networking, GPU, boot and time', () => {
    const result = inspectWslConfig('[wsl2]\nlocalhostForwarding=true\nvmIdleTimeout=60000\ndefaultVhdSize=1TB\ndnsProxy=false\nhostAddressLoopback=true\nignoredPorts=53,3000\n[experimental]\nautoMemoryReclaim=gradual\n[network]\ngenerateHosts=false\ngenerateResolvConf=false\n[gpu]\nenabled=true\nappendLibPath=true\n[time]\nuseWindowsTimezone=false\n[boot]\nprotectBinfmt=true\ninitTimeout=20000');
    expect(result.insights).toEqual([
      { section: 'wsl2', key: 'localhostforwarding', value: 'true' },
      { section: 'wsl2', key: 'vmidletimeout', value: '60000' },
      { section: 'wsl2', key: 'defaultvhdsize', value: '1TB' },
      { section: 'wsl2', key: 'dnsproxy', value: 'false' },
      { section: 'wsl2', key: 'hostaddressloopback', value: 'true' },
      { section: 'wsl2', key: 'ignoredports', value: '53,3000' },
      { section: 'experimental', key: 'automemoryreclaim', value: 'gradual' },
      { section: 'network', key: 'generatehosts', value: 'false' },
      { section: 'network', key: 'generateresolvconf', value: 'false' },
      { section: 'gpu', key: 'enabled', value: 'true' },
      { section: 'gpu', key: 'appendlibpath', value: 'true' },
      { section: 'time', key: 'usewindowstimezone', value: 'false' },
      { section: 'boot', key: 'protectbinfmt', value: 'true' },
      { section: 'boot', key: 'inittimeout', value: '20000' },
    ]);
  });

  test('parses bounded process and listening-port diagnostics', async () => {
    const fixture = await readFile(new URL('./fixtures/wsl-diagnostics.txt', import.meta.url), 'utf8');
    expect(parseWslDiagnostics(fixture)).toEqual({
      processes: { status: 'ok', items: [
        { pid: 1842, name: 'node', cpuPercent: 12.5, memoryPercent: 4.8 },
        { pid: 2010, name: 'python3', cpuPercent: 2, memoryPercent: 1.1 },
        { pid: 3011, name: 'background worker', cpuPercent: 1.5, memoryPercent: 3.8 },
      ] },
      listeningPorts: { status: 'ok', items: [
        { protocol: 'tcp', address: '127.0.0.1', port: 3000, processName: 'node', pid: 1842 },
        { protocol: 'tcp', address: '[::]', port: 22, processName: null, pid: null },
        { protocol: 'udp', address: '0.0.0.0', port: 5353, processName: 'dns worker', pid: 92 },
      ] },
      services: { status: 'ok', items: [
        { unit: 'cron.service', loadState: 'loaded', activeState: 'active', subState: 'running', description: 'Regular background program processing daemon' },
        { unit: 'docker.service', loadState: 'loaded', activeState: 'active', subState: 'exited', description: 'Docker Application Container Engine' },
        { unit: 'inactive-worker.service', loadState: 'loaded', activeState: 'inactive', subState: 'dead', description: 'A disabled service with a descriptive name' },
      ] },
      mounts: { status: 'ok', items: [
        { source: '/dev/sda1', target: '/', fileSystem: 'ext4' },
        { source: 'C:\\', target: '/mnt/c', fileSystem: '9p' },
      ] },
      network: {
        status: 'ok', addresses: ['172.30.144.20', 'fe80::215:5dff:fe00:1234'], gateway: '172.30.144.1',
        dnsServers: ['10.255.255.254', '2001:db8::53'], configuredMode: null,
      },
    });
  });

  test('merges CPU and memory leaderboards by PID and caps the process snapshot', () => {
    const cpu = Array.from({ length: 130 }, (_, index) => `${index + 1} ${130 - index} 1 worker ${index}`).join('\n');
    const memory = Array.from({ length: 130 }, (_, index) => `${index + 101} 1 ${130 - index} worker ${index + 100}`).join('\n');
    const parsed = parseWslDiagnostics(`__PROCESSES_CPU__\n${cpu}\n__PROCESSES_MEMORY__\n${memory}\n__PORTS__\n__NETWORK__`);
    expect(parsed.processes.status).toBe('ok');
    if (parsed.processes.status !== 'ok') return;
    expect(parsed.processes.items).toHaveLength(200);
    expect(parsed.processes.items[0]).toEqual({ pid: 1, name: 'worker 0', cpuPercent: 130, memoryPercent: 1 });
    expect(parsed.processes.items.find(({ pid }) => pid === 101)).toEqual({ pid: 101, name: 'worker 100', cpuPercent: 1, memoryPercent: 130 });
    expect(parsed.processes.items.at(-1)).toEqual({ pid: 200, name: 'worker 199', cpuPercent: 1, memoryPercent: 31 });
    expect(new Set(parsed.processes.items.map(({ pid }) => pid)).size).toBe(200);
  });

  test('bounds the systemd service list and ignores malformed rows', () => {
    const rows = Array.from({ length: 105 }, (_, index) => `worker-${index}.service loaded active running Worker ${index}`).join('\n');
    const parsed = parseWslDiagnostics(`__PROCESSES__\n__UNAVAILABLE__\n__PORTS__\n__UNAVAILABLE__\n__SERVICES__\n${rows}\nnot a systemd row\n__NETWORK__`);
    expect(parsed.services.status).toBe('ok');
    if (parsed.services.status !== 'ok') return;
    expect(parsed.services.items).toHaveLength(100);
    expect(parsed.services.items[0]).toEqual({ unit: 'worker-0.service', loadState: 'loaded', activeState: 'active', subState: 'running', description: 'Worker 0' });
    expect(parsed.services.items.at(-1)?.unit).toBe('worker-99.service');
  });

  test('keeps missing guest tools unavailable and drops malformed readings', () => {
    expect(parseWslDiagnostics('__PROCESSES__\n__UNAVAILABLE__\n__PORTS__\ntcp 0.0.0.0:99999\n')).toEqual({
      processes: { status: 'unavailable', reason: 'The ps utility is not available in this distribution.', items: [] },
      listeningPorts: { status: 'ok', items: [] },
      services: { status: 'unavailable', reason: 'Service data was not returned.', items: [] },
      mounts: { status: 'unavailable', reason: 'Mount data was not returned.', items: [] },
      network: { status: 'unavailable', reason: 'Network data was not returned by the guest probe.', addresses: [], gateway: null, dnsServers: [], configuredMode: null },
    });
  });

  test('keeps valid WSL addresses and DNS when optional gateway is absent', () => {
    expect(parseWslDiagnostics('__PROCESSES__\n__UNAVAILABLE__\n__PORTS__\n__UNAVAILABLE__\n__NETWORK__\nADDRESSES=192.168.1.12\nGATEWAY=unknown\nDNS=192.168.1.1\n').network)
      .toEqual({ status: 'ok', addresses: ['192.168.1.12'], gateway: null, dnsServers: ['192.168.1.1'], configuredMode: null });
  });

  test('reads English distribution list with default, state and WSL version', async () => {
    const fixture = await readFile(new URL('./fixtures/wsl-list-en.txt', import.meta.url), 'utf8');
    expect(parseWslList(fixture).map(({ name, state, version, isDefault }) => ({ name, state, version, isDefault }))).toEqual([
      { name: 'Ubuntu', state: 'running', version: 2, isDefault: true },
      { name: 'FedoraLinux-44', state: 'stopped', version: 2, isDefault: false },
      { name: 'Debian', state: 'stopped', version: 1, isDefault: false },
    ]);
  });

  test('decodes WSL UTF-16 output and accepts localized status strings', () => {
    const french = Buffer.from('  NAME                   État            VERSION\r\n* Ubuntu                 En cours        2\r\n  Debian                 Arrêté          1', 'utf16le');
    expect(parseWslList(french).map((distro) => distro.state)).toEqual(['running', 'stopped']);
  });

  test('parses version lines while keeping absent components null', () => {
    expect(parseWslVersions('WSL version: 2.5.11.0\nKernel version: 6.6.87.2-1\n')).toEqual({
      version: '2.5.11.0', kernelVersion: '6.6.87.2-1', wslgVersion: null,
    });
  });

  test('parses default WSL version from status without inventing a value', () => {
    expect(parseWslDefaultVersion('Default Distribution: Ubuntu\nDefault Version: 2\n')).toBe(2);
    expect(parseWslDefaultVersion('Version par défaut : 1\n')).toBe(1);
    expect(parseWslDefaultVersion('Kernel version: 6.6.87\n')).toBeNull();
  });

  test('extracts running distro details without inventing missing readings', () => {
    const output = 'PRETTY_NAME="Ubuntu 24.04 LTS"\nVERSION_ID="24.04"\n__KERNEL__=6.6.87\n__OS__\nPRETTY_NAME="Ubuntu 24.04 LTS"\nVERSION_ID="24.04"\n__MEM__\nMem: 1000 400 600\n__DISK__\n/dev/sda 1000 250 750\n__PROCS__=17\n';
    expect(parseWslDistroDetails(output)).toMatchObject({
      osName: 'Ubuntu 24.04 LTS', osVersion: '24.04', kernel: '6.6.87',
      memoryUsedBytes: 400, memoryTotalBytes: 1000, rootUsedBytes: 250, rootTotalBytes: 1000, processCount: 17,
    });
    expect(parseWslDistroDetails('')).toMatchObject({ osName: null, memoryUsedBytes: null, processCount: null });
  });

  test('parses WSL GPU probes and only exposes valid xrdp ports', async () => {
    const fixture = await readFile(new URL('./fixtures/wsl-distro-probe.txt', import.meta.url), 'utf8');
    expect(parseWslDistroDetails(fixture)).toMatchObject({
      gpu: { directX: true, cudaLibrary: true, nvidiaToolkit: true, cdiSpec: false },
      remoteDesktopPort: 3390,
    });
    expect(parseWslDistroDetails('__XRDP__=99999\n').remoteDesktopPort).toBeNull();
    expect(parseWslDistroDetails('__GPU__=1,1,0,0\n').gpu).toEqual({ directX: true, cudaLibrary: true, nvidiaToolkit: false, cdiSpec: false });
  });

  test('parses sanitized registry metadata without returning private install paths', async () => {
    const fixture = await readFile(new URL('./fixtures/wsl-registration-metadata.json', import.meta.url), 'utf8');
    expect(parseWslRegistrationMetadata(fixture)).toEqual([
      { name: 'Ubuntu', source: 'store', virtualDiskBytes: 4_294_967_296 },
      { name: 'FedoraLinux-44', source: 'imported', virtualDiskBytes: null },
    ]);
    expect(parseWslRegistrationMetadata('{')).toEqual([]);
  });

  test('parses online distribution names without treating the header as an item', async () => {
    const fixture = await readFile(new URL('./fixtures/wsl-catalog-en.txt', import.meta.url), 'utf8');
    expect(parseWslCatalog(fixture)).toEqual([
      { name: 'Ubuntu', friendlyName: 'Ubuntu' },
      { name: 'Debian', friendlyName: 'Debian GNU/Linux' },
      { name: 'openSUSE-Leap-15.6', friendlyName: 'openSUSE Leap 15.6' },
    ]);
  });

  test('reads OS details when the first output line is the section marker', () => {
    const output = '__OS__\nPRETTY_NAME="Ubuntu 24.04 LTS"\nVERSION_ID="24.04"\n__KERNEL__=6.6.87\n';
    expect(parseWslDistroDetails(output)).toMatchObject({ osName: 'Ubuntu 24.04 LTS', osVersion: '24.04', kernel: '6.6.87' });
  });

  test('validates fixed WSL actions, paths and exact destructive confirmations', () => {
    expect(parseWslAction({ action: 'start', distro: '--exec' })).toBeNull();
    expect(parseWslAction({ action: 'export', distro: 'Ubuntu', file: 'C:\\safe\\..\\escape.tar' })).toBeNull();
    expect(parseWslAction({ action: 'export', distro: 'Ubuntu', file: 'C:\\' })).toBeNull();
    expect(parseWslAction({ action: 'export', distro: 'Ubuntu', file: 'C:\\safe\\archive.tar:stream' })).toBeNull();
    expect(parseWslAction({ action: 'export', distro: 'Ubuntu', file: 'C:\\safe\\CON.txt' })).toBeNull();
    expect(parseWslAction({ action: 'export', distro: 'Ubuntu', file: 'D:\\Backups\\Ubuntu.vhdx', format: 'vhd' }))
      .toEqual({ action: 'export', distro: 'Ubuntu', file: 'D:\\Backups\\Ubuntu.vhdx', format: 'vhd' });
    expect(parseWslAction({ action: 'export', distro: 'Ubuntu', file: 'D:\\Backups\\Ubuntu.tar', format: 'zip' })).toBeNull();
    expect(parseWslAction({ action: 'import', distro: 'UbuntuCopy', location: 'D:\\WSL\\UbuntuCopy', file: 'D:\\Backups\\Ubuntu.vhdx', version: 1, format: 'vhd' })).toBeNull();
    expect(parseWslAction({ action: 'import', distro: 'UbuntuCopy', location: 'D:\\WSL\\UbuntuCopy', file: 'D:\\Backups\\Ubuntu.vhdx', version: 2, format: 'vhd' }))
      .toEqual({ action: 'import', distro: 'UbuntuCopy', location: 'D:\\WSL\\UbuntuCopy', file: 'D:\\Backups\\Ubuntu.vhdx', version: 2, format: 'vhd' });
    expect(parseWslAction({ action: 'import-in-place', distro: 'UbuntuVhd', file: 'D:\\Backups\\Ubuntu.vhdx' }))
      .toEqual({ action: 'import-in-place', distro: 'UbuntuVhd', file: 'D:\\Backups\\Ubuntu.vhdx' });
    expect(parseWslAction({ action: 'import-in-place', distro: 'UbuntuVhd', file: 'D:\\Backups\\Ubuntu.tar' })).toBeNull();
    expect(parseWslAction({ action: 'import-in-place', distro: '--exec', file: 'D:\\Backups\\Ubuntu.vhdx' })).toBeNull();
    expect(parseWslAction({ action: 'install-from-file', distro: 'MyLinux', file: 'D:\\Downloads\\MyLinux.wsl', location: 'D:\\WSL\\MyLinux', version: 2, confirmation: 'INSTALL MyLinux FROM FILE' }))
      .toEqual({ action: 'install-from-file', distro: 'MyLinux', file: 'D:\\Downloads\\MyLinux.wsl', location: 'D:\\WSL\\MyLinux', version: 2, confirmation: 'INSTALL MyLinux FROM FILE' });
    expect(parseWslAction({ action: 'install-from-file', distro: 'MyLinux', file: 'D:\\Downloads\\MyLinux.tar', location: 'D:\\WSL\\MyLinux', version: 2, confirmation: 'INSTALL MyLinux FROM FILE' })).toBeNull();
    expect(parseWslAction({ action: 'install-from-file', distro: 'MyLinux', file: 'D:\\Downloads\\MyLinux.wsl', location: 'D:\\WSL\\MyLinux', version: 2, confirmation: 'yes' })).toBeNull();
    expect(parseWslAction({ action: 'unregister', distro: 'Ubuntu', confirmation: 'yes' })).toBeNull();
    expect(parseWslAction({ action: 'compact', distro: 'Ubuntu', confirmation: 'Ubuntu' })).toBeNull();
    expect(parseWslAction({ action: 'compact', distro: 'Ubuntu', confirmation: 'COMPACT Ubuntu' }))
      .toEqual({ action: 'compact', distro: 'Ubuntu', confirmation: 'COMPACT Ubuntu' });
    expect(parseWslAction({ action: 'set-version', distro: 'Ubuntu', version: 2 })).toBeNull();
    expect(parseWslAction({ action: 'set-version', distro: 'Ubuntu', version: 2, confirmation: 'SET VERSION Ubuntu 2' }))
      .toEqual({ action: 'set-version', distro: 'Ubuntu', version: 2, confirmation: 'SET VERSION Ubuntu 2' });
    expect(parseWslAction({ action: 'force-shutdown', confirmation: 'FORCE SHUTDOWN WSL' }))
      .toEqual({ action: 'force-shutdown', confirmation: 'FORCE SHUTDOWN WSL' });
    expect(parseWslAction({ action: 'set-default-version', version: 2, confirmation: 'DEFAULT WSL 2' }))
      .toEqual({ action: 'set-default-version', version: 2, confirmation: 'DEFAULT WSL 2' });
    expect(parseWslAction({ action: 'update-wsl', confirmation: 'UPDATE WSL' }))
      .toEqual({ action: 'update-wsl', confirmation: 'UPDATE WSL' });
    expect(parseWslAction({ action: 'clone', distro: 'Ubuntu', newDistro: 'Ubuntu-copy', location: 'D:\\WSL\\Ubuntu-copy', version: 2, confirmation: 'CLONE Ubuntu AS Ubuntu-copy' }))
      .toEqual({ action: 'clone', distro: 'Ubuntu', newDistro: 'Ubuntu-copy', location: 'D:\\WSL\\Ubuntu-copy', version: 2, confirmation: 'CLONE Ubuntu AS Ubuntu-copy' });
    expect(parseWslAction({ action: 'rename', distro: 'Ubuntu', newDistro: 'Ubuntu-renamed', location: 'D:\\WSL\\Ubuntu-renamed', version: 2, confirmation: 'RENAME Ubuntu AS Ubuntu-renamed' }))
      .toEqual({ action: 'rename', distro: 'Ubuntu', newDistro: 'Ubuntu-renamed', location: 'D:\\WSL\\Ubuntu-renamed', version: 2, confirmation: 'RENAME Ubuntu AS Ubuntu-renamed' });
    expect(parseWslAction({ action: 'clone', distro: 'Ubuntu', newDistro: 'Ubuntu-copy', location: 'D:\\WSL\\Ubuntu-copy', version: 2, confirmation: 'yes' })).toBeNull();
    expect(parseWslAction({ action: 'clone', distro: 'Ubuntu', newDistro: '--exec', location: 'D:\\WSL\\Ubuntu-copy', version: 2, confirmation: 'CLONE Ubuntu AS --exec' })).toBeNull();
    expect(parseWslAction({ action: 'rename', distro: 'Ubuntu', newDistro: 'Ubuntu', location: 'D:\\WSL\\Ubuntu', version: 2, confirmation: 'RENAME Ubuntu AS Ubuntu' })).toBeNull();
  });

  test('updates only the default user and preserves existing WSL config sections', () => {
    const config = '# keep this comment\n[boot]\nsystemd=true\n\n[user]\ndefault=olduser\n[interop]\nenabled=true\n';
    expect(withDefaultWslUser(config, 'mike')).toBe('# keep this comment\n[boot]\nsystemd=true\n\n[user]\ndefault=mike\n[interop]\nenabled=true\n');
    expect(withDefaultWslUser('[boot]\nsystemd=true\n', 'mike')).toBe('[boot]\nsystemd=true\n\n[user]\ndefault=mike\n');
    expect(() => withDefaultWslUser('[user]\ndefault=old\n', 'bad;command')).toThrow();
  });

  test('updates a guided WSL setting without dropping comments, unknown keys or duplicate sections', () => {
    const config = '# keep comment\r\n[wsl2]\r\nmemory=8GB # memory note\r\nfutureOption=keep\r\n[experimental]\r\nsparseVhd=true\r\n[wsl2]\r\nprocessors=4\r\n';
    expect(withWslConfigSetting(config, 'wsl2', 'memory', '12GB'))
      .toBe('# keep comment\n[wsl2]\nmemory=12GB # memory note\nfutureOption=keep\n[experimental]\nsparseVhd=true\n[wsl2]\nprocessors=4\n');
    expect(withWslConfigSetting('[boot]\nsystemd=true\n', 'user', 'default', 'mike'))
      .toBe('[boot]\nsystemd=true\n\n[user]\ndefault=mike\n');
    expect(() => withWslConfigSetting('[wsl2]', 'wsl2', 'memory', '8GB\nboot=unsafe')).toThrow();
  });

  test('accepts only bounded WSL config files with exact confirmations', () => {
    expect(parseWslConfigUpdate({ kind: 'global', text: '[wsl2]\nmemory=8GB\n', confirmation: 'SAVE GLOBAL WSL CONFIG' }))
      .toEqual({ kind: 'global', text: '[wsl2]\nmemory=8GB\n', confirmation: 'SAVE GLOBAL WSL CONFIG' });
    expect(parseWslConfigUpdate({ kind: 'distribution', distro: 'Ubuntu', text: '[boot]\nsystemd=true', confirmation: 'SAVE WSL CONFIG Ubuntu' }))
      .toEqual({ kind: 'distribution', distro: 'Ubuntu', text: '[boot]\nsystemd=true', confirmation: 'SAVE WSL CONFIG Ubuntu' });
    expect(parseWslConfigUpdate({ kind: 'distribution', distro: 'Ubuntu', text: '', confirmation: 'yes' })).toBeNull();
    expect(parseWslConfigUpdate({ kind: 'global', text: 'x'.repeat(16_385), confirmation: 'SAVE GLOBAL WSL CONFIG' })).toBeNull();
    expect(parseWslConfigUpdate({ kind: 'global', text: '\0', confirmation: 'SAVE GLOBAL WSL CONFIG' })).toBeNull();
  });
});
