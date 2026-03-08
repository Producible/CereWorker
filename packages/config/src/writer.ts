import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { ensureConfigDir } from './loader.js';
import { GLOBAL_CONFIG } from './loader.js';

/**
 * Write a config object to ~/.cereworker/config.yaml.
 * Accepts a raw object (not Zod-validated) so that env var references
 * like ${ANTHROPIC_API_KEY} can be written as literal strings.
 */
export function writeConfig(config: Record<string, unknown>): void {
  ensureConfigDir();

  const yaml = stringify(config, {
    lineWidth: 0,
    singleQuote: true,
  });

  const tmpPath = GLOBAL_CONFIG + '.tmp';
  writeFileSync(tmpPath, yaml, 'utf-8');
  renameSync(tmpPath, GLOBAL_CONFIG);
}
