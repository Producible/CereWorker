export type ExecDecision = 'allow' | 'ask' | 'block';

/** Read-only / safe binaries that auto-execute in both modes */
const SAFE_BINARIES = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find',
  'wc', 'echo', 'pwd', 'whoami', 'date', 'which', 'file', 'stat', 'du', 'df',
  'env', 'printenv', 'uname', 'hostname', 'tree', 'less', 'more', 'sort',
  'uniq', 'diff', 'tr', 'cut', 'sed', 'awk', 'jq', 'curl', 'wget',
  'git', 'node', 'python', 'python3', 'npm', 'pnpm', 'yarn', 'bun',
  'tsc', 'npx', 'cargo', 'go', 'make', 'cmake',
]);

/** Hard-block patterns — blocked in ALL modes, including full-auto */
const HARD_BLOCK_PATTERNS = [
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*$/,  // rm -rf /
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/\s*$/,  // rm -fr /
  /mkfs\b/,
  /dd\s+if=.*of=\/dev/,
  /:()\s*\{\s*:\|:&\s*\}\s*;/,  // fork bomb
];

/** Destructive patterns — blocked in supervised, Cerebellum-screened in full-auto */
const DESTRUCTIVE_PATTERNS = [
  /rm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f|--recursive|--force)/,
  /chmod\s+(777|a\+[rwx])/,
  />\s*\/dev\/sd/,
  /curl\b.*\|\s*(bash|sh)\b/,
  /wget\b.*\|\s*(bash|sh)\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
];

/**
 * Extract the first binary/command from a shell command string.
 * Handles env vars, sudo, leading whitespace, pipes.
 */
export function extractBinary(command: string): string {
  const trimmed = command.trim();

  // Handle environment variable prefixes (e.g. "FOO=bar cmd")
  let rest = trimmed;
  while (/^\w+=\S*\s+/.test(rest)) {
    rest = rest.replace(/^\w+=\S*\s+/, '');
  }

  // Skip sudo/env/nohup prefixes
  const prefixes = ['sudo', 'env', 'nohup', 'nice', 'time'];
  for (const prefix of prefixes) {
    const pattern = new RegExp(`^${prefix}\\s+`);
    if (pattern.test(rest)) {
      rest = rest.replace(pattern, '');
    }
  }

  // Extract the binary name (first word, stripping path)
  const match = rest.match(/^(\S+)/);
  if (!match) return '';

  const fullPath = match[1];
  // Strip path component (e.g. /usr/bin/ls -> ls)
  const parts = fullPath.split('/');
  return parts[parts.length - 1];
}

/**
 * Evaluate a command and return the exec decision.
 *
 * - Supervised mode (autoMode=false): safe binary → allow, hard-block → block, destructive → block, else → ask
 * - Full-auto mode (autoMode=true): safe binary → allow, hard-block → block, else → allow
 *   (Cerebellum pre-screening happens at a higher level for full-auto)
 */
export function evaluateCommand(command: string, autoMode: boolean): ExecDecision {
  // Hard-block patterns are always blocked
  for (const pattern of HARD_BLOCK_PATTERNS) {
    if (pattern.test(command)) return 'block';
  }

  // In supervised mode, check destructive patterns before safe binary check
  // (a safe binary like curl can still be used destructively: curl | bash)
  if (!autoMode) {
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(command)) return 'block';
    }
  }

  const binary = extractBinary(command);

  // Safe binaries are allowed
  if (SAFE_BINARIES.has(binary)) return 'allow';

  if (autoMode) {
    // Full-auto: everything not hard-blocked is allowed
    // (Cerebellum pre-screening is handled by the caller)
    return 'allow';
  }

  // Unknown command in supervised mode → ask user
  return 'ask';
}

/** Check if a binary is in the safe list */
export function isSafeBinary(binary: string): boolean {
  return SAFE_BINARIES.has(binary);
}
