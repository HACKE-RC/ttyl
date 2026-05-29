// Tiny argv helpers shared by the CLI dispatcher and the server, so flag parsing
// lives in one place.

// splitArgs separates flags (before "--") from a trailing command (after "--").
export function splitArgs(args: string[]): { flags: string[]; command: string[] } {
  const i = args.indexOf("--");
  if (i === -1) {
    return { flags: args, command: [] };
  }
  return { flags: args.slice(0, i), command: args.slice(i + 1) };
}

// flagValue returns the value of any of the given -name/--name forms, written
// either as "name value" or "name=value".
export function flagValue(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) {
        return args[i + 1];
      }
      if (args[i].startsWith(`${name}=`)) {
        return args[i].slice(name.length + 1);
      }
    }
  }
  return undefined;
}

export function flagBool(args: string[], ...names: string[]): boolean {
  return names.some((n) => args.includes(n));
}
