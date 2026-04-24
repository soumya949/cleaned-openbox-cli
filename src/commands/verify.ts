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

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  }
  return undefined;
}

function extractArrayFromEnvelope(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  for (const key of ['data', 'items', 'results']) {
    const v = obj[key];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = extractArrayFromEnvelope(v);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function unwrapData<T = Record<string, unknown>>(data: unknown): T | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  let obj = data as Record<string, unknown>;
  for (let i = 0; i < 3; i += 1) {
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
      obj = obj.data as Record<string, unknown>;
    } else {
      break;
    }
  }
  return obj as unknown as T;
}

function formatDate(value: unknown): string {
  if (!value) return '-';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return String(value);
  }
  return '-';
}

function formatTime(value: unknown): string {
  const iso = formatDate(value);
  if (iso === '-') return iso;
  return iso.replace(/\.\d+Z$/, 'Z').replace('T', ' ');
}

function scoreColor(score: number | undefined): string {
  if (score === undefined) return chalk.gray('-');
  const s = score > 1 ? score : score * 100;
  const rounded = Math.round(s * 10) / 10;
  if (s >= 80) return chalk.green(`${rounded}%`);
  if (s >= 60) return chalk.cyan(`${rounded}%`);
  if (s >= 40) return chalk.yellow(`${rounded}%`);
  return chalk.red(`${rounded}%`);
}

function percentBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  if (clamped >= 80) return chalk.green(bar);
  if (clamped >= 60) return chalk.cyan(bar);
  if (clamped >= 40) return chalk.yellow(bar);
  return chalk.red(bar);
}

async function resolveAgentId(client: OpenBoxClient, provided?: string): Promise<{ id: string; name?: string }> {
  if (provided) return { id: provided };
  const res = await client.request('GET', '/agent/list', { query: { all: 'true' } });
  const agents = extractArrayFromEnvelope(res.data);
  if (agents.length === 0) {
    throw new Error('No agents found. Register one first with `openbox agent register`.');
  }
  if (agents.length === 1) {
    const id = pickString(agents[0], ['id', 'agent_id']);
    if (!id) throw new Error('Could not determine agent ID from agent list.');
    const name = pickString(agents[0], ['agent_name', 'name']);
    process.stdout.write(chalk.gray(`Using agent ${id} (${name ?? '-'})\n`));
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

async function fetchAgentDetail(client: OpenBoxClient, agentId: string): Promise<Record<string, unknown> | undefined> {
  const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}`);
  return unwrapData(res.data);
}

async function fetchTrend(
  client: OpenBoxClient,
  agentId: string,
  fromTime?: string,
  toTime?: string,
): Promise<Record<string, unknown>[]> {
  const query: Record<string, string> = {};
  if (fromTime) query.fromTime = fromTime;
  if (toTime) query.toTime = toTime;
  const res = await client.request(
    'GET',
    `/agent/${encodeURIComponent(agentId)}/goal-alignment/trend`,
    Object.keys(query).length ? { query } : undefined,
  );
  return extractArrayFromEnvelope(res.data);
}

async function fetchRecentDrifts(
  client: OpenBoxClient,
  agentId: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}/goal-alignment/recent-drifts`, {
    query: { limit: String(limit) },
  });
  return extractArrayFromEnvelope(res.data);
}

async function fetchSessionList(
  client: OpenBoxClient,
  agentId: string,
  page = 0,
  perPage = 20,
): Promise<Record<string, unknown>[]> {
  const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}/sessions`, {
    query: { page: String(page), perPage: String(perPage) },
  });
  return extractArrayFromEnvelope(res.data);
}

async function fetchSession(client: OpenBoxClient, agentId: string, sessionId: string): Promise<Record<string, unknown> | undefined> {
  const res = await client.request(
    'GET',
    `/agent/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
  );
  return unwrapData(res.data);
}

function printTrendSparkline(trend: Record<string, unknown>[]): void {
  if (trend.length === 0) {
    process.stdout.write(chalk.gray('(no trend data)\n'));
    return;
  }
  const table = new Table({
    head: [
      chalk.cyan('Date'),
      chalk.cyan('Evaluations'),
      chalk.cyan('Aligned'),
      chalk.cyan('Drifted'),
      chalk.cyan('Alignment'),
      chalk.cyan('                    '),
    ],
  });
  for (const row of trend) {
    const date = pickString(row, ['date']) ?? '-';
    const shortDate = date.length >= 10 ? date.slice(0, 10) : date;
    const total = pickNumber(row, ['total_evaluations']);
    const aligned = pickNumber(row, ['aligned_count']);
    const drifted = pickNumber(row, ['drifted_count']);
    const pct = pickNumber(row, ['alignment_percentage']);
    table.push([
      shortDate,
      total !== undefined ? String(total) : '-',
      aligned !== undefined ? chalk.green(String(aligned)) : '-',
      drifted !== undefined ? (drifted > 0 ? chalk.red(String(drifted)) : chalk.gray('0')) : '-',
      pct !== undefined ? scoreColor(pct) : '-',
      pct !== undefined ? percentBar(pct) : '',
    ]);
  }
  process.stdout.write(`${table.toString()}\n`);
}

function printDriftEventsTable(drifts: Record<string, unknown>[]): void {
  if (drifts.length === 0) {
    process.stdout.write(chalk.green('\n✓ No recent drift events.\n'));
    return;
  }

  process.stdout.write(`\n${chalk.bold(`Drift events (${drifts.length})`)}\n`);
  const table = new Table({
    head: [
      chalk.cyan('When'),
      chalk.cyan('Session'),
      chalk.cyan('Event'),
      chalk.cyan('Alignment'),
      chalk.cyan('Reason'),
    ],
    wordWrap: true,
    colWidths: [21, 18, 18, 10, 60],
  });
  for (const d of drifts) {
    const when = formatTime(d.evaluated_at);
    const sid = pickString(d, ['session_id']) ?? '-';
    const eid = pickString(d, ['governance_event_id', 'event_id', 'id']) ?? '-';
    const pct = pickNumber(d, ['alignment_percentage']);
    const reason = pickString(d, ['reason']) ?? '-';
    table.push([
      when,
      sid.length > 16 ? `${sid.slice(0, 15)}…` : sid,
      eid.length > 16 ? `${eid.slice(0, 15)}…` : eid,
      pct !== undefined ? scoreColor(pct) : '-',
      reason.length > 200 ? `${reason.slice(0, 200)}…` : reason,
    ]);
  }
  process.stdout.write(`${table.toString()}\n`);
}

async function runAlignment(
  opts: { agent?: string; limit?: string; fromTime?: string; toTime?: string },
  cmd: Command,
): Promise<void> {
  const { client, format } = await getContext(cmd);
  const { id: agentId, name } = await resolveAgentId(client, opts.agent);

  const [detail, trend, drifts] = await Promise.all([
    fetchAgentDetail(client, agentId),
    fetchTrend(client, agentId, opts.fromTime, opts.toTime),
    fetchRecentDrifts(client, agentId, opts.limit ? Number(opts.limit) : 10),
  ]);

  if (format === 'json') {
    printResult({ agent: detail, trend, recent_drifts: drifts }, { format });
    return;
  }

  const trustObj = (() => {
    if (!detail) return undefined;
    const t = (detail.agent_trust_score ?? detail.trustScore) as Record<string, unknown> | undefined;
    if (t && typeof t === 'object' && !Array.isArray(t)) return t;
    return undefined;
  })();

  const alignmentScore = pickNumber(trustObj ?? {}, ['alignment_consistency', 'alignmentConsistency']);
  const trustScore = pickNumber(trustObj ?? {}, ['trust_score', 'trustScore']);
  const trustTier = trustObj?.trust_tier ?? detail?.trust_tier;
  const lastCalc = trustObj?.last_calculated_at ?? trustObj?.updated_at;

  process.stdout.write(`${chalk.bold('\nAlignment & Attestation')}  ${chalk.gray(agentId)}`);
  if (name) process.stdout.write(chalk.gray(`  (${name})`));
  process.stdout.write('\n\n');

  process.stdout.write(`${chalk.bold('Current alignment score')}\n`);
  process.stdout.write(
    `  ${chalk.cyan('Alignment consistency'.padEnd(24))}  ${scoreColor(alignmentScore)}  ${alignmentScore !== undefined ? percentBar(alignmentScore) : ''}\n`,
  );
  if (trustScore !== undefined) {
    process.stdout.write(`  ${chalk.cyan('Trust score'.padEnd(24))}  ${scoreColor(trustScore)}\n`);
  }
  if (trustTier !== undefined && trustTier !== null) {
    process.stdout.write(`  ${chalk.cyan('Trust tier'.padEnd(24))}  T${trustTier}\n`);
  }
  if (lastCalc) {
    process.stdout.write(`  ${chalk.cyan('Last calculated'.padEnd(24))}  ${formatDate(lastCalc)}\n`);
  }

  process.stdout.write(`\n${chalk.bold('Trend')}\n`);
  printTrendSparkline(trend);

  printDriftEventsTable(drifts);
}

type ProofRecord = {
  session_id: string;
  session_started_at?: string;
  session_completed_at?: string;
  session_status?: string;
  merkle_root?: string;
  signature?: string;
  event_count?: number;
  public_key?: string;
  attestation_id?: string;
  attestation_mode?: string;
  attestation_domain?: string;
  raw: Record<string, unknown>;
};

function extractAttestation(session: Record<string, unknown>, agent?: Record<string, unknown>): ProofRecord {
  const att = (session.attestation ?? session.attestations) as Record<string, unknown> | undefined;
  return {
    session_id: pickString(session, ['id', 'session_id']) ?? '-',
    session_started_at: pickString(session, ['started_at', 'created_at']),
    session_completed_at: pickString(session, ['completed_at']),
    session_status: pickString(session, ['status']),
    merkle_root: att && typeof att === 'object' ? pickString(att, ['merkle_root', 'merkleRoot']) : undefined,
    signature: att && typeof att === 'object' ? pickString(att, ['signature']) : undefined,
    event_count: att && typeof att === 'object' ? pickNumber(att, ['event_count', 'eventCount']) : undefined,
    public_key:
      att && typeof att === 'object' && att.metadata && typeof att.metadata === 'object'
        ? pickString(att.metadata as Record<string, unknown>, ['public_key', 'publicKey'])
        : undefined,
    attestation_id: att && typeof att === 'object' ? pickString(att, ['id']) : undefined,
    attestation_mode: agent ? pickString(agent, ['attestation_mode']) : undefined,
    attestation_domain: agent ? pickString(agent, ['attestation_domain']) : undefined,
    raw: att && typeof att === 'object' && !Array.isArray(att) ? (att as Record<string, unknown>) : {},
  };
}

function printProof(proof: ProofRecord): void {
  process.stdout.write(`${chalk.bold('Attestation proof')}  ${chalk.gray(proof.session_id)}\n`);
  if (proof.session_status) {
    process.stdout.write(`  ${chalk.cyan('Session status'.padEnd(22))}  ${proof.session_status}\n`);
  }
  if (proof.session_started_at) {
    process.stdout.write(`  ${chalk.cyan('Session started'.padEnd(22))}  ${formatDate(proof.session_started_at)}\n`);
  }
  if (proof.session_completed_at) {
    process.stdout.write(`  ${chalk.cyan('Session completed'.padEnd(22))}  ${formatDate(proof.session_completed_at)}\n`);
  }
  if (proof.attestation_mode) {
    process.stdout.write(`  ${chalk.cyan('Attestation mode'.padEnd(22))}  ${proof.attestation_mode}\n`);
  }
  if (proof.attestation_domain) {
    process.stdout.write(`  ${chalk.cyan('Attestation domain'.padEnd(22))}  ${proof.attestation_domain}\n`);
  }

  if (!proof.merkle_root && !proof.signature && !proof.event_count) {
    process.stdout.write(chalk.yellow('\n  No attestation data on this session.\n'));
    return;
  }

  process.stdout.write('\n');
  if (proof.event_count !== undefined) {
    process.stdout.write(`  ${chalk.cyan('Event count'.padEnd(22))}  ${chalk.bold(String(proof.event_count))}\n`);
  }
  if (proof.merkle_root) {
    process.stdout.write(`  ${chalk.cyan('Merkle root'.padEnd(22))}  ${chalk.green(proof.merkle_root)}\n`);
  }
  if (proof.signature) {
    process.stdout.write(`  ${chalk.cyan('ECDSA signature'.padEnd(22))}  ${chalk.green(proof.signature)}\n`);
  }
  if (proof.public_key) {
    process.stdout.write(`  ${chalk.cyan('Public key'.padEnd(22))}\n`);
    for (const line of proof.public_key.split(/\r?\n/)) {
      process.stdout.write(`    ${chalk.gray(line)}\n`);
    }
  }
  if (proof.attestation_id) {
    process.stdout.write(`  ${chalk.cyan('Attestation ID'.padEnd(22))}  ${chalk.gray(proof.attestation_id)}\n`);
  }
}

async function runProof(
  opts: { agent?: string; session?: string; all?: boolean; limit?: string },
  cmd: Command,
): Promise<void> {
  const { client, format } = await getContext(cmd);
  const { id: agentId } = await resolveAgentId(client, opts.agent);

  const agent = await fetchAgentDetail(client, agentId);

  let sessionIds: string[] = [];
  if (opts.session) {
    sessionIds = [opts.session];
  } else {
    const limit = opts.all ? 50 : Number(opts.limit ?? 1);
    const sessions = await fetchSessionList(client, agentId, 0, Math.max(1, Math.min(limit, 100)));
    sessionIds = sessions
      .map((s) => pickString(s, ['id', 'session_id']))
      .filter((v): v is string => typeof v === 'string' && v.length > 0);

    if (sessionIds.length === 0) {
      process.stdout.write(chalk.yellow('No sessions found for this agent.\n'));
      return;
    }
  }

  const proofs: ProofRecord[] = [];
  for (const sid of sessionIds) {
    const session = await fetchSession(client, agentId, sid);
    if (session) proofs.push(extractAttestation(session, agent));
  }

  if (format === 'json') {
    printResult(proofs.length === 1 ? proofs[0] : proofs, { format });
    return;
  }

  if (proofs.length === 1) {
    printProof(proofs[0]);
    return;
  }

  process.stdout.write(`${chalk.bold(`Attestation proofs (${proofs.length} sessions)`)}\n\n`);
  const table = new Table({
    head: [
      chalk.cyan('Session'),
      chalk.cyan('Events'),
      chalk.cyan('Merkle root'),
      chalk.cyan('Signature'),
      chalk.cyan('Completed'),
    ],
    wordWrap: false,
    colWidths: [18, 8, 26, 26, 22],
  });
  for (const p of proofs) {
    table.push([
      p.session_id.length > 16 ? `${p.session_id.slice(0, 15)}…` : p.session_id,
      p.event_count !== undefined ? String(p.event_count) : '-',
      p.merkle_root ? `${p.merkle_root.slice(0, 22)}…` : chalk.gray('(none)'),
      p.signature ? `${p.signature.slice(0, 22)}…` : chalk.gray('(none)'),
      formatTime(p.session_completed_at ?? p.session_started_at),
    ]);
  }
  process.stdout.write(`${table.toString()}\n`);
  process.stdout.write(chalk.gray('\nUse `openbox verify proof --session <id>` to see full Merkle root + signature.\n'));
}

type Certificate = {
  certificate_version: string;
  generated_at: string;
  generated_by?: string;
  api_base_url: string;
  organization?: { id?: string; name?: string };
  agent: {
    id: string;
    name?: string;
    type?: string;
    model_name?: string;
    description?: string;
    attestation_mode?: string;
    attestation_domain?: string;
    created_at?: string;
    updated_at?: string;
  };
  trust: {
    trust_score?: number;
    trust_tier?: unknown;
    alignment_consistency?: number;
    behavioral_compliance?: number;
    aivss_baseline?: number;
    last_calculated_at?: string;
  };
  alignment: {
    trend: Record<string, unknown>[];
    recent_drifts: Record<string, unknown>[];
  };
  policy?: Record<string, unknown>;
  behavioral_rules?: Record<string, unknown>[];
  sessions: ProofRecord[];
  integrity: {
    total_sessions: number;
    sessions_with_proof: number;
    total_attested_events: number;
  };
};

async function fetchCurrentPolicy(client: OpenBoxClient, agentId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}/policies/current`);
    return unwrapData(res.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404')) return undefined;
    throw err;
  }
}

async function fetchRules(client: OpenBoxClient, agentId: string): Promise<Record<string, unknown>[]> {
  try {
    const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}/behavior-rule`, {
      query: { page: '0', perPage: '100' },
    });
    return extractArrayFromEnvelope(res.data);
  } catch {
    return [];
  }
}

async function fetchWhoami(client: OpenBoxClient): Promise<{ user?: string; org?: string } | undefined> {
  try {
    const res = await client.request('GET', '/organization/me/user');
    const u = unwrapData<Record<string, unknown>>(res.data);
    if (!u) return undefined;
    const user = pickString(u, ['email', 'preferred_username', 'username', 'name']);
    const orgRaw = u.organization ?? u.org;
    const org =
      orgRaw && typeof orgRaw === 'object' ? pickString(orgRaw as Record<string, unknown>, ['name', 'id']) : undefined;
    return { user, org };
  } catch {
    return undefined;
  }
}

async function runExport(
  opts: { agent?: string; out?: string; sessionLimit?: string; includePolicy?: boolean; includeRules?: boolean },
  cmd: Command,
): Promise<void> {
  const { client, format } = await getContext(cmd);
  const { id: agentId, name } = await resolveAgentId(client, opts.agent);

  const sessionLimit = Math.max(1, Math.min(Number(opts.sessionLimit ?? 50), 200));
  const includePolicy = opts.includePolicy !== false;
  const includeRules = opts.includeRules !== false;

  process.stdout.write(chalk.gray('Collecting agent, trust, alignment data...\n'));
  const [agent, trend, drifts, sessions, whoami, policy, rules] = await Promise.all([
    fetchAgentDetail(client, agentId),
    fetchTrend(client, agentId),
    fetchRecentDrifts(client, agentId, 50),
    fetchSessionList(client, agentId, 0, sessionLimit),
    fetchWhoami(client),
    includePolicy ? fetchCurrentPolicy(client, agentId) : Promise.resolve(undefined),
    includeRules ? fetchRules(client, agentId) : Promise.resolve([]),
  ]);

  process.stdout.write(chalk.gray(`Gathering attestations from ${sessions.length} session(s)...\n`));
  const proofs: ProofRecord[] = [];
  for (const s of sessions) {
    const sid = pickString(s, ['id', 'session_id']);
    if (!sid) continue;
    const detail = await fetchSession(client, agentId, sid);
    if (detail) proofs.push(extractAttestation(detail, agent));
  }

  const trustObj = (() => {
    if (!agent) return undefined;
    const t = agent.agent_trust_score as Record<string, unknown> | undefined;
    return t && typeof t === 'object' && !Array.isArray(t) ? t : undefined;
  })();

  const cert: Certificate = {
    certificate_version: '1.0',
    generated_at: new Date().toISOString(),
    generated_by: whoami?.user,
    api_base_url: ((await readConfig()).baseUrl ?? 'https://openbox-api.node.lat').replace(/\/$/, ''),
    organization: whoami?.org ? { name: whoami.org } : undefined,
    agent: {
      id: agentId,
      name: name ?? (agent ? pickString(agent, ['agent_name', 'name']) : undefined),
      type: agent ? pickString(agent, ['agent_type']) : undefined,
      model_name: agent ? pickString(agent, ['model_name']) : undefined,
      description: agent ? pickString(agent, ['description']) : undefined,
      attestation_mode: agent ? pickString(agent, ['attestation_mode']) : undefined,
      attestation_domain: agent ? pickString(agent, ['attestation_domain']) : undefined,
      created_at: agent ? pickString(agent, ['created_at']) : undefined,
      updated_at: agent ? pickString(agent, ['updated_at']) : undefined,
    },
    trust: {
      trust_score: trustObj ? pickNumber(trustObj, ['trust_score']) : undefined,
      trust_tier: trustObj?.trust_tier,
      alignment_consistency: trustObj ? pickNumber(trustObj, ['alignment_consistency']) : undefined,
      behavioral_compliance: trustObj ? pickNumber(trustObj, ['behavioral_compliance']) : undefined,
      aivss_baseline: trustObj ? pickNumber(trustObj, ['aivss_baseline']) : undefined,
      last_calculated_at: trustObj ? pickString(trustObj, ['last_calculated_at']) : undefined,
    },
    alignment: {
      trend,
      recent_drifts: drifts,
    },
    policy,
    behavioral_rules: rules,
    sessions: proofs,
    integrity: {
      total_sessions: proofs.length,
      sessions_with_proof: proofs.filter((p) => Boolean(p.merkle_root && p.signature)).length,
      total_attested_events: proofs.reduce((acc, p) => acc + (p.event_count ?? 0), 0),
    },
  };

  const json = JSON.stringify(cert, null, 2);

  if (format === 'json') {
    process.stdout.write(`${json}\n`);
    return;
  }

  const outPath = opts.out ?? `openbox-proof-${agentId}-${new Date().toISOString().slice(0, 10)}.json`;
  const resolved = path.resolve(outPath);
  await fs.writeFile(resolved, json, 'utf8');

  process.stdout.write(`${chalk.green('✓ Proof certificate exported.')}\n`);
  process.stdout.write(`  ${chalk.cyan('File'.padEnd(22))}  ${resolved}\n`);
  process.stdout.write(`  ${chalk.cyan('Size'.padEnd(22))}  ${json.length.toLocaleString()} bytes\n`);
  process.stdout.write(`  ${chalk.cyan('Sessions'.padEnd(22))}  ${cert.integrity.total_sessions}\n`);
  process.stdout.write(
    `  ${chalk.cyan('Sessions with proof'.padEnd(22))}  ${cert.integrity.sessions_with_proof}\n`,
  );
  process.stdout.write(
    `  ${chalk.cyan('Attested events'.padEnd(22))}  ${cert.integrity.total_attested_events}\n`,
  );
  if (cert.policy) {
    process.stdout.write(`  ${chalk.cyan('Policy included'.padEnd(22))}  ${chalk.green('yes')}\n`);
  }
  if (cert.behavioral_rules && cert.behavioral_rules.length > 0) {
    process.stdout.write(
      `  ${chalk.cyan('Behavioral rules'.padEnd(22))}  ${cert.behavioral_rules.length}\n`,
    );
  }
}

export function registerVerifyCommands(program: Command): void {
  const verify = program.command('verify').description('Alignment & attestation (VERIFY)');

  verify
    .command('alignment')
    .description('Current alignment score, trend, drift events table')
    .option('--agent <agentId>', 'Agent ID (auto-picks if you only have one agent)')
    .option('--limit <n>', 'Max drift events to show', '10')
    .option('--from <iso>', 'Trend start time (ISO 8601)')
    .option('--to <iso>', 'Trend end time (ISO 8601)')
    .action(
      async (
        opts: { agent?: string; limit?: string; from?: string; to?: string },
        cmd: Command,
      ) => {
        await runAlignment({ ...opts, fromTime: opts.from, toTime: opts.to }, cmd);
      },
    );

  verify
    .command('proof')
    .description('Show Merkle root, ECDSA signature, event count')
    .option('--agent <agentId>', 'Agent ID (auto-picks if you only have one agent)')
    .option('--session <sessionId>', 'Specific session ID (default: most recent session)')
    .option('--limit <n>', 'Number of recent sessions to summarize', '1')
    .option('--all', 'Include up to 50 most recent sessions in a summary table')
    .action(
      async (
        opts: { agent?: string; session?: string; all?: boolean; limit?: string },
        cmd: Command,
      ) => {
        await runProof(opts, cmd);
      },
    );

  verify
    .command('export')
    .description('Export proof certificate (JSON) for compliance/legal use')
    .option('--agent <agentId>', 'Agent ID (auto-picks if you only have one agent)')
    .option('--out <file>', 'Output file path (default: openbox-proof-<agentId>-<date>.json)')
    .option('--session-limit <n>', 'Max number of sessions to attest in the bundle', '50')
    .option('--no-policy', 'Omit the currently deployed Rego policy from the certificate')
    .option('--no-rules', 'Omit behavioral rules from the certificate')
    .action(
      async (
        opts: { agent?: string; out?: string; sessionLimit?: string; policy?: boolean; rules?: boolean },
        cmd: Command,
      ) => {
        await runExport(
          {
            agent: opts.agent,
            out: opts.out,
            sessionLimit: opts.sessionLimit,
            includePolicy: opts.policy !== false,
            includeRules: opts.rules !== false,
          },
          cmd,
        );
      },
    );
}
