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

type BehaviorRule = {
  id?: string;
  base_rule_id?: string;
  rule_name?: string;
  description?: string;
  priority?: number;
  trigger?: string;
  states?: string[];
  verdict?: number;
  is_active?: boolean;
  time_window?: number;
  reject_message?: string;
  [key: string]: unknown;
};

type RulePage = {
  data?: BehaviorRule[];
  total?: number;
  start?: number;
  limit?: number;
  [key: string]: unknown;
};

type RuleEnvelope = {
  status?: number;
  data?: RulePage | BehaviorRule[];
  [key: string]: unknown;
};

// Based on the CreateBehaviorRuleDto enum + approval_timeout hint
// ("required if verdict is REQUIRE_APPROVAL"). Raw number shown alongside.
const VERDICT_LABELS: Record<string, string> = {
  '0': 'Allow',
  '1': 'Log',
  '2': 'Reject',
  '3': 'Require Approval',
  '4': 'Escalate',
};

function labelVerdict(value: unknown): string {
  if (value === undefined || value === null) return 'N/A';
  const key = String(value);
  const name = VERDICT_LABELS[key];
  return name ? `${name} (${key})` : key;
}

function formatStates(states: unknown): string {
  if (!Array.isArray(states) || states.length === 0) return '-';
  return states.join(', ');
}

function extractRules(res: unknown): BehaviorRule[] {
  if (Array.isArray(res)) return res as BehaviorRule[];
  if (!res || typeof res !== 'object') return [];
  const envelope = res as RuleEnvelope;
  const inner = envelope.data;
  if (Array.isArray(inner)) return inner;
  if (inner && typeof inner === 'object' && Array.isArray((inner as RulePage).data)) {
    return (inner as RulePage).data as BehaviorRule[];
  }
  return [];
}

function printRuleTable(rules: BehaviorRule[]): void {
  if (rules.length === 0) {
    process.stdout.write('No behavioral rules found (N/A).\n');
    return;
  }

  const table = new Table({
    head: [
      chalk.cyan('Name'),
      chalk.cyan('Trigger'),
      chalk.cyan('Prior States'),
      chalk.cyan('Verdict'),
      chalk.cyan('Priority'),
      chalk.cyan('Enabled'),
    ],
    colWidths: [26, 16, 24, 20, 10, 10],
    wordWrap: true,
  });

  for (const r of rules) {
    const enabled = r.is_active !== false;
    table.push([
      r.rule_name ?? '-',
      r.trigger ?? '-',
      formatStates(r.states),
      labelVerdict(r.verdict),
      r.priority !== undefined ? String(r.priority) : '-',
      enabled ? chalk.green('Yes') : chalk.red('No'),
    ]);
  }

  process.stdout.write(`${table.toString()}\n`);
  process.stdout.write(chalk.gray(`\nTotal: ${rules.length} rule(s)\n`));
}

export function registerRuleCommands(program: Command): void {
  const rule = program.command('rule').description('Behavioral rule management commands');

  rule
    .command('list')
    .description('Show all behavioral rules: trigger, prior-states, verdict, priority')
    .argument('<agent-id>', 'Agent ID')
    .option('--page <number>', 'Page number (starts from 0)')
    .option('--per-page <number>', 'Results per page')
    .option('--verdict <number>', 'Filter by verdict (0-4)')
    .option('--trigger <value>', 'Filter by trigger (e.g. http_get, llm_completion)')
    .option('--is-active <bool>', 'Filter by active status (true/false)')
    .action(
      async (
        agentId: string,
        opts: {
          page?: string;
          perPage?: string;
          verdict?: string;
          trigger?: string;
          isActive?: string;
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
        if (opts.verdict) query.verdict = opts.verdict;
        if (opts.trigger) query.trigger = opts.trigger;
        if (opts.isActive) query.is_active = opts.isActive;

        const res = await client.requestJson<unknown>(
          'GET',
          `/agent/${encodeURIComponent(agentId)}/behavior-rule`,
          { query: Object.keys(query).length ? query : undefined },
        );

        const rules = extractRules(res);

        if (format === 'json') {
          printResult(res, { format });
          return;
        }

        printRuleTable(rules);
      },
    );

  rule
    .command('create')
    .description('Wizard: trigger semantic type, required prior states, verdict')
    .argument('[agent-id]', 'Agent ID (will prompt if omitted)')
    .action(async (agentIdArg: string | undefined, _opts: unknown, cmd: Command) => {
      const cfg = await readConfig();
      const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
      const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
      const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;
      const format = getOutputFormat(cmd);

      const client = new OpenBoxClient({ baseUrl, token });

      const agentId = (agentIdArg ?? (await prompt('Agent ID: '))).trim();
      if (!agentId) throw new Error('Agent ID is required.');

      // Fetch available semantic types (triggers / prior states)
      const typesRes = await client.requestJson<unknown>('GET', '/agent/behavior-rule/semantic-types');
      const typesList = Array.isArray(typesRes)
        ? (typesRes as string[])
        : Array.isArray((typesRes as { data?: unknown })?.data)
        ? ((typesRes as { data: string[] }).data)
        : [];
      if (typesList.length === 0) {
        throw new Error('Failed to fetch semantic types from API.');
      }

      process.stdout.write('\nAvailable semantic types:\n');
      typesList.forEach((t, i) => {
        process.stdout.write(`  ${String(i + 1).padStart(2, ' ')}) ${t}\n`);
      });

      const resolveType = (raw: string): string => {
        const trimmed = raw.trim();
        if (!trimmed) throw new Error('Value is required.');
        const asIndex = Number.parseInt(trimmed, 10);
        if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= typesList.length) {
          return typesList[asIndex - 1];
        }
        if (typesList.includes(trimmed)) return trimmed;
        throw new Error(`'${trimmed}' is not a valid semantic type.`);
      };

      const rule_name = (await prompt('\nRule name: ')).trim();
      if (!rule_name) throw new Error('Rule name is required.');

      const description = (await prompt('Description (optional): ')).trim();

      const triggerInput = (await prompt('Trigger (number or name): ')).trim();
      const trigger = resolveType(triggerInput);

      const statesInput = (await prompt('Prior states (comma-separated numbers or names): ')).trim();
      if (!statesInput) throw new Error('At least one prior state is required.');
      const states = statesInput
        .split(',')
        .map((s) => resolveType(s))
        .filter(Boolean);

      process.stdout.write(
        '\nVerdict:\n  0) Allow\n  1) Log\n  2) Reject\n  3) Require Approval\n  4) Escalate\n',
      );
      const verdictInput = (await prompt('Choose verdict [0-4]: ')).trim();
      if (!['0', '1', '2', '3', '4'].includes(verdictInput)) {
        throw new Error('Verdict must be 0, 1, 2, 3, or 4.');
      }
      const verdict = Number.parseInt(verdictInput, 10);

      const reject_message = (await prompt('Reject message: ')).trim();
      if (!reject_message) throw new Error('Reject message is required.');

      const priorityStr = (await prompt('Priority (1-100) [50]: ')).trim() || '50';
      const priority = Number.parseInt(priorityStr, 10);
      if (!Number.isInteger(priority) || priority < 1 || priority > 100) {
        throw new Error('Priority must be an integer between 1 and 100.');
      }

      const timeWindowStr = (await prompt('Time window in seconds [60]: ')).trim() || '60';
      const time_window = Number.parseInt(timeWindowStr, 10);
      if (!Number.isInteger(time_window) || time_window < 1) {
        throw new Error('Time window must be a positive integer.');
      }

      const body: Record<string, unknown> = {
        rule_name,
        priority,
        trigger,
        states,
        time_window,
        verdict,
        reject_message,
      };
      if (description) body.description = description;

      // Conditional: approval timeout when verdict = Require Approval
      if (verdict === 3) {
        const timeoutStr = (await prompt('Approval timeout in seconds [300]: ')).trim() || '300';
        const approval_timeout = Number.parseInt(timeoutStr, 10);
        if (!Number.isInteger(approval_timeout) || approval_timeout < 1) {
          throw new Error('Approval timeout must be a positive integer.');
        }
        body.approval_timeout = approval_timeout;
      }

      const trustImpactRaw = (await prompt('Trust impact (none/low/medium/high) [none]: ')).trim() || 'none';
      if (!['none', 'low', 'medium', 'high'].includes(trustImpactRaw)) {
        throw new Error('Trust impact must be one of: none, low, medium, high.');
      }
      body.trust_impact = trustImpactRaw;

      const trustThresholdStr = (await prompt('Trust threshold (blank = system default): ')).trim();
      if (trustThresholdStr) {
        const trust_threshold = Number.parseInt(trustThresholdStr, 10);
        if (!Number.isInteger(trust_threshold) || trust_threshold < 1) {
          throw new Error('Trust threshold must be a positive integer.');
        }
        body.trust_threshold = trust_threshold;
      }

      process.stdout.write('\nPayload to be sent:\n');
      process.stdout.write(`${JSON.stringify(body, null, 2)}\n\n`);
      const confirm = (await prompt('Create this rule? (y/n): ')).trim().toLowerCase();
      if (confirm !== 'y' && confirm !== 'yes') {
        process.stdout.write('Aborted.\n');
        return;
      }

      const res = await client.requestJson<unknown>(
        'POST',
        `/agent/${encodeURIComponent(agentId)}/behavior-rule`,
        { body },
      );

      if (format === 'json') {
        printResult(res, { format });
        return;
      }

      const created =
        res && typeof res === 'object' && 'data' in (res as Record<string, unknown>)
          ? ((res as Record<string, unknown>).data as BehaviorRule)
          : (res as BehaviorRule);
      const createdId =
        (typeof created?.id === 'string' && created.id) ||
        (typeof created?.base_rule_id === 'string' && created.base_rule_id) ||
        undefined;

      process.stdout.write(chalk.green('Behavioral rule created.\n'));
      if (createdId) process.stdout.write(`ID:       ${createdId}\n`);
      process.stdout.write(`Name:     ${rule_name}\n`);
      process.stdout.write(`Trigger:  ${trigger}\n`);
      process.stdout.write(`States:   ${states.join(', ')}\n`);
      process.stdout.write(`Verdict:  ${labelVerdict(verdict)}\n`);
      process.stdout.write(`Priority: ${priority}\n`);
    });

  rule
    .command('delete')
    .description('Remove a behavioral rule')
    .argument('<agent-id>', 'Agent ID')
    .argument('<rule-id>', 'Behavior rule ID')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (agentId: string, ruleId: string, opts: { yes?: boolean }, cmd: Command) => {
      const cfg = await readConfig();
      const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
      const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
      const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;
      const format = getOutputFormat(cmd);

      const client = new OpenBoxClient({ baseUrl, token });

      if (!opts.yes) {
        // Fetch the rule for a clearer confirmation prompt
        let ruleName = ruleId;
        try {
          const current = await client.requestJson<unknown>(
            'GET',
            `/agent/${encodeURIComponent(agentId)}/behavior-rule/${encodeURIComponent(ruleId)}`,
          );
          const r =
            current && typeof current === 'object' && 'data' in (current as Record<string, unknown>)
              ? ((current as Record<string, unknown>).data as BehaviorRule)
              : (current as BehaviorRule);
          if (r?.rule_name) ruleName = `${r.rule_name} (${ruleId})`;
        } catch {
          // If fetch fails, still allow delete attempt
        }

        const confirm = (await prompt(`Delete rule ${ruleName}? (y/n): `)).trim().toLowerCase();
        if (confirm !== 'y' && confirm !== 'yes') {
          process.stdout.write('Aborted.\n');
          return;
        }
      }

      const res = await client.requestJson<unknown>(
        'DELETE',
        `/agent/${encodeURIComponent(agentId)}/behavior-rule/${encodeURIComponent(ruleId)}`,
      );

      if (format === 'json') {
        printResult(res, { format });
        return;
      }

      process.stdout.write(chalk.green(`Deleted rule: ${ruleId}\n`));
    });
}
