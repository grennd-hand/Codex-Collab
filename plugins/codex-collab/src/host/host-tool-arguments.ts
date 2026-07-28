export type HostToolArguments = Record<string, unknown>;

export function hostToolArguments(value: unknown): HostToolArguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as HostToolArguments;
}

export function stringArgument(
  args: HostToolArguments,
  name: string,
  optional = false,
): string | undefined {
  const value = args[name];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || (!optional && value.trim() === "")) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function integerArgument(
  args: HostToolArguments,
  name: string,
  fallback: number,
): number {
  const value = args[name] ?? fallback;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value as number;
}
