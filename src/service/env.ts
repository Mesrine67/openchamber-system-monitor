import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { Platform } from '../shared/stats.ts';

export const currentPlatform = (): Platform => {
  const value = process.platform;
  return value === 'darwin' || value === 'linux' || value === 'win32' ? value : 'other';
};

const CONTAINER_CGROUP = /(docker|kubepods|containerd|libpod|lxc)/;

/** Pure part of container detection, for tests. */
export const looksLikeContainer = (input: {
  dockerenv: boolean;
  containerenv: boolean;
  initCgroup: string | null;
}): boolean => input.dockerenv || input.containerenv || CONTAINER_CGROUP.test(input.initCgroup ?? '');

/** Only Linux containers are recognised; Docker Desktop's VM on macOS and Windows is Linux too. */
export const detectContainer = async (platform: Platform): Promise<boolean> => {
  if (platform !== 'linux') return false;
  const initCgroup = await readFile('/proc/1/cgroup', 'utf8').catch(() => null);
  return looksLikeContainer({
    dockerenv: existsSync('/.dockerenv'),
    containerenv: existsSync('/run/.containerenv'),
    initCgroup,
  });
};
