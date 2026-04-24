import type { Command } from 'commander';

import fs from 'node:fs/promises';
import path from 'node:path';

import chalk from 'chalk';
import Table from 'cli-table3';

import { readConfig, resolveBaseUrl } from '../lib/config';
import { OpenBoxClient } from '../lib/openboxClient';
import { prompt } from '../lib/prompt';
import { printResult, type OutputFormat } from '../lib/output';

type GlobalOpts = {
  json?: boolean;
  baseUrl?: string;
  token?: string;
};

type ClientContext = {
  client: OpenBoxClient;
  format: OutputFormat;
};

async function getContext(cmd: Command): Promise<ClientContext> {
  const g = (cmd.optsWithGlobals() as GlobalOpts) ?? {};
  const cfg = await readConfig();
  const baseUrl = (g.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
  const token = g.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;
  return {
    client: new OpenBoxClient({ baseUrl, token }),
    format: g.json ? 'json' : 'pretty',
  };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

async function confirm(question: string): Promise<boolean> {
  const raw = (await prompt(`${question} (yes/no): `)).trim().toLowerCase();
  return raw === 'y' || raw === 'yes';
}

async function resolveAgentId(client: OpenBoxClient, provided?: string): Promise<string> {
  if (provided) return provided;
  const res = await client.request('GET', '/agent/list', { query: { all: 'true' } });
  const agents = (() => {
    if (!res.data || typeof res.data !== 'object') return [] as Record<string, unknown>[];
    const top = res.data as Record<string, unknown>;
    const d = top.data;
    if (Array.isArray(d)) return d as Record<string, unknown>[];
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const inner = (d as Record<string, unknown>).data;
      if (Array.isArray(inner)) return inner as Record<string, unknown>[];
    }
    return [] as Record<string, unknown>[];
  })();
  if (agents.length === 0) {
    throw new Error('No agents found. Register one first with `openbox agent register`.');
  }
  if (agents.length === 1) {
    const id = pickString(agents[0], ['id', 'agent_id']);
    if (!id) throw new Error('Could not determine agent ID from agent list.');
    process.stdout.write(chalk.gray(`Using agent ${id} (${pickString(agents[0], ['agent_name', 'name']) ?? '-'})\n`));
    return id;
  }
  process.stdout.write(chalk.yellow('Multiple agents found. Please choose one:\n'));
  const table = new Table({ head: [chalk.cyan('#'), chalk.cyan('Agent ID'), chalk.cyan('Name')] });
  agents.forEach((a, i) => {
    table.push([String(i + 1), pickString(a, ['id', 'agent_id']) ?? '-', pickString(a, ['agent_name', 'name']) ?? '-']);
  });
  process.stdout.write(`${table.toString()}\n`);
  while (true) {
    const raw = (await prompt('Pick # or paste agent ID: ')).trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= agents.length) {
      return pickString(agents[n - 1], ['id', 'agent_id']) ?? raw;
    }
    if (raw) return raw;
  }
}

type PolicyRecord = {
  id?: string;
  name?: string;
  description?: string;
  rego_code: string;
  input?: unknown;
  config?: unknown;
  updated_at?: string;
  created_at?: string;
  is_active?: boolean;
  raw: Record<string, unknown>;
};

function extractPolicy(data: unknown): PolicyRecord | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  let obj = data as Record<string, unknown>;
  for (let i = 0; i < 3; i += 1) {
    if (typeof obj.rego_code === 'string') break;
    const next = obj.data;
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      obj = next as Record<string, unknown>;
    } else {
      break;
    }
  }
  if (typeof obj.rego_code !== 'string') return undefined;
  return {
    id: typeof obj.id === 'string' ? obj.id : undefined,
    name: typeof obj.name === 'string' ? obj.name : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    rego_code: obj.rego_code,
    input: obj.input,
    config: obj.config,
    updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : undefined,
    created_at: typeof obj.created_at === 'string' ? obj.created_at : undefined,
    is_active: typeof obj.is_active === 'boolean' ? obj.is_active : undefined,
    raw: obj,
  };
}

async function fetchCurrentPolicy(client: OpenBoxClient, agentId: string): Promise<PolicyRecord | undefined> {
  try {
    const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}/policies/current`);
    return extractPolicy(res.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404')) return undefined;
    throw err;
  }
}

function policyHeaderComment(p: PolicyRecord): string {
  const lines = ['# --- OpenBox policy metadata ---'];
  if (p.name) lines.push(`# name: ${p.name}`);
  if (p.id) lines.push(`# id: ${p.id}`);
  if (p.description) lines.push(`# description: ${p.description}`);
  if (p.updated_at) lines.push(`# updated_at: ${p.updated_at}`);
  lines.push('# -------------------------------');
  lines.push('');
  return lines.join('\n');
}

type DiffOp = { kind: 'eq' | 'add' | 'del'; line: string };

function lineDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', line: a[i] });
      i += 1;
    } else {
      ops.push({ kind: 'add', line: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', line: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'add', line: b[j] });
    j += 1;
  }
  return ops;
}

function printDiff(ops: DiffOp[], labelA: string, labelB: string, contextLines = 3): { hasChanges: boolean; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'add') added += 1;
    else if (op.kind === 'del') removed += 1;
  }
  const hasChanges = added > 0 || removed > 0;

  process.stdout.write(`${chalk.bold('---')} ${chalk.red(labelA)}\n`);
  process.stdout.write(`${chalk.bold('+++')} ${chalk.green(labelB)}\n`);

  if (!hasChanges) {
    process.stdout.write(chalk.gray('(no differences)\n'));
    return { hasChanges, added, removed };
  }

  const keep = new Array(ops.length).fill(false) as boolean[];
  ops.forEach((op, idx) => {
    if (op.kind !== 'eq') {
      for (let k = Math.max(0, idx - contextLines); k <= Math.min(ops.length - 1, idx + contextLines); k += 1) {
        keep[k] = true;
      }
    }
  });

  let lastPrinted = -2;
  ops.forEach((op, idx) => {
    if (!keep[idx]) return;
    if (idx > lastPrinted + 1) {
      process.stdout.write(chalk.cyan('  ...\n'));
    }
    if (op.kind === 'eq') process.stdout.write(`  ${op.line}\n`);
    else if (op.kind === 'add') process.stdout.write(`${chalk.green(`+ ${op.line}`)}\n`);
    else process.stdout.write(`${chalk.red(`- ${op.line}`)}\n`);
    lastPrinted = idx;
  });

  process.stdout.write(`\n${chalk.gray(`+${added} −${removed}`)}\n`);
  return { hasChanges, added, removed };
}

async function runPull(
  outFile: string | undefined,
  opts: { agent?: string; includeMeta?: boolean },
  cmd: Command,
): Promise<void> {
  const { client, format } = await getContext(cmd);
  const agentId = await resolveAgentId(client, opts.agent);
  const policy = await fetchCurrentPolicy(client, agentId);

  if (!policy) {
    process.stdout.write(chalk.yellow('No current policy deployed for this agent.\n'));
    return;
  }

  if (format === 'json') {
    printResult(policy.raw, { format });
    return;
  }

  const body = (opts.includeMeta ? policyHeaderComment(policy) : '') + policy.rego_code;

  if (outFile) {
    await fs.writeFile(outFile, body, 'utf8');
    process.stdout.write(chalk.green(`✓ Wrote ${body.length} bytes to ${outFile}\n`));
    if (policy.name) process.stdout.write(chalk.gray(`  name: ${policy.name}\n`));
    if (policy.id) process.stdout.write(chalk.gray(`  id:   ${policy.id}\n`));
    if (policy.updated_at) process.stdout.write(chalk.gray(`  updated_at: ${policy.updated_at}\n`));
  } else {
    process.stdout.write(body);
    if (!body.endsWith('\n')) process.stdout.write('\n');
  }
}

async function validateRego(client: OpenBoxClient, rego: string, input: unknown): Promise<void> {
  await client.request('POST', '/policy/evaluate', { body: { policy: rego, input: input ?? {} } });
}

async function runPush(
  file: string,
  opts: {
    agent?: string;
    name?: string;
    description?: string;
    input?: string;
    skipValidate?: boolean;
    yes?: boolean;
  },
  cmd: Command,
): Promise<void> {
  const { client, format } = await getContext(cmd);
  const agentId = await resolveAgentId(client, opts.agent);

  const resolvedPath = path.resolve(file);
  let rego: string;
  try {
    rego = await fs.readFile(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read Rego file at ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!rego.trim()) throw new Error('Rego file is empty.');

  let input: unknown = {};
  if (opts.input) {
    const inputPath = path.resolve(opts.input);
    const raw = await fs.readFile(inputPath, 'utf8');
    try {
      input = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Input file ${inputPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    const current = await fetchCurrentPolicy(client, agentId);
    if (current && current.input !== undefined && current.input !== null) {
      input = current.input;
    }
  }

  if (!opts.skipValidate) {
    process.stdout.write(chalk.gray('Validating Rego syntax via /policy/evaluate...\n'));
    try {
      await validateRego(client, rego, input);
      process.stdout.write(chalk.green('✓ Rego parses and evaluates cleanly.\n'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(chalk.red(`✗ Syntax/evaluation failed:\n${msg}\n`));
      process.stdout.write(chalk.yellow('Aborting push. Use --skip-validate to force.\n'));
      process.exitCode = 1;
      return;
    }
  }

  let name = opts.name;
  let description = opts.description;
  if (!name) {
    const current = await fetchCurrentPolicy(client, agentId);
    if (current?.name) name = current.name;
    if (!description && current?.description) description = current.description;
  }
  if (!name) {
    const base = path.basename(file, path.extname(file));
    const raw = (await prompt(`Policy name [${base}]: `)).trim();
    name = raw || base;
  }

  if (!opts.yes) {
    process.stdout.write(chalk.yellow(`\nAbout to deploy policy ${chalk.bold(name)} to agent ${agentId}.\n`));
    process.stdout.write(chalk.gray(`  ${rego.split(/\r?\n/).length} lines, ${rego.length} bytes\n`));
    if (!(await confirm('Proceed?'))) {
      process.stdout.write('Aborted.\n');
      return;
    }
  }

  const body: Record<string, unknown> = {
    name,
    rego_code: rego,
    input,
  };
  if (description) body.description = description;

  const res = await client.request('POST', `/agent/${encodeURIComponent(agentId)}/policies`, { body });
  process.stdout.write(`${chalk.green('✓ Policy deployed.')}\n`);
  if (format === 'json') {
    printResult(res.data, { format });
  } else {
    const deployed = extractPolicy(res.data);
    if (deployed?.id) process.stdout.write(chalk.gray(`  id: ${deployed.id}\n`));
    if (deployed?.updated_at) process.stdout.write(chalk.gray(`  updated_at: ${deployed.updated_at}\n`));
  }
}

async function runDiff(file: string | undefined, opts: { agent?: string }, cmd: Command): Promise<void> {
  const { client } = await getContext(cmd);
  const agentId = await resolveAgentId(client, opts.agent);

  const localPath = file ? path.resolve(file) : path.resolve('policy.rego');
  let local: string;
  try {
    local = await fs.readFile(localPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read local Rego file at ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const remote = await fetchCurrentPolicy(client, agentId);
  if (!remote) {
    process.stdout.write(chalk.yellow('No current policy deployed for this agent. Local file is entirely new.\n'));
  }
  const remoteCode = remote?.rego_code ?? '';

  const ops = lineDiff(remoteCode.split(/\r?\n/), local.split(/\r?\n/));
  const labelA = `deployed${remote?.updated_at ? ` @ ${remote.updated_at}` : ''}`;
  const labelB = localPath;
  const { hasChanges } = printDiff(ops, labelA, labelB);
  if (hasChanges) process.exitCode = 1;
}

function decisionColor(decision: unknown): string {
  const raw = decision === undefined || decision === null ? '-' : String(decision);
  const up = raw.toUpperCase();
  if (up === 'ALLOW' || up === 'TRUE' || up === 'CONTINUE' || decision === true) return chalk.green.bold(up);
  if (up === 'DENY' || up === 'FALSE' || up === 'HALT' || up === 'BLOCK' || decision === false) return chalk.red.bold(up);
  if (up === 'REQUIRE_APPROVAL' || up === 'APPROVAL' || up === 'APPROVE') return chalk.yellow.bold(up);
  if (up === 'WARN') return chalk.yellow.bold(up);
  if (up === 'LOG' || up === '-') return chalk.gray(up);
  return chalk.cyan.bold(up);
}

function printEvaluationResult(data: unknown): void {
  let obj: Record<string, unknown> | undefined;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    obj = data as Record<string, unknown>;
    for (let i = 0; i < 3; i += 1) {
      const inner = obj!.data;
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        obj = inner as Record<string, unknown>;
      } else {
        break;
      }
    }
  }
  if (!obj) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  let container: Record<string, unknown> = obj;
  if (
    obj.result !== undefined &&
    obj.result !== null &&
    typeof obj.result === 'object' &&
    !Array.isArray(obj.result)
  ) {
    container = obj.result as Record<string, unknown>;
  }

  const decision =
    container.decision ??
    container.allow ??
    container.verdict ??
    (typeof obj.result === 'boolean' || typeof obj.result === 'string' ? obj.result : undefined) ??
    obj.allow ??
    obj.decision;
  const reason = container.reason ?? container.reasons ?? container.message ?? obj.reason ?? obj.message;

  process.stdout.write(`${chalk.bold('Decision')}  ${decisionColor(decision)}\n`);

  if (reason !== undefined && reason !== null && reason !== '') {
    if (Array.isArray(reason)) {
      process.stdout.write(`${chalk.bold('Reason')}\n`);
      for (const r of reason) process.stdout.write(`  • ${String(r)}\n`);
    } else if (typeof reason === 'object') {
      process.stdout.write(`${chalk.bold('Reason')}\n${JSON.stringify(reason, null, 2)}\n`);
    } else {
      process.stdout.write(`${chalk.bold('Reason')}    ${String(reason)}\n`);
    }
  }

  const handled = new Set(['allow', 'decision', 'result', 'output', 'reason', 'reasons', 'message', 'verdict']);
  const interesting = Object.entries(obj).filter(([k, v]) => {
    if (handled.has(k)) return false;
    if (v === undefined || v === null) return false;
    if (Array.isArray(v)) return false;
    if (typeof v === 'object') return false;
    return true;
  });
  if (interesting.length) {
    process.stdout.write(`\n${chalk.bold('Flags')}\n`);
    for (const [k, v] of interesting) {
      process.stdout.write(`  ${chalk.cyan(k.padEnd(16))}  ${String(v)}\n`);
    }
  }
}

async function runTest(
  policyFile: string | undefined,
  opts: { input: string; agent?: string },
  cmd: Command,
): Promise<void> {
  const { client, format } = await getContext(cmd);

  let rego: string;
  if (policyFile) {
    rego = await fs.readFile(path.resolve(policyFile), 'utf8');
  } else {
    const agentId = await resolveAgentId(client, opts.agent);
    const current = await fetchCurrentPolicy(client, agentId);
    if (!current) {
      throw new Error('No local policy file provided and no current policy deployed for this agent.');
    }
    rego = current.rego_code;
  }
  if (!rego.trim()) throw new Error('Rego policy is empty.');

  const inputPath = path.resolve(opts.input);
  const inputRaw = await fs.readFile(inputPath, 'utf8');
  let input: unknown;
  try {
    input = JSON.parse(inputRaw);
  } catch (err) {
    throw new Error(`Input file ${inputPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const res = await client.request('POST', '/policy/evaluate', { body: { policy: rego, input } });

  if (format === 'json') {
    printResult(res.data, { format });
    return;
  }

  printEvaluationResult(res.data);
}

export function registerPolicyCommands(program: Command): void {
  const policy = program.command('policy').description('OPA/Rego policies (AUTHORIZE)');

  policy
    .command('pull [file]')
    .description('Download current Rego to stdout or file')
    .option('--agent <agentId>', 'Agent ID (auto-picks if you only have one agent)')
    .option('--include-meta', 'Prefix output with a metadata comment header')
    .action(async (file: string | undefined, opts: { agent?: string; includeMeta?: boolean }, cmd: Command) => {
      await runPull(file, opts, cmd);
    });

  policy
    .command('push <file>')
    .description('Upload Rego; validate syntax before deploy')
    .option('--agent <agentId>', 'Agent ID (auto-picks if you only have one agent)')
    .option('--name <name>', 'Policy name (defaults to current policy name or filename)')
    .option('--description <text>', 'Policy description')
    .option('--input <jsonFile>', 'Test input JSON file used for validation (defaults to current policy input)')
    .option('--skip-validate', 'Skip /policy/evaluate syntax check before deploying')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      async (
        file: string,
        opts: {
          agent?: string;
          name?: string;
          description?: string;
          input?: string;
          skipValidate?: boolean;
          yes?: boolean;
        },
        cmd: Command,
      ) => {
        await runPush(file, opts, cmd);
      },
    );

  policy
    .command('diff [file]')
    .description('Diff local file vs deployed version (default ./policy.rego)')
    .option('--agent <agentId>', 'Agent ID (auto-picks if you only have one agent)')
    .action(async (file: string | undefined, opts: { agent?: string }, cmd: Command) => {
      await runDiff(file, opts, cmd);
    });

  policy
    .command('test [policyFile]')
    .description('Evaluate policy against test input; show decision + reason')
    .requiredOption('--input <jsonFile>', 'Path to JSON file containing the input document')
    .option('--agent <agentId>', 'Agent ID for fetching current deployed policy (when no policyFile given)')
    .action(
      async (
        policyFile: string | undefined,
        opts: { input: string; agent?: string },
        cmd: Command,
      ) => {
        await runTest(policyFile, opts, cmd);
      },
    );
}
