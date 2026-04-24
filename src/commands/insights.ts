import type { Command } from 'commander';

import chalk from 'chalk';
import Table from 'cli-table3';

import { OpenBoxClient } from '../lib/openboxClient';
import { printResult } from '../lib/output';
import { prompt } from '../lib/prompt';
import {
  confirm,
  extractArray,
  getContext,
  pickNumber,
  pickString,
  resolveAgentId,
  unwrapData,
} from './_adaptHelpers';

const SEMANTIC_TYPES: string[] = [
  'http_get',
  'http_post',
  'http_put',
  'http_patch',
  'http_delete',
  'http',
  'llm_completion',
  'llm_embedding',
  'llm_tool_call',
  'database_select',
  'database_insert',
  'database_update',
  'database_delete',
  'database_query',
  'file_read',
  'file_write',
  'file_open',
  'file_delete',
  'internal',
];

type ViolationPattern = {
  sourceType: string;
  pattern: string;
  violationCount: number;
  sessionCount: number;
  sessionIds: string[];
  governanceEventIds: string[];
  raw: Record<string, unknown>;
};

type TrustRecovery = {
  has_penalty: boolean;
  raw: Record<string, unknown>;
};

type Suggestion = {
  index: number;
  source_type: string;
  pattern: string;
  violation_count: number;
  rationale: string;
  rule_template: {
    rule_name: string;
    description: string;
    priority: number;
    trigger: string;
    states: string[];
    time_window: number;
    verdict: number;
    reject_message: string;
    trust_impact: string;
  };
};

function normalizeViolation(row: Record<string, unknown>): ViolationPattern {
  return {
    sourceType: pickString(row, ['sourceType', 'source_type']) ?? '-',
    pattern: pickString(row, ['pattern']) ?? '-',
    violationCount: pickNumber(row, ['violationCount', 'violation_count']) ?? 0,
    sessionCount: pickNumber(row, ['sessionCount', 'session_count']) ?? 0,
    sessionIds: Array.isArray(row.sessionIds) ? (row.sessionIds as string[]) : [],
    governanceEventIds: Array.isArray(row.governanceEventIds) ? (row.governanceEventIds as string[]) : [],
    raw: row,
  };
}

async function fetchInsightMetrics(
  client: OpenBoxClient,
  agentId: string,
  fromTime?: string,
  toTime?: string,
): Promise<{ violations: ViolationPattern[]; total_violations: number; tier_changes: number; raw: Record<string, unknown> | undefined }> {
  const query: Record<string, string> = {};
  if (fromTime) query.fromTime = fromTime;
  if (toTime) query.toTime = toTime;
  const res = await client.request(
    'GET',
    `/agent/${encodeURIComponent(agentId)}/insights/metrics`,
    Object.keys(query).length ? { query } : undefined,
  );
  const obj = unwrapData<Record<string, unknown>>(res.data);
  const violationObj = (obj?.violation ?? obj?.violations) as Record<string, unknown> | undefined;
  const rawArr = violationObj ? extractArray(violationObj.violations ?? violationObj) : [];
  const violations = rawArr.map(normalizeViolation);
  const tierChanges = (obj?.tier_changes ?? obj?.tierChanges) as Record<string, unknown> | undefined;
  return {
    violations,
    total_violations: violationObj ? pickNumber(violationObj, ['total']) ?? 0 : 0,
    tier_changes: tierChanges ? pickNumber(tierChanges, ['total']) ?? 0 : 0,
    raw: obj,
  };
}

async function fetchRecoveryStatus(client: OpenBoxClient, agentId: string): Promise<TrustRecovery> {
  const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}/trust/recovery-status`);
  const obj = unwrapData<Record<string, unknown>>(res.data) ?? {};
  return {
    has_penalty: obj.has_penalty === true,
    raw: obj,
  };
}

async function fetchApprovalMetrics(
  client: OpenBoxClient,
  agentId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}/approvals/metrics`);
    return unwrapData<Record<string, unknown>>(res.data);
  } catch {
    return undefined;
  }
}

function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildSuggestions(violations: ViolationPattern[]): Suggestion[] {
  const sorted = [...violations].sort((a, b) => {
    if (b.violationCount !== a.violationCount) return b.violationCount - a.violationCount;
    return a.pattern.localeCompare(b.pattern);
  });

  const suggestions: Suggestion[] = [];
  sorted.forEach((v, idx) => {
    if (v.violationCount < 1) return;

    const trigger = SEMANTIC_TYPES.includes(v.pattern) ? v.pattern : 'internal';
    const states = [trigger];

    let verdict: number;
    let verdictLabel: string;
    let rejectMessage: string;
    let rationale: string;
    let trust_impact = 'low';

    if (v.sourceType === 'behavior') {
      verdict = 1;
      verdictLabel = 'DENY';
      rejectMessage = `Blocked by auto-suggested rule: recurring ${v.pattern} violations`;
      rationale = `${v.violationCount} behavior violations across ${v.sessionCount} session(s) on ${v.pattern}`;
      trust_impact = v.violationCount >= 100 ? 'high' : v.violationCount >= 10 ? 'medium' : 'low';
    } else if (v.sourceType === 'guardrail') {
      verdict = 2;
      verdictLabel = 'REQUIRE_APPROVAL';
      rejectMessage = `Guardrail ${v.pattern} violations now require approval`;
      rationale = `${v.violationCount} guardrail violations across ${v.sessionCount} session(s)`;
    } else if (v.sourceType === 'policy') {
      verdict = 2;
      verdictLabel = 'REQUIRE_APPROVAL';
      rejectMessage = `Policy ${v.pattern} violations — escalating to approval`;
      rationale = `${v.violationCount} policy violations across ${v.sessionCount} session(s)`;
    } else {
      verdict = 3;
      verdictLabel = 'WARN';
      rejectMessage = `Warning: recurring ${v.pattern} pattern`;
      rationale = `${v.violationCount} ${v.sourceType} violations across ${v.sessionCount} session(s)`;
    }

    const rule_name = `Auto: ${verdictLabel} ${titleize(v.pattern).slice(0, 40)}`;

    suggestions.push({
      index: idx + 1,
      source_type: v.sourceType,
      pattern: v.pattern,
      violation_count: v.violationCount,
      rationale,
      rule_template: {
        rule_name,
        description: `AI-generated suggestion based on recurring ${v.sourceType} violations of \`${v.pattern}\`.`,
        priority: v.sourceType === 'policy' ? 80 : v.sourceType === 'guardrail' ? 70 : 60,
        trigger,
        states,
        time_window: 60,
        verdict,
        reject_message: rejectMessage,
        trust_impact,
      },
    });
  });

  return suggestions;
}

function verdictLabel(n: number): string {
  const labels: Record<number, string> = {
    0: chalk.green('ALLOW'),
    1: chalk.red('DENY'),
    2: chalk.yellow('REQUIRE_APPROVAL'),
    3: chalk.cyan('WARN'),
    4: chalk.gray('LOG'),
  };
  return labels[n] ?? String(n);
}

function printViolationPatterns(violations: ViolationPattern[]): void {
  if (violations.length === 0) {
    process.stdout.write(chalk.green('✓ No violation patterns detected.\n'));
    return;
  }
  const table = new Table({
    head: [
      chalk.cyan('Source'),
      chalk.cyan('Pattern'),
      chalk.cyan('Count'),
      chalk.cyan('Sessions'),
    ],
    wordWrap: true,
    colWidths: [12, 50, 8, 10],
  });
  for (const v of violations) {
    const sourceColored =
      v.sourceType === 'policy'
        ? chalk.magenta(v.sourceType)
        : v.sourceType === 'guardrail'
          ? chalk.yellow(v.sourceType)
          : v.sourceType === 'behavior'
            ? chalk.cyan(v.sourceType)
            : v.sourceType;
    const countColor = v.violationCount >= 100 ? chalk.red : v.violationCount >= 10 ? chalk.yellow : chalk.white;
    table.push([sourceColored, v.pattern, countColor(String(v.violationCount)), String(v.sessionCount)]);
  }
  process.stdout.write(`${table.toString()}\n`);
}

function printSuggestions(suggestions: Suggestion[]): void {
  if (suggestions.length === 0) {
    process.stdout.write(chalk.gray('  (no suggestions)\n'));
    return;
  }
  const table = new Table({
    head: [
      chalk.cyan('#'),
      chalk.cyan('Suggested rule'),
      chalk.cyan('Trigger'),
      chalk.cyan('Verdict'),
      chalk.cyan('Rationale'),
    ],
    wordWrap: true,
    colWidths: [4, 40, 14, 20, 46],
  });
  for (const s of suggestions) {
    table.push([
      String(s.index),
      s.rule_template.rule_name,
      s.rule_template.trigger,
      verdictLabel(s.rule_template.verdict),
      s.rationale,
    ]);
  }
  process.stdout.write(`${table.toString()}\n`);
}

async function runInsights(
  opts: { agent?: string; from?: string; to?: string },
  cmd: Command,
): Promise<void> {
  const { client, format } = await getContext(cmd);
  const { id: agentId, name } = await resolveAgentId(client, opts.agent);

  const [metrics, recovery, approvals] = await Promise.all([
    fetchInsightMetrics(client, agentId, opts.from, opts.to),
    fetchRecoveryStatus(client, agentId),
    fetchApprovalMetrics(client, agentId),
  ]);

  const suggestions = buildSuggestions(metrics.violations);

  if (format === 'json') {
    printResult(
      {
        agent_id: agentId,
        violation_patterns: metrics.violations.map((v) => v.raw),
        total_violations: metrics.total_violations,
        tier_changes: metrics.tier_changes,
        trust_recovery: recovery.raw,
        approval_metrics: approvals,
        suggestions,
      },
      { format },
    );
    return;
  }

  process.stdout.write(`${chalk.bold('\nInsights')}  ${chalk.gray(agentId)}`);
  if (name) process.stdout.write(chalk.gray(`  (${name})`));
  process.stdout.write('\n\n');

  process.stdout.write(`${chalk.bold('Violation patterns')}`);
  process.stdout.write(chalk.gray(`  (${metrics.total_violations} total across ${metrics.violations.length} pattern(s))\n`));
  printViolationPatterns(metrics.violations);

  process.stdout.write(`\n${chalk.bold('Trust recovery status')}\n`);
  if (recovery.has_penalty) {
    process.stdout.write(`  ${chalk.red('● Active penalty')}\n`);
    const fields: Array<[string, string]> = [
      ['penalty_type', 'Penalty type'],
      ['started_at', 'Started at'],
      ['ends_at', 'Ends at'],
      ['remaining_seconds', 'Remaining (s)'],
      ['trust_score_before', 'Score before'],
      ['trust_score_after', 'Score after'],
      ['recovery_progress', 'Recovery progress'],
    ];
    for (const [k, label] of fields) {
      const v = recovery.raw[k];
      if (v !== undefined && v !== null) {
        process.stdout.write(`  ${chalk.cyan(label.padEnd(22))}  ${String(v)}\n`);
      }
    }
  } else {
    process.stdout.write(`  ${chalk.green('● No active penalty')} ${chalk.gray('— agent is in good standing.')}\n`);
  }
  if (metrics.tier_changes > 0) {
    process.stdout.write(`  ${chalk.cyan('Tier changes'.padEnd(22))}  ${metrics.tier_changes}\n`);
  }

  if (approvals) {
    process.stdout.write(`\n${chalk.bold('Approval metrics')}\n`);
    const map: Array<[string, string, (v: number) => string]> = [
      ['pending', 'Pending', (v) => (v > 0 ? chalk.yellow(String(v)) : chalk.gray(String(v)))],
      ['approved', 'Approved', (v) => chalk.green(String(v))],
      ['rejected', 'Rejected', (v) => (v > 0 ? chalk.red(String(v)) : chalk.gray(String(v)))],
      ['approvalRate', 'Approval rate %', (v) => chalk.green(`${v}%`)],
    ];
    for (const [k, label, fmt] of map) {
      const v = pickNumber(approvals, [k]);
      if (v !== undefined) {
        process.stdout.write(`  ${chalk.cyan(label.padEnd(22))}  ${fmt(v)}\n`);
      }
    }
  }

  process.stdout.write(`\n${chalk.bold('Suggested behavioral rules')}\n`);
  process.stdout.write(
    chalk.gray('  (client-side synthesis from violation patterns — accept with `openbox insights accept-suggestion <#>`)\n'),
  );
  printSuggestions(suggestions);
}

async function runAcceptSuggestion(
  indexStr: string | undefined,
  opts: {
    agent?: string;
    from?: string;
    to?: string;
    yes?: boolean;
    name?: string;
    priority?: string;
    verdict?: string;
    states?: string;
    timeWindow?: string;
  },
  cmd: Command,
): Promise<void> {
  const { client, format } = await getContext(cmd);
  const { id: agentId } = await resolveAgentId(client, opts.agent);

  const metrics = await fetchInsightMetrics(client, agentId, opts.from, opts.to);
  const suggestions = buildSuggestions(metrics.violations);

  if (suggestions.length === 0) {
    process.stdout.write(chalk.yellow('No suggestions available for this agent right now.\n'));
    return;
  }

  let n: number;
  if (indexStr === undefined || indexStr === '') {
    process.stdout.write(chalk.bold('\nAvailable suggestions:\n'));
    printSuggestions(suggestions);
    const raw = (await prompt('\nPick a suggestion #: ')).trim();
    if (!raw) {
      process.stdout.write('Aborted.\n');
      return;
    }
    n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Suggestion index must be a positive integer (got '${raw}').`);
    }
  } else {
    n = Number(indexStr);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Suggestion index must be a positive integer (got '${indexStr}').`);
    }
  }

  const suggestion = suggestions.find((s) => s.index === n);
  if (!suggestion) {
    throw new Error(
      `No suggestion #${n} (have ${suggestions.length}). Run \`openbox insights\` to see the current list.`,
    );
  }

  const tpl = { ...suggestion.rule_template };
  if (opts.name) tpl.rule_name = opts.name;
  if (opts.priority !== undefined) {
    const p = Number(opts.priority);
    if (!Number.isInteger(p) || p < 1 || p > 100) {
      throw new Error('--priority must be an integer 1-100.');
    }
    tpl.priority = p;
  }
  if (opts.verdict !== undefined) {
    const v = Number(opts.verdict);
    if (!Number.isInteger(v) || v < 0 || v > 4) {
      throw new Error('--verdict must be 0-4 (0=ALLOW, 1=DENY, 2=REQUIRE_APPROVAL, 3=WARN, 4=LOG).');
    }
    tpl.verdict = v;
  }
  if (opts.states) {
    tpl.states = opts.states.split(',').map((s) => s.trim()).filter(Boolean);
    if (tpl.states.length === 0) throw new Error('--states must contain at least one semantic type.');
  }
  if (opts.timeWindow !== undefined) {
    const tw = Number(opts.timeWindow);
    if (!Number.isInteger(tw) || tw < 1) throw new Error('--time-window must be a positive integer (seconds).');
    tpl.time_window = tw;
  }

  process.stdout.write(`\n${chalk.bold(`Suggestion #${n}`)}\n`);
  process.stdout.write(`  ${chalk.cyan('Pattern'.padEnd(22))}  ${suggestion.pattern} (${suggestion.source_type})\n`);
  process.stdout.write(`  ${chalk.cyan('Violations'.padEnd(22))}  ${suggestion.violation_count}\n`);
  process.stdout.write(`  ${chalk.cyan('Rationale'.padEnd(22))}  ${suggestion.rationale}\n`);
  process.stdout.write(`\n${chalk.bold('Rule to create')}\n`);
  process.stdout.write(`  ${chalk.cyan('Name'.padEnd(22))}  ${tpl.rule_name}\n`);
  process.stdout.write(`  ${chalk.cyan('Trigger'.padEnd(22))}  ${tpl.trigger}\n`);
  process.stdout.write(`  ${chalk.cyan('Prior states'.padEnd(22))}  ${tpl.states.join(', ')}\n`);
  process.stdout.write(`  ${chalk.cyan('Time window'.padEnd(22))}  ${tpl.time_window}s\n`);
  process.stdout.write(`  ${chalk.cyan('Verdict'.padEnd(22))}  ${verdictLabel(tpl.verdict)}\n`);
  process.stdout.write(`  ${chalk.cyan('Priority'.padEnd(22))}  ${tpl.priority}\n`);
  process.stdout.write(`  ${chalk.cyan('Trust impact'.padEnd(22))}  ${tpl.trust_impact}\n`);

  if (!opts.yes) {
    if (!(await confirm('\nCreate this behavioral rule?'))) {
      process.stdout.write('Aborted.\n');
      return;
    }
  }

  const body: Record<string, unknown> = {
    rule_name: tpl.rule_name,
    description: tpl.description,
    priority: tpl.priority,
    trigger: tpl.trigger,
    states: tpl.states,
    time_window: tpl.time_window,
    verdict: tpl.verdict,
    reject_message: tpl.reject_message,
    trust_impact: tpl.trust_impact,
  };

  const res = await client.request('POST', `/agent/${encodeURIComponent(agentId)}/behavior-rule`, { body });
  process.stdout.write(`${chalk.green('✓ Behavioral rule created.')}\n`);
  const created = unwrapData<Record<string, unknown>>(res.data);
  if (created) {
    const id = pickString(created, ['id', 'rule_id', 'base_rule_id']);
    if (id) process.stdout.write(chalk.gray(`  rule id: ${id}\n`));
  }
  if (format === 'json' && res.data) printResult(res.data, { format });
}

export function registerInsightsCommands(program: Command): void {
  const insights = program
    .command('insights')
    .description('Violation patterns, policy suggestions, trust recovery status (ADAPT)')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = (cmd.optsWithGlobals() as Record<string, string | boolean | undefined>) ?? {};
      await runInsights(
        {
          agent: typeof g.agent === 'string' ? g.agent : undefined,
          from: typeof g.from === 'string' ? g.from : undefined,
          to: typeof g.to === 'string' ? g.to : undefined,
        },
        cmd,
      );
    })
    .option('--agent <agentId>', 'Agent ID (auto-picks if you only have one agent)')
    .option('--from <iso>', 'Filter start time (ISO 8601)')
    .option('--to <iso>', 'Filter end time (ISO 8601)');

  insights
    .command('accept-suggestion [index]')
    .description('Accept AI-generated policy suggestion → creates rule (omit index to pick interactively)')
    .option('--agent <agentId>', 'Agent ID (auto-picks if you only have one agent)')
    .option('--from <iso>', 'Same time filter used in `insights` (for suggestion reproducibility)')
    .option('--to <iso>', 'Same time filter used in `insights` (for suggestion reproducibility)')
    .option('--name <name>', 'Override the auto-generated rule name')
    .option('--priority <n>', 'Override priority (1-100)')
    .option('--verdict <n>', 'Override verdict (0=ALLOW, 1=DENY, 2=REQUIRE_APPROVAL, 3=WARN, 4=LOG)')
    .option('--states <csv>', 'Override prior states (comma-separated semantic types)')
    .option('--time-window <seconds>', 'Override time window in seconds')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      async (
        index: string | undefined,
        opts: {
          agent?: string;
          from?: string;
          to?: string;
          yes?: boolean;
          name?: string;
          priority?: string;
          verdict?: string;
          states?: string;
          timeWindow?: string;
        },
        cmd: Command,
      ) => {
        await runAcceptSuggestion(index, opts, cmd);
      },
    );
}
