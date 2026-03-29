import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CACHE_PATH = join(homedir(), '.cereworker', 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REGISTRY_URL = 'https://registry.npmjs.org/@cereworker/cli/latest';
const FETCH_TIMEOUT_MS = 5_000;

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

interface UpdateCheckDeps {
  cachePath?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function readCache(cachePath: string): UpdateCache | null {
  try {
    if (!existsSync(cachePath)) return null;
    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  } catch {
    // Non-critical
  }
}

export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map(Number);
  const [lMaj, lMin, lPatch] = parse(latest);
  const [cMaj, cMin, cPatch] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPatch > cPatch;
}

/**
 * Check npm registry for a newer version. Returns the latest version string
 * if an update is available, or null if current/offline/error.
 * Caches results for 24 hours to avoid frequent network requests.
 */
export async function checkForUpdate(currentVersion: string, deps?: UpdateCheckDeps): Promise<string | null> {
  const cachePath = deps?.cachePath ?? CACHE_PATH;
  const fetchImpl = deps?.fetch ?? fetch;
  const now = deps?.now ?? Date.now;
  const timeoutMs = deps?.timeoutMs ?? FETCH_TIMEOUT_MS;

  try {
    const cache = readCache(cachePath);

    // Use cached result if checked recently
    if (cache && now() - cache.lastCheck < CHECK_INTERVAL_MS) {
      return isNewer(cache.latestVersion, currentVersion) ? cache.latestVersion : null;
    }

    // Fetch from npm registry
    const res = await fetchImpl(REGISTRY_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { version?: string };
    const latestVersion = data.version;
    if (!latestVersion) return null;

    writeCache(cachePath, { lastCheck: now(), latestVersion });

    return isNewer(latestVersion, currentVersion) ? latestVersion : null;
  } catch {
    return null;
  }
}
