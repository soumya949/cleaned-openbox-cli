import type { Command } from 'commander';

import chalk from 'chalk';
import Table from 'cli-table3';

import { readConfig, resolveBaseUrl } from '../lib/config';
import { OpenBoxClient } from '../lib/openboxClient';
import { prompt } from '../lib/prompt';
import type { OutputFormat } from '../lib/output';

export type GlobalOpts = {
  json?: boolean;
  baseUrl?: string;
  token?: string;
};

export type ClientContext = {
  client: OpenBoxClient;
  format: OutputFormat;
};

export async function getContext(cmd: Command): Promise<ClientContext> {
  const g = (cmd.optsWithGlobals() as GlobalOpts) ?? {};
  const cfg = await readConfig();
  const baseUrl = (g.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
  const token = g.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;
  return {
    client: new OpenBoxClient({ baseUrl, token }),
    format: g.json ? 'json' : 'pretty',
  };
}

export function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

export function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  }
  return undefined;
}

export function unwrapData<T = Record<string, unknown>>(data: unknown): T | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  let obj = data as Record<string, unknown>;
  for (let i = 0; i < 4; i += 1) {
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
      obj = obj.data as Record<string, unknown>;
    } else {
      break;
    }
  }
  return obj as unknown as T;
}

export function extractArray(data: unknown, innerKeys: string[] = ['data', 'items', 'results']): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;

  for (const key of innerKeys) {
    const v = obj[key];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  for (const key of [...innerKeys, 'approvals', 'pending', 'history']) {
    const v = obj[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const innerKey of innerKeys) {
        const iv = (v as Record<string, unknown>)[innerKey];
        if (Array.isArray(iv)) return iv as Record<string, unknown>[];
      }
    }
  }
  return [];
}

export async function fetchAgents(client: OpenBoxClient): Promise<Record<string, unknown>[]> {
  const res = await client.request('GET', '/agent/list', { query: { all: 'true' } });
  return extractArray(res.data);
}

export async function resolveAgentId(
  client: OpenBoxClient,
  provided?: string,
  opts: { silent?: boolean } = {},
): Promise<{ id: string; name?: string }> {
  if (provided) return { id: provided };
  const agents = await fetchAgents(client);
  if (agents.length === 0) {
    throw new Error('No agents found. Register one first with `openbox agent register`.');
  }
  if (agents.length === 1) {
    const id = pickString(agents[0], ['id', 'agent_id']);
    if (!id) throw new Error('Could not determine agent ID from agent list.');
    const name = pickString(agents[0], ['agent_name', 'name']);
    if (!opts.silent) {
      process.stdout.write(chalk.gray(`Using agent ${id} (${name ?? '-'})\n`));
    }
    return { id, name };
  }
  process.stdout.write(chalk.yellow('Multiple agents found. Please choose one:\n'));
  const table = new Table({ head: [chalk.cyan('#'), chalk.cyan('Agent ID'), chalk.cyan('Name')] });
  agents.forEach((a, i) => {
    table.push([
      String(i + 1),
      pickString(a, ['id', 'agent_id']) ?? '-',
      pickString(a, ['agent_name', 'name']) ?? '-',
    ]);
  });
  process.stdout.write(`${table.toString()}\n`);
  while (true) {
    const raw = (await prompt('Pick # or paste agent ID: ')).trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= agents.length) {
      return {
        id: pickString(agents[n - 1], ['id', 'agent_id']) ?? raw,
        name: pickString(agents[n - 1], ['agent_name', 'name']),
      };
    }
    if (raw) return { id: raw };
  }
}

export async function fetchOrgId(client: OpenBoxClient): Promise<string | undefined> {
  try {
    const res = await client.request('GET', '/auth/profile');
    const profile = unwrapData<Record<string, unknown>>(res.data);
    if (!profile) return undefined;
    return pickString(profile, ['orgId', 'org_id', 'organizationId', 'organization_id']);
  } catch {
    return undefined;
  }
}

export function formatDate(value: unknown): string {
  if (!value) return '-';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return String(value);
  }
  return '-';
}

export function formatTime(value: unknown): string {
  const iso = formatDate(value);
  if (iso === '-') return iso;
  return iso.replace(/\.\d+Z$/, 'Z').replace('T', ' ');
}

export async function confirm(question: string): Promise<boolean> {
  const raw = (await prompt(`${question} (yes/no): `)).trim().toLowerCase();
  return raw === 'y' || raw === 'yes';
}
