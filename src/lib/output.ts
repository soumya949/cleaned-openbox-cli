import chalk from 'chalk';
import Table from 'cli-table3';

export type OutputFormat = 'pretty' | 'json';

export type PrintOptions = {
  format: OutputFormat;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Buffer);
}

function truncate(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function cell(value: unknown): string {
  if (value === null) {
    return chalk.gray('null');
  }
  if (value === undefined) {
    return chalk.gray('undefined');
  }
  if (typeof value === 'string') {
    return truncate(value.replace(/\s+/g, ' '));
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Buffer) {
    return chalk.gray(`binary(${value.byteLength} bytes)`);
  }
  if (Array.isArray(value)) {
    return chalk.gray(`array(${value.length})`);
  }
  if (isPlainObject(value)) {
    return chalk.gray('object');
  }
  return truncate(String(value));
}

function printKeyValues(obj: Record<string, unknown>): void {
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    process.stdout.write('{}\n');
    return;
  }

  const maxKey = Math.min(30, Math.max(...keys.map((k) => k.length)));
  for (const k of keys) {
    const v = obj[k];
    const left = chalk.cyan(k.padEnd(maxKey, ' '));
    let right: string;

    if (isPlainObject(v) || Array.isArray(v)) {
      right = chalk.gray(truncate(JSON.stringify(v)));
    } else {
      right = cell(v);
    }

    process.stdout.write(`${left}  ${right}\n`);
  }
}

function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    process.stdout.write('(empty)\n');
    return;
  }

  const columns = Array.from(
    new Set(
      rows
        .flatMap((r) => Object.keys(r))
        .filter((k) => !k.toLowerCase().includes('password') && !k.toLowerCase().includes('secret') && !k.toLowerCase().includes('token')),
    ),
  ).slice(0, 10);

  const table = new Table({
    head: columns.map((c) => chalk.cyan(c)),
    wordWrap: true,
    colWidths: columns.map(() => 24),
  });

  for (const row of rows) {
    table.push(columns.map((c) => cell(row[c])));
  }

  process.stdout.write(`${table.toString()}\n`);
}

export function printResult(value: unknown, opts: PrintOptions): void {
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (value instanceof Buffer) {
    process.stdout.write(chalk.gray(`binary(${value.byteLength} bytes)\n`));
    return;
  }

  if (Array.isArray(value)) {
    if (value.every((v) => isPlainObject(v))) {
      printTable(value as Record<string, unknown>[]);
      return;
    }

    process.stdout.write(`${chalk.gray(`array(${value.length})`)}\n`);
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (isPlainObject(value)) {
    printKeyValues(value);
    return;
  }

  process.stdout.write(`${String(value)}\n`);
}
