import type { Command } from 'commander';

import chalk from 'chalk';
import Table from 'cli-table3';

import { readConfig, resolveBaseUrl } from '../lib/config';
import { OpenBoxClient } from '../lib/openboxClient';
import { printResult, type OutputFormat } from '../lib/output';
import { prompt } from '../lib/prompt';

type GlobalOpts = {
  json?: boolean;
  baseUrl?: string;
  token?: string;
};

function getOutputFormat(cmd: Command): OutputFormat {
  const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (cmd.parent?.opts() as GlobalOpts);
  return global?.json ? 'json' : 'pretty';
}

type Session = {
  id?: string;
  agent_id?: string;
  workflow_id?: string;
  run_id?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  flagged?: boolean;
  flag_reason?: string;
  event_count?: number;
  current_step?: { event_type?: string; last_event?: string } & Record<string, unknown>;
  [key: string]: unknown;
};

type SessionLog = {
  id?: string;
  event_type?: string;
  actor?: string;
  created_at?: string;
  verdict?: number | string;
  decision?: string;
  [key: string]: unknown;
};

function unwrapList<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (!res || typeof res !== 'object') return [];
  const envelope = res as Record<string, unknown>;
  const inner = envelope.data;
  if (Array.isArray(inner)) return inner as T[];
  if (inner && typeof inner === 'object' && Array.isArray((inner as { data?: unknown }).data)) {
    return (inner as { data: T[] }).data;
  }
  return [];
}

function unwrapObject<T>(res: unknown): T | undefined {
  if (!res || typeof res !== 'object') return undefined;
  const envelope = res as Record<string, unknown>;
  if ('data' in envelope && envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)) {
    return envelope.data as T;
  }
  return res as T;
}

function durationString(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '-';
  const ms = Math.max(0, end - start);
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function statusColor(status: string | undefined): string {
  const s = (status ?? '').toLowerCase();
  if (s === 'completed') return chalk.green(status ?? '');
  if (s === 'blocked' || s === 'failed') return chalk.red(status ?? '');
  if (s === 'halted') return chalk.yellow(status ?? '');
  if (s === 'pending') return chalk.cyan(status ?? '');
  return status ?? '-';
}

// Count event verdicts/decisions in logs for a decision-count summary.
function summarizeDecisions(logs: SessionLog[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const l of logs) {
    const key =
      (typeof l.decision === 'string' && l.decision) ||
      (l.verdict !== undefined ? `verdict:${l.verdict}` : undefined) ||
      (typeof l.event_type === 'string' && l.event_type) ||
      'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function printSessionOverview(s: Session): void {
  process.stdout.write(chalk.cyan('Session ID:     ') + (s.id ?? '-') + '\n');
  process.stdout.write(chalk.cyan('Agent:          ') + (s.agent_id ?? '-') + '\n');
  process.stdout.write(chalk.cyan('Workflow:       ') + (s.workflow_id ?? '-') + '\n');
  process.stdout.write(chalk.cyan('Run ID:         ') + (s.run_id ?? '-') + '\n');
  process.stdout.write(chalk.cyan('Status:         ') + statusColor(s.status) + '\n');
  process.stdout.write(chalk.cyan('Started:        ') + (s.started_at ?? '-') + '\n');
  process.stdout.write(chalk.cyan('Completed:      ') + (s.completed_at ?? '-') + '\n');
  process.stdout.write(chalk.cyan('Duration:       ') + durationString(s.started_at, s.completed_at) + '\n');
  process.stdout.write(chalk.cyan('Event count:    ') + String(s.event_count ?? '-') + '\n');
  if (s.flagged) {
    process.stdout.write(chalk.red(`Flagged:        ${s.flag_reason ?? 'yes'}\n`));
  }
}

export function registerSessionCommands(program: Command): void {
  const session = program.command('session').alias('sessions').description('Session commands');

  session
    .command('list')
    .description('Session history with alignment score, duration, decision counts')
    .argument('<agent-id>', 'Agent ID')
    .option('--page <number>', 'Page number (starts from 0)')
    .option('--per-page <number>', 'Results per page [10]')
    .option('--status <status>', 'Filter: pending/completed/failed/blocked/halted')
    .option('--duration <range>', 'Filter: <1min, 1-5mins, 5-15mins, >15mins')
    .option('--search <q>', 'Search by workflow_id or run_id')
    .option('--with-alignment', 'Also fetch goal-alignment score per session (N extra calls)')
    .option('--with-decisions', 'Also fetch decision counts per session (N extra calls)')
    .action(
      async (
        agentId: string,
        opts: {
          page?: string;
          perPage?: string;
          status?: string;
          duration?: string;
          search?: string;
          withAlignment?: boolean;
          withDecisions?: boolean;
        },
        cmd: Command,
      ) => {
        const cfg = await readConfig();
        const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
        const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
        const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;
        const format = getOutputFormat(cmd);

        const client = new OpenBoxClient({ baseUrl, token });

        const query: Record<string, string> = {};
        if (opts.page) query.page = opts.page;
        if (opts.perPage) query.perPage = opts.perPage;
        if (opts.status) query.status = opts.status;
        if (opts.duration) query.duration = opts.duration;
        if (opts.search) query.search = opts.search;

        const res = await client.requestJson<unknown>(
          'GET',
          `/agent/${encodeURIComponent(agentId)}/sessions`,
          { query: Object.keys(query).length ? query : undefined },
        );
        const sessions = unwrapList<Session>(res);

        if (format === 'json' && !opts.withAlignment && !opts.withDecisions) {
          printResult(res, { format });
          return;
        }

        // Optional enrichment per session
        const enriched = await Promise.all(
          sessions.map(async (s) => {
            const extras: { alignment?: string; decisions?: string } = {};
            if (opts.withAlignment && s.id) {
              try {
                const a = await client.requestJson<unknown>(
                  'GET',
                  `/agent/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(s.id)}/goal-alignment-stats`,
                );
                const obj = unwrapObject<Record<string, unknown>>(a);
                const score =
                  obj && (obj.score ?? obj.alignment_score ?? obj.goal_alignment_score ?? obj.average_score);
                if (typeof score === 'number') extras.alignment = score.toFixed(2);
              } catch {
                // ignore
              }
            }
            if (opts.withDecisions && s.id) {
              try {
                const l = await client.requestJson<unknown>(
                  'GET',
                  `/agent/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(s.id)}/logs`,
                  { query: { perPage: '500' } },
                );
                const logs = unwrapList<SessionLog>(l);
                const counts = summarizeDecisions(logs);
                extras.decisions = Object.entries(counts)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(', ');
              } catch {
                // ignore
              }
            }
            return { s, extras };
          }),
        );

        if (format === 'json') {
          printResult(
            {
              ...(typeof res === 'object' && res !== null ? res : {}),
              enriched: enriched.map((e) => ({ session_id: e.s.id, ...e.extras })),
            },
            { format },
          );
          return;
        }

        if (enriched.length === 0) {
          process.stdout.write('No sessions found (N/A).\n');
          return;
        }

        const head = [
          chalk.cyan('Session'),
          chalk.cyan('Workflow'),
          chalk.cyan('Status'),
          chalk.cyan('Started'),
          chalk.cyan('Duration'),
          chalk.cyan('Events'),
        ];
        const widths = [20, 18, 12, 22, 12, 8];
        if (opts.withAlignment) {
          head.push(chalk.cyan('Align'));
          widths.push(8);
        }
        if (opts.withDecisions) {
          head.push(chalk.cyan('Decisions'));
          widths.push(36);
        }

        const table = new Table({ head, colWidths: widths, wordWrap: true });
        for (const { s, extras } of enriched) {
          const row: string[] = [
            s.id ? s.id.slice(0, 8) + '…' : '-',
            s.workflow_id ?? '-',
            statusColor(s.status),
            s.started_at ?? '-',
            durationString(s.started_at, s.completed_at),
            String(s.event_count ?? '-'),
          ];
          if (opts.withAlignment) row.push(extras.alignment ?? '-');
          if (opts.withDecisions) row.push(extras.decisions ?? '-');
          table.push(row);
        }
        process.stdout.write(`${table.toString()}\n`);
        process.stdout.write(chalk.gray(`\nTotal: ${enriched.length} session(s)\n`));
      },
    );

  session
    .command('inspect')
    .description('Full event log, span types, timeline for a session')
    .argument('<agent-id>', 'Agent ID')
    .argument('<session-id>', 'Session ID')
    .option('--per-page <number>', 'Log items per page [100]', '100')
    .option('--page <number>', 'Log page number [0]', '0')
    .option('--event-type <type>', 'Filter by event_type')
    .action(
      async (
        agentId: string,
        sessionId: string,
        opts: { page?: string; perPage?: string; eventType?: string },
        cmd: Command,
      ) => {
        const cfg = await readConfig();
        const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
        const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
        const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;
        const format = getOutputFormat(cmd);

        const client = new OpenBoxClient({ baseUrl, token });

        const [sessionRes, logsRes, alignRes] = await Promise.all([
          client.requestJson<unknown>(
            'GET',
            `/agent/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
          ),
          client.requestJson<unknown>(
            'GET',
            `/agent/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/logs`,
            {
              query: {
                page: opts.page ?? '0',
                perPage: opts.perPage ?? '100',
                ...(opts.eventType ? { event_type: opts.eventType } : {}),
              },
            },
          ),
          client
            .requestJson<unknown>(
              'GET',
              `/agent/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/goal-alignment-stats`,
            )
            .catch(() => undefined),
        ]);

        const session = unwrapObject<Session>(sessionRes) ?? ({} as Session);
        const logs = unwrapList<SessionLog>(logsRes);
        const align = alignRes ? unwrapObject<Record<string, unknown>>(alignRes) : undefined;

        if (format === 'json') {
          printResult(
            { session: sessionRes, logs: logsRes, goal_alignment: alignRes },
            { format },
          );
          return;
        }

        process.stdout.write(chalk.bold('\n== Session overview ==\n'));
        printSessionOverview(session);

        if (align) {
          const score = align.score ?? align.alignment_score ?? align.goal_alignment_score ?? align.average_score;
          if (score !== undefined) {
            process.stdout.write(chalk.cyan('Align score:    ') + String(score) + '\n');
          }
        }

        // Decisions summary
        const counts = summarizeDecisions(logs);
        if (Object.keys(counts).length > 0) {
          process.stdout.write(chalk.bold('\n== Decision counts ==\n'));
          for (const [k, v] of Object.entries(counts)) {
            process.stdout.write(`  ${k}: ${v}\n`);
          }
        }

        // Timeline
        process.stdout.write(chalk.bold('\n== Timeline ==\n'));
        if (logs.length === 0) {
          process.stdout.write('No log events found.\n');
          return;
        }
        const table = new Table({
          head: [chalk.cyan('#'), chalk.cyan('Time'), chalk.cyan('Event'), chalk.cyan('Actor'), chalk.cyan('Verdict')],
          colWidths: [5, 24, 26, 16, 20],
          wordWrap: true,
        });
        logs.forEach((l, i) => {
          const verdict =
            (typeof l.decision === 'string' && l.decision) ||
            (l.verdict !== undefined ? String(l.verdict) : '-');
          table.push([
            String(i + 1),
            l.created_at ?? '-',
            l.event_type ?? '-',
            l.actor ?? '-',
            verdict,
          ]);
        });
        process.stdout.write(`${table.toString()}\n`);
        process.stdout.write(chalk.gray(`\nTotal: ${logs.length} event(s)\n`));
      },
    );

  session
    .command('replay')
    .description('Step-through replay with timestamps and governance verdicts')
    .argument('<agent-id>', 'Agent ID')
    .argument('<session-id>', 'Session ID')
    .option('--auto <ms>', 'Auto-advance every N ms instead of interactive Enter')
    .option('--per-page <number>', 'Max events to fetch [500]', '500')
    .action(
      async (
        agentId: string,
        sessionId: string,
        opts: { auto?: string; perPage?: string },
        cmd: Command,
      ) => {
        const cfg = await readConfig();
        const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
        const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
        const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;

        const client = new OpenBoxClient({ baseUrl, token });

        const [sessionRes, logsRes] = await Promise.all([
          client.requestJson<unknown>(
            'GET',
            `/agent/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
          ),
          client.requestJson<unknown>(
            'GET',
            `/agent/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/logs`,
            { query: { perPage: opts.perPage ?? '500' } },
          ),
        ]);

        const session = unwrapObject<Session>(sessionRes) ?? ({} as Session);
        const logs = unwrapList<SessionLog>(logsRes);

        process.stdout.write(chalk.bold('\n== Replaying session ==\n'));
        printSessionOverview(session);

        if (logs.length === 0) {
          process.stdout.write('\nNo events to replay.\n');
          return;
        }

        const autoMs = opts.auto ? Number.parseInt(opts.auto, 10) : undefined;
        if (opts.auto && (!Number.isFinite(autoMs) || (autoMs ?? 0) < 0)) {
          throw new Error('--auto must be a non-negative integer (milliseconds).');
        }

        process.stdout.write(
          chalk.gray(
            autoMs !== undefined
              ? `\nAuto-advancing every ${autoMs}ms. Ctrl+C to stop.\n`
              : '\nPress Enter to advance, q+Enter to quit.\n',
          ),
        );

        for (let i = 0; i < logs.length; i++) {
          const l = logs[i];
          const verdict =
            (typeof l.decision === 'string' && l.decision) ||
            (l.verdict !== undefined ? `verdict=${l.verdict}` : '-');
          const header = chalk.cyan(`[${i + 1}/${logs.length}]`) + ` ${l.created_at ?? ''}  ${chalk.bold(l.event_type ?? '-')}  ` + chalk.yellow(verdict);
          process.stdout.write(`\n${header}\n`);
          if (l.actor) process.stdout.write(`  actor: ${l.actor}\n`);
          // Print the log as JSON (compact: known noisy fields stripped)
          const { created_at: _ca, event_type: _et, actor: _a, ...rest } = l;
          void _ca;
          void _et;
          void _a;
          const json = JSON.stringify(rest, null, 2);
          process.stdout.write(`${json.length > 2000 ? json.slice(0, 2000) + '\n…(truncated)' : json}\n`);

          if (i === logs.length - 1) break;

          if (autoMs !== undefined) {
            await new Promise((r) => setTimeout(r, autoMs));
          } else {
            const input = (await prompt('')).trim().toLowerCase();
            if (input === 'q' || input === 'quit' || input === 'exit') {
              process.stdout.write(chalk.gray('Replay stopped.\n'));
              return;
            }
          }
        }
        process.stdout.write(chalk.green('\nReplay complete.\n'));
      },
    );
}
