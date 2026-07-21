// Minimal argv parser: --flag value | --flag=value | boolean flags.
const BOOLEAN_FLAGS = new Set(['mobile', 'headless', 'debug', 'help', 'version']);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = argv[++i];
      }
    }
  }
  return { flags, positional };
}
