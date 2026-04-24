import type { Command } from 'commander';

import chalk from 'chalk';
import Table from 'cli-table3';

import { OpenBoxClient } from '../lib/openboxClient';
import { printResult } from '../lib/output';
import { prompt } from '../lib/prompt';
import {
  confirm,
  extractArray,
  fetchOrgId,
  formatTime,
  getContext,
  pickNumber,
  pickString,
  resolveAgentId,
  unwrapData,
} from './_adaptHelpers';

function normalizeAgentOpt(value: unknown): { scoped: boolean; agentId?: string } {
  if (typeof value === 'string' && value.trim()) {
    return { scoped: true, agentId: value.trim() };
  }
  if (value === true) {
    return { scoped: true };
  }
  return { scoped: false };
}

type ApprovalRow = {
  id: string;
  agent_id?: string;
  session_id?: string;
  activity_type?: string;
  reason?: string;
  status?: string;
  trust_tier?: unknown;
  semantic_type?: string;
  decided_at?: string;
  decided_by?: string;
  approval_expires_at?: string;
  created_at?: string;
  updated_at?: string;
  raw: Record<string, unknown>;
};

function normalizeApproval(row: Record<string, unknown>): ApprovalRow {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    id: pickString(row, ['id', 'event_id']) ?? '-',
    agent_id: pickString(row, ['agent_id']),
    session_id: pickString(row, ['session_id']),
    activity_type: pickString(row, ['activity_type']),
    reason: pickString(row, ['reason']),
    status: pickString(row, ['status', 'workflow_status']),
    trust_tier: meta.trust_tier ?? row.trust_tier,
    semantic_type: pickString(row, ['semantic_type']) ?? pickString(meta, ['semantic_type']),
    decided_at: pickString(row, ['decided_at']),
    decided_by: pickString(row, ['decided_by']),
    approval_expires_at: pickString(row, ['approval_expired_at', 'approval_expires_at']),
    created_at: pickString(row, ['created_at']),
    updated_at: pickString(row, ['updated_at']),
    raw: row,
  };
}

function tierBadge(tier: unknown): string {
  if (tier === undefined || tier === null || tier === '') return chalk.gray('-');
  const label = String(tier);
  const n = Number(label);
  if (n === 1) return chalk.green(`T1`);
  if (n === 2) return chalk.cyan(`T2`);
  if (n === 3) return chalk.yellow(`T3`);
  if (n === 4) return chalk.magenta(`T4`);
  if (n === 5) return chalk.red(`T5`);
  return chalk.white(label);
}

function statusBadge(status: unknown): string {
  const s = String(status ?? '').toLowerCase();
  if (s === 'pending' || s === 'in_review') return chalk.yellow('pending');
  if (s === 'approved') return chalk.green('approved');
  if (s === 'rejected' || s === 'denied') return chalk.red('rejected');
  if (s === 'expired') return chalk.gray('expired');
  if (s === 'escalated') return chalk.magenta('escalated');
  if (s === 'completed') return chalk.green('completed');
  if (!s) return chalk.gray('-');
  return s;
}

function printApprovalsTable(rows: ApprovalRow[]): void {
  if (rows.length === 0) {
    process.stdout.write(chalk.green('✓ No approvals.\n'));
    return;
  }
  const table = new Table({
    head: [
      chalk.cyan('Event ID'),
      chalk.cyan('Agent'),
      chalk.cyan('Session'),
      chalk.cyan('Activity / Semantic'),
      chalk.cyan('Risk'),
      chalk.cyan('Status'),
      chalk.cyan('Reason'),
      chalk.cyan('Expires'),
    ],
    wordWrap: true,
    colWidths: [20, 18, 18, 22, 6, 12, 36, 22],
  });
  for (const r of rows) {
    const id = r.id;
    const agentId = r.agent_id ?? '-';
    const sessionId = r.session_id ?? '-';
    const activity = r.semantic_type ?? r.activity_type ?? '-';
    table.push([
      id.length > 18 ? `${id.slice(0, 17)}…` : id,
      agentId.length > 16 ? `${agentId.slice(0, 15)}…` : agentId,
      sessionId.length > 16 ? `${sessionId.slice(0, 15)}…` : sessionId,
      activity,
      tierBadge(r.trust_tier),
      statusBadge(r.status),
      (r.reason ?? '-').slice(0, 140),
      formatTime(r.approval_expires_at),
    ]);
  }
  process.stdout.write(`${table.toString()}\n`);
}

async function fetchOrgApprovals(
  client: OpenBoxClient,
  orgId: string,
  query: Record<string, string | string[]>,
): Promise<{ rows: ApprovalRow[]; total?: number; start?: number; limit?: number }> {
  const res = await client.request('GET', `/organization/${encodeURIComponent(orgId)}/approvals`, { query });
  const top = unwrapData<Record<string, unknown>>(res.data);
  const approvalsHolder =
    top && top.approvals && typeof top.approvals === 'object'
      ? (top.approvals as Record<string, unknown>)
      : top;
  const raw = approvalsHolder ? extractArray(approvalsHolder) : [];
  const rows = raw.map(normalizeApproval);
  return {
    rows,
    total: approvalsHolder ? pickNumber(approvalsHolder, ['total']) : undefined,
    start: approvalsHolder ? pickNumber(approvalsHolder, ['start', 'page']) : undefined,
    limit: approvalsHolder ? pickNumber(approvalsHolder, ['limit', 'perPage']) : undefined,
  };
}

async function fetchAgentApprovals(
  client: OpenBoxClient,
  agentId: string,
  which: 'pending' | 'history',
  query: Record<string, string | string[]>,
): Promise<{ rows: ApprovalRow[]; total?: number; start?: number; limit?: number }> {
  const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}/approvals/${which}`, { query });
  const top = unwrapData<Record<string, unknown>>(res.data);
  const raw = top ? extractArray(top) : [];
  const rows = raw.map(normalizeApproval);
  return {
    rows,
    total: top ? pickNumber(top, ['total']) : undefined,
    start: top ? pickNumber(top, ['start', 'page']) : undefined,
    limit: top ? pickNumber(top, ['limit', 'perPage']) : undefined,
  };
}

async function findApprovalAgent(
  client: OpenBoxClient,
  eventId: string,
): Promise<string | undefined> {
  const orgId = await fetchOrgId(client);
  if (!orgId) return undefined;
  for (const status of ['pending', 'approved', 'rejected', 'expired']) {
    try {
      const { rows } = await fetchOrgApprovals(client, orgId, { status, perPage: '100' });
      const match = rows.find((r) => r.id === eventId);
      if (match && match.agent_id) return match.agent_id;
    } catch {
      // ignore
    }
  }
  return undefined;
}

async function runList(
  opts: {
    agent?: unknown;
    status?: string;
    tier?: string;
    search?: string;
    page?: string;
    perPage?: string;
    from?: string;
    to?: string;
    history?: boolean;
  },
  cmd: Command,
): Promise<void> {
  const { client, format } = await getContext(cmd);
  const agentOpt = normalizeAgentOpt(opts.agent);

  const query: Record<string, string | string[]> = {};
  if (opts.page !== undefined) query.page = String(opts.page);
  if (opts.perPage !== undefined) query.perPage = String(opts.perPage);
  if (opts.search) query.search = opts.search;
  if (opts.tier) query.tiers = opts.tier.split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.from) query.fromTime = opts.from;
  if (opts.to) query.toTime = opts.to;

  let rows: ApprovalRow[] = [];
  let total: number | undefined;
  let start: number | undefined;
  let limit: number | undefined;
  let scope = 'org-wide';

  if (agentOpt.scoped) {
    const { id: agentId } = await resolveAgentId(client, agentOpt.agentId);
    scope = `agent ${agentId}`;
    const which = opts.history ? 'history' : 'pending';
    if (opts.status && !opts.history) query.status = opts.status;
    const result = await fetchAgentApprovals(client, agentId, which, query);
    rows = result.rows;
    total = result.total;
    start = result.start;
    limit = result.limit;
  } else {
    query.status = opts.status ?? 'pending';
    const orgId = await fetchOrgId(client);
    if (!orgId) {
      throw new Error('Could not determine organization ID. Run `openbox auth whoami` first.');
    }
    const result = await fetchOrgApprovals(client, orgId, query);
    rows = result.rows;
    total = result.total;
    start = result.start;
    limit = result.limit;
  }

  if (format === 'json') {
    printResult(rows.map((r) => r.raw), { format });
    return;
  }

  const scopeLabel =
    scope === 'org-wide'
      ? `Org-wide ${opts.status ?? 'pending'} HITL queue`
      : `Agent-scoped ${opts.history ? 'history' : 'pending'} queue`;
  process.stdout.write(`${chalk.bold(scopeLabel)}\n`);
  printApprovalsTable(rows);

  if (total !== undefined || start !== undefined || limit !== undefined) {
    const parts: string[] = [];
    if (start !== undefined) parts.push(`start ${start}`);
    if (limit !== undefined) parts.push(`limit ${limit}`);
    if (total !== undefined) parts.push(`total ${total}`);
    process.stdout.write(chalk.gray(`\n${parts.join(' · ')}\n`));
  }
}

async function pickEventFromPendingQueue(
  client: OpenBoxClient,
  providedAgentId?: string,
): Promise<{ eventId: string; agentId?: string } | undefined> {
  let rows: ApprovalRow[] = [];
  if (providedAgentId) {
    const { rows: agentRows } = await fetchAgentApprovals(client, providedAgentId, 'pending', {
      perPage: '50',
    });
    rows = agentRows;
  } else {
    const orgId = await fetchOrgId(client);
    if (orgId) {
      const { rows: orgRows } = await fetchOrgApprovals(client, orgId, {
        status: 'pending',
        perPage: '50',
      });
      rows = orgRows;
    }
  }

  if (rows.length === 0) {
    process.stdout.write(chalk.yellow('No pending approvals to pick from.\n'));
    return undefined;
  }

  process.stdout.write(chalk.bold('\nPending approvals:\n'));
  const table = new Table({
    head: [
      chalk.cyan('#'),
      chalk.cyan('Event ID'),
      chalk.cyan('Agent'),
      chalk.cyan('Risk'),
      chalk.cyan('Reason'),
    ],
    wordWrap: true,
    colWidths: [4, 20, 18, 6, 60],
  });
  rows.forEach((r, i) => {
    const id = r.id;
    const agentId = r.agent_id ?? '-';
    table.push([
      String(i + 1),
      id.length > 18 ? `${id.slice(0, 17)}…` : id,
      agentId.length > 16 ? `${agentId.slice(0, 15)}…` : agentId,
      tierBadge(r.trust_tier),
      (r.reason ?? '-').slice(0, 100),
    ]);
  });
  process.stdout.write(`${table.toString()}\n`);

  while (true) {
    const raw = (await prompt('Pick # or paste event ID: ')).trim();
    if (!raw) {
      process.stdout.write('Aborted.\n');
      return undefined;
    }
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= rows.length) {
      const picked = rows[n - 1];
      return { eventId: picked.id, agentId: picked.agent_id };
    }
    return { eventId: raw };
  }
}

async function runDecide(
  action: 'approve' | 'reject' | 'escalate',
  eventIdArg: string | undefined,
  opts: { agent?: unknown; reason?: string; yes?: boolean },
  cmd: Command,
): Promise<void> {
  const { client, format } = await getContext(cmd);

  const agentOpt = normalizeAgentOpt(opts.agent);
  const providedAgentId = agentOpt.scoped ? agentOpt.agentId : undefined;

  let eventId = eventIdArg;
  let discoveredAgentId: string | undefined;
  if (!eventId) {
    const picked = await pickEventFromPendingQueue(client, providedAgentId);
    if (!picked) return;
    eventId = picked.eventId;
    discoveredAgentId = picked.agentId;
  }

  let agentId = providedAgentId ?? discoveredAgentId;
  if (!agentId) {
    process.stdout.write(chalk.gray('Looking up event in the org approvals queue...\n'));
    agentId = await findApprovalAgent(client, eventId);
    if (!agentId) {
      const { id } = await resolveAgentId(client, undefined);
      agentId = id;
    } else {
      process.stdout.write(chalk.gray(`Found on agent ${agentId}\n`));
    }
  }

  if (action === 'reject' && !opts.reason) {
    const r = (await prompt('Reason for rejection (required): ')).trim();
    if (!r) {
      throw new Error('`--reason <text>` is required when rejecting an approval.');
    }
    opts = { ...opts, reason: r };
  }

  if (action === 'escalate') {
    process.stdout.write(
      chalk.yellow(
        'Note: escalate is not a first-class action in the OpenBox API. ' +
          'The CLI will attempt `action=escalate`; if the backend rejects it, use the web UI instead.\n',
      ),
    );
  }

  if (!opts.yes) {
    const verb = { approve: 'Approve', reject: 'Reject', escalate: 'Escalate' }[action];
    process.stdout.write(
      chalk.yellow(`${verb} approval ${chalk.bold(eventId)} on agent ${agentId}.\n`),
    );
    if (opts.reason) process.stdout.write(chalk.gray(`  Reason: ${opts.reason}\n`));
    if (!(await confirm('Proceed?'))) {
      process.stdout.write('Aborted.\n');
      return;
    }
  }

  const query: Record<string, string> = { action };
  const body: Record<string, unknown> | undefined = opts.reason ? { reason: opts.reason } : undefined;

  try {
    const res = await client.request(
      'PUT',
      `/agent/${encodeURIComponent(agentId)}/approvals/${encodeURIComponent(eventId)}/decide`,
      { query, body },
    );
    const verbPast = { approve: 'approved', reject: 'rejected', escalate: 'escalated' }[action];
    process.stdout.write(`${chalk.green(`✓ Approval ${verbPast}.`)}\n`);
    if (action === 'approve') {
      process.stdout.write(chalk.gray('  The blocked operation will now unblock.\n'));
    }
    if (action === 'reject') {
      process.stdout.write(chalk.gray('  The blocked operation has been cancelled.\n'));
    }
    if (res.data && format === 'json') printResult(res.data, { format });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (action === 'escalate' && /40\d/.test(msg)) {
      process.stdout.write(
        chalk.red(
          `✗ Backend rejected \`action=escalate\` (${msg.split('\n')[0]}).\n` +
            `  Use the web UI to escalate: https://openbox.node.lat/approvals\n`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

export function registerApprovalsCommands(program: Command): void {
  const approvals = program.command('approvals').description('HITL approvals queue (ADAPT)');

  approvals
    .command('list')
    .description('Org-wide pending HITL queue with risk tier, semantic type')
    .option(
      '--agent [agentId]',
      'Scope to a single agent. Omit the value to auto-pick (if you only have one).',
    )
    .option('--status <status>', 'pending|approved|rejected|expired', 'pending')
    .option('--tier <tiers>', 'Comma-separated trust tier filter (e.g. 1,2)')
    .option('--search <text>', 'Search in reason/action text')
    .option('--from <iso>', 'Start time (ISO 8601)')
    .option('--to <iso>', 'End time (ISO 8601)')
    .option('--page <n>', 'Page number (starts from 0)')
    .option('--per-page <n>', 'Items per page')
    .option('--history', 'Show decision history (agent-scoped only)')
    .action(
      async (
        opts: {
          agent?: unknown;
          status?: string;
          tier?: string;
          search?: string;
          from?: string;
          to?: string;
          page?: string;
          perPage?: string;
          history?: boolean;
        },
        cmd: Command,
      ) => {
        await runList(opts, cmd);
      },
    );

  approvals
    .command('approve [eventId]')
    .description('Approve pending operation; operation unblocks (omit eventId to pick)')
    .option(
      '--agent [agentId]',
      'Agent ID (auto-discovered from queue if omitted; pass without value to auto-pick)',
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      async (
        eventId: string | undefined,
        opts: { agent?: unknown; yes?: boolean },
        cmd: Command,
      ) => {
        await runDecide('approve', eventId, opts, cmd);
      },
    );

  approvals
    .command('reject [eventId]')
    .description('Reject; operation cancelled (omit eventId to pick)')
    .option('--reason <text>', 'Reason for rejection (will be prompted if omitted)')
    .option(
      '--agent [agentId]',
      'Agent ID (auto-discovered from queue if omitted; pass without value to auto-pick)',
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      async (
        eventId: string | undefined,
        opts: { agent?: unknown; reason?: string; yes?: boolean },
        cmd: Command,
      ) => {
        await runDecide('reject', eventId, opts, cmd);
      },
    );

  approvals
    .command('escalate [eventId]')
    .description('Escalate to higher reviewer (omit eventId to pick)')
    .option(
      '--agent [agentId]',
      'Agent ID (auto-discovered from queue if omitted; pass without value to auto-pick)',
    )
    .option('--reason <text>', 'Optional note for the reviewer')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      async (
        eventId: string | undefined,
        opts: { agent?: unknown; reason?: string; yes?: boolean },
        cmd: Command,
      ) => {
        await runDecide('escalate', eventId, opts, cmd);
      },
    );
}
