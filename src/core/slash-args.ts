export type SlashArgsValue = boolean | string | string[];
export type SlashArgsParseResult = { flags: Record<string, SlashArgsValue>; positionals: string[] };

export type SlashFlagSpec = { kind: "boolean" | "string" | "stringList"; multiple?: boolean };
export type SlashArgsSpec = Record<string, SlashFlagSpec>;

export function parseSlashArgs(input: string, spec: SlashArgsSpec): SlashArgsParseResult {
  const tokens = tokenize(input);
  const flags: Record<string, SlashArgsValue> = {};
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!token.startsWith("--") || token === "--") {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    const flag = spec[name];
    if (!flag) throw new Error(`unknown flag --${name}`);
    if (!name || name.startsWith("-")) throw new Error(`invalid flag ${token}`);
    if (flag.kind === "boolean") {
      if (eq >= 0) throw new Error(`flag --${name} does not accept a value`);
      flags[name] = true;
      continue;
    }
    if (eq >= 0 && flag.kind !== "string") throw new Error(`--flag=value is only supported for string flags`);
    const values: string[] = [];
    if (eq >= 0) {
      const value = token.slice(eq + 1);
      if (!value) throw new Error(`missing value for --${name}`);
      values.push(value);
    } else if (flag.kind === "string") {
      const value = tokens[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
      values.push(value);
    } else {
      while (tokens[i + 1] && !tokens[i + 1]!.startsWith("--")) values.push(tokens[++i]!);
      if (!values.length) throw new Error(`missing value for --${name}`);
    }
    if (flag.kind === "string") {
      if (flags[name] !== undefined && !flag.multiple) throw new Error(`duplicate flag --${name}`);
      if (flag.multiple) flags[name] = [...asList(flags[name]), values[0]!];
      else flags[name] = values[0]!;
    } else {
      flags[name] = [...asList(flags[name]), ...values];
    }
  }
  return { flags, positionals };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error("unclosed quote in arguments");
  if (current) tokens.push(current);
  return tokens;
}

function asList(value: SlashArgsValue | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}
