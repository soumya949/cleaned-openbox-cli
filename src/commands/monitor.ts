import type { Command } from 'commander';

import chalk from 'chalk';

import { readConfig, resolveBaseUrl } from '../lib/config';
import { OpenBoxClient } from '../lib/openboxClient';

type GlobalOpts = {
  json?: boolean;
  baseUrl?: string;
  token?: string;
};

type Session = {
  id?: string;
  workflow_id?: string;
  run_id?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  updated_at?: string;
  flagged?: boolean;
  flag_reason?: string;
  [key: string]: unknown;
};

type PendingApproval = {
  id?: string;
  event_id?: string;
  status?: string;
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

// Map session state + flags to verdict labels used by the UI.
function sessionVerdict(s: Session): { label: string; colored: string } {
  const status = (s.status ?? '').toLowerCase();
  if (status === 'blocked' || status === 'failed') {
    return { label: 'BLOCK', colored: chalk.red('BLOCK') };
  }
  if (status === 'halted') {
    return { label: 'HALT', colored: chalk.yellow('HALT') };
  }
  if (status === 'pending') {
    return { label: 'REQUIRE_APPROVAL', colored: chalk.cyan('REQUIRE_APPROVAL') };
  }
  if (status === 'completed') {
    return { label: 'ALLOW', colored: chalk.green('ALLOW') };
  }
  return { label: status.toUpperCase() || 'UNKNOWN', colored: chalk.gray(status.toUpperCase() || 'UNKNOWN') };
}

function printEvent(s: Session, source: 'session' | 'approval'): void {
  const { colored } = sessionVerdict(s);
  const ts = new Date().toISOString();
  const id = s.id ? s.id.slice(0, 8) : '-';
  const wf = s.workflow_id ?? '-';
  const tag = source === 'approval' ? chalk.magenta('[APPROVAL]') : chalk.gray('[SESSION] ');
  process.stdout.write(
    `${chalk.gray(ts)} ${tag} ${colored.padEnd(20)} session=${id} workflow=${wf} status=${s.status ?? '-'}` +
      (s.flagged ? ` ${chalk.red(`flagged: ${s.flag_reason ?? 'yes'}`)}` : '') +
      '\n',
  );
}

export function registerMonitorCommand(program: Command): void {
  program
    .command('monitor')
    .description('Live event stream: ALLOW/BLOCK/HALT/REQUIRE_APPROVAL')
    .argument('<agent-id>', 'Agent ID')
    .option('--follow', 'Keep streaming; polls continuously until Ctrl+C')
    .option('--interval <sec>', 'Poll interval in seconds [3]', '3')
    .option('--limit <n>', 'Max sessions to fetch per poll [20]', '20')
    .action(
      async (
        agentId: string,
        opts: { follow?: boolean; interval?: string; limit?: string },
        cmd: Command,
      ) => {
        const cfg = await readConfig();
        const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
        const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
        const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;

        const client = new OpenBoxClient({ baseUrl, token });

        const intervalMs = Math.max(1, Number.parseInt(opts.interval ?? '3', 10)) * 1000;
        const perPage = opts.limit ?? '20';

        // Keyed state: session_id → last updated_at we printed
        const seenSessions = new Map<string, string>();
        const seenApprovals = new Set<string>();

        async function pollOnce(firstRun: boolean): Promise<void> {
          // Sessions
          const sRes = await client.requestJson<unknown>(
            'GET',
            `/agent/${encodeURIComponent(agentId)}/sessions`,
            { query: { perPage, page: '0' } },
          );
          const sessions = unwrapList<Session>(sRes);

          const fresh: Session[] = [];
          for (const s of sessions) {
            if (!s.id) continue;
            const marker = s.updated_at ?? s.completed_at ?? s.started_at ?? '';
            const prev = seenSessions.get(s.id);
            if (prev !== marker) {
              seenSessions.set(s.id, marker);
              if (!firstRun || !opts.follow) fresh.push(s);
              else if (firstRun) fresh.push(s);
            }
          }

          // Pending approvals (these map to REQUIRE_APPROVAL)
          let approvals: PendingApproval[] = [];
          try {
            const aRes = await client.requestJson<unknown>(
              'GET',
              `/agent/${encodeURIComponent(agentId)}/approvals/pending`,
              { query: { perPage, page: '0', status: 'pending' } },
            );
            approvals = unwrapList<PendingApproval>(aRes);
          } catch {
            // ignore if endpoint not accessible
          }

          const freshApprovals: PendingApproval[] = [];
          for (const a of approvals) {
            const key = (a.id ?? a.event_id ?? '') as string;
            if (!key) continue;
            if (!seenApprovals.has(key)) {
              seenApprovals.add(key);
              freshApprovals.push(a);
            }
          }

          // Print in time order (sessions first, then approvals)
          for (const s of fresh) printEvent(s, 'session');
          for (const a of freshApprovals) {
            const pseudo: Session = {
              id: (a.id ?? a.event_id) as string | undefined,
              status: 'pending',
              workflow_id: (a.workflow_id as string | undefined) ?? '-',
            };
            printEvent(pseudo, 'approval');
          }
        }

        process.stdout.write(
          chalk.gray(
            `Monitoring agent ${agentId} @ ${baseUrl} (interval=${intervalMs / 1000}s, follow=${Boolean(
              opts.follow,
            )})\n`,
          ),
        );

        // First poll prints current snapshot so user has context
        await pollOnce(true);

        if (!opts.follow) return;

        let stopping = false;
        const onStop = () => {
          if (stopping) return;
          stopping = true;
          process.stdout.write(chalk.gray('\nStopped.\n'));
          process.exit(0);
        };
        process.on('SIGINT', onStop);
        process.on('SIGTERM', onStop);

        // eslint-disable-next-line no-constant-condition
        while (true) {
          await new Promise((r) => setTimeout(r, intervalMs));
          try {
            await pollOnce(false);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            process.stderr.write(chalk.red(`poll error: ${msg}\n`));
          }
        }
      },
    );
}
