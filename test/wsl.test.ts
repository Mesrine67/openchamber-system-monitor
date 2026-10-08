import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { parseWslCatalog, parseWslDefaultVersion, parseWslDistroDetails, parseWslList, parseWslRegistrationMetadata, parseWslVersions } from '../src/service/collectors/parse-wsl.ts';
import { withDefaultWslUser } from '../src/service/collectors/parse-wsl-conf.ts';
import { parseWslAction, parseWslConfigUpdate } from '../src/shared/wsl.ts';

describe('WSL parser', () => {
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
