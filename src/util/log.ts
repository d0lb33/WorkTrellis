// Minimal ANSI + output helpers. No dependency on a color package, because
// WorkTrellis must install cleanly into any project without adding to its tree.

const ESC = String.fromCharCode(27);

const colorEnabled = (() => {
  if (process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force && force !== "0" && force !== "false") return true;
  return process.stdout.isTTY === true;
})();

function style(open: number, close: number) {
  return (text: string) =>
    colorEnabled ? `${ESC}[${open}m${text}${ESC}[${close}m` : text;
}

export const c = {
  bold: style(1, 22),
  dim: style(2, 22),
  red: style(31, 39),
  green: style(32, 39),
  yellow: style(33, 39),
  blue: style(34, 39),
  magenta: style(35, 39),
  cyan: style(36, 39),
  gray: style(90, 39),
};

export type Colorize = (text: string) => string;

export const NAMED_COLORS: Record<string, Colorize> = {
  blue: c.blue,
  magenta: c.magenta,
  cyan: c.cyan,
  yellow: c.yellow,
  green: c.green,
};

/** Colors handed to supervised processes in assignment order. */
export const PROCESS_COLORS: Colorize[] = [
  c.blue,
  c.magenta,
  c.cyan,
  c.yellow,
  c.green,
];

let quiet = false;
export function setQuiet(value: boolean): void {
  quiet = value;
}

export function info(message = ""): void {
  if (!quiet) console.log(message);
}

export function step(label: string, message: string): void {
  if (!quiet) console.log(`  ${c.gray(label.padEnd(9))} ${message}`);
}

export function success(message: string): void {
  if (!quiet) console.log(`${c.green("ok")}  ${message}`);
}

export function warn(message: string): void {
  console.warn(`${c.yellow("!")}   ${message}`);
}

export function error(message: string): void {
  console.error(`${c.red("x")}   ${message}`);
}

export function heading(message: string): void {
  if (!quiet) console.log(c.bold(message));
}

/** Two-column aligned key/value list. */
export function table(rows: Array<[string, string]>, indent = "  "): void {
  if (quiet) return;
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  for (const [label, value] of rows) {
    console.log(`${indent}${c.gray(label.padEnd(width))}  ${value}`);
  }
}

/** Render a value that may be a secret. Never prints the secret itself. */
export function redact(value: string): string {
  return `<set, ${value.length} chars>`;
}
