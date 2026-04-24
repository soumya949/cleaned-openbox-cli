import type { Command } from 'commander';

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

async function promptText(question: string, opts: { default?: string; required?: boolean } = {}): Promise<string> {
  while (true) {
    const suffix = opts.default !== undefined ? ` [${opts.default}]` : '';
    const raw = await prompt(`${question}${suffix}: `);
    const trimmed = raw.trim();
    if (!trimmed && opts.default !== undefined) return opts.default;
    if (trimmed) return trimmed;
    if (!opts.required) return '';
    process.stdout.write('  This value is required.\n');
  }
}

async function promptNumber(question: string, min: number, max: number, def?: number): Promise<number> {
  while (true) {
    const suffix = def !== undefined ? ` [${def}]` : '';
    const raw = (await prompt(`${question} (${min}-${max})${suffix}: `)).trim();
    if (!raw && def !== undefined) return def;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    process.stdout.write(`  Please enter an integer between ${min} and ${max}.\n`);
  }
}

async function promptChoice<T extends string>(question: string, choices: readonly T[], def?: T): Promise<T> {
  while (true) {
    const suffix = def ? ` [${def}]` : '';
    const raw = (await prompt(`${question} (${choices.join('|')})${suffix}: `)).trim();
    if (!raw && def) return def;
    if ((choices as readonly string[]).includes(raw)) return raw as T;
    process.stdout.write(`  Please choose one of: ${choices.join(', ')}\n`);
  }
}

async function confirm(question: string): Promise<boolean> {
  const raw = (await prompt(`${question} (yes/no): `)).trim().toLowerCase();
  return raw === 'y' || raw === 'yes';
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
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

function tierBadge(tier: unknown): string {
  if (tier === null || tier === undefined || tier === '') return chalk.gray('-');
  const label = String(tier);
  const n = Number(label);
  if (n === 1) return chalk.green(`T1`);
  if (n === 2) return chalk.cyan(`T2`);
  if (n === 3) return chalk.yellow(`T3`);
  if (n === 4) return chalk.magenta(`T4`);
  if (n === 5) return chalk.red(`T5`);
  return chalk.white(label);
}

function scoreColor(score: number | undefined): string {
  if (score === undefined) return chalk.gray('-');
  const s = score > 1 ? score : score * 100;
  const rounded = Math.round(s * 10) / 10;
  if (s >= 80) return chalk.green(String(rounded));
  if (s >= 60) return chalk.cyan(String(rounded));
  if (s >= 40) return chalk.yellow(String(rounded));
  return chalk.red(String(rounded));
}

function extractAgentArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  for (const key of ['agents', 'items', 'data', 'results', 'list']) {
    const v = obj[key];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  for (const key of ['data', 'result', 'results']) {
    const v = obj[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = extractAgentArray(v);
      if (nested.length > 0) return nested;
      for (const innerKey of ['agents', 'items', 'data', 'results', 'list']) {
        const iv = (v as Record<string, unknown>)[innerKey];
        if (Array.isArray(iv)) return iv as Record<string, unknown>[];
      }
    }
  }
  return [];
}

function getTrustObj(agent: Record<string, unknown>): Record<string, unknown> | undefined {
  const t = agent.agent_trust_score ?? agent.trust ?? agent.trustScore;
  if (t && typeof t === 'object' && !Array.isArray(t)) return t as Record<string, unknown>;
  return undefined;
}

function getAgentTrustScore(agent: Record<string, unknown>): number | undefined {
  const t = getTrustObj(agent);
  if (t) {
    const v = pickNumber(t, ['trust_score', 'trustScore', 'score']);
    if (v !== undefined) return v;
  }
  return pickNumber(agent, ['trust_score', 'trustScore', 'aivss_score', 'score']);
}

function getAgentTrustTier(agent: Record<string, unknown>): unknown {
  const t = getTrustObj(agent);
  if (t && (t.trust_tier !== undefined || t.tier !== undefined || t.trustTier !== undefined)) {
    return t.trust_tier ?? t.tier ?? t.trustTier;
  }
  return agent.trust_tier ?? agent.tier ?? agent.trustTier;
}

function getAgentLastSeen(agent: Record<string, unknown>): unknown {
  const last = agent.last_log;
  if (last && typeof last === 'object' && !Array.isArray(last)) {
    const l = last as Record<string, unknown>;
    return l.end_time ?? l.updated_at ?? l.created_at ?? agent.updated_at;
  }
  return agent.last_seen_at ?? agent.lastSeenAt ?? agent.updated_at ?? agent.updatedAt;
}

function getAgentStatus(agent: Record<string, unknown>): string {
  const s = agent.status;
  if (s === 0 || s === '0' || s === 'active' || s === true) return chalk.green('Active');
  if (s === 1 || s === '1' || s === 'inactive') return chalk.gray('Inactive');
  if (s === 2 || s === '2' || s === 'blocked' || s === 'halted') return chalk.red('Blocked');
  if (s === undefined || s === null) return chalk.gray('-');
  return String(s);
}

function printAgentsTable(agents: Record<string, unknown>[]): void {
  if (agents.length === 0) {
    process.stdout.write(chalk.gray('(no agents)\n'));
    return;
  }

  const table = new Table({
    head: [
      chalk.cyan('Agent ID'),
      chalk.cyan('Name'),
      chalk.cyan('Type'),
      chalk.cyan('Status'),
      chalk.cyan('Trust'),
      chalk.cyan('Tier'),
      chalk.cyan('Last Seen'),
    ],
    wordWrap: true,
    colWidths: [20, 24, 12, 10, 8, 6, 22],
  });

  for (const agent of agents) {
    const id = pickString(agent, ['agent_id', 'id', 'agentId', '_id']) ?? '-';
    const name = pickString(agent, ['agent_name', 'name']) ?? '-';
    const type = pickString(agent, ['agent_type', 'type']) ?? '-';

    table.push([
      id.length > 18 ? `${id.slice(0, 17)}…` : id,
      name,
      type,
      getAgentStatus(agent),
      scoreColor(getAgentTrustScore(agent)),
      tierBadge(getAgentTrustTier(agent)),
      formatDate(getAgentLastSeen(agent)),
    ]);
  }

  process.stdout.write(`${table.toString()}\n`);
}

function extractFirstObject(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const obj = data as Record<string, unknown>;
  if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
    const inner = obj.data as Record<string, unknown>;
    if ('data' in inner && typeof inner.data === 'object' && !Array.isArray(inner.data) && inner.data !== null) {
      return inner.data as Record<string, unknown>;
    }
    if ('agent_name' in inner || 'agent_id' in inner || 'id' in inner) {
      return inner;
    }
  }
  if (obj.agent && typeof obj.agent === 'object' && !Array.isArray(obj.agent)) {
    return obj.agent as Record<string, unknown>;
  }
  return obj;
}

function printAgentDetail(agent: Record<string, unknown>): void {
  const id = pickString(agent, ['agent_id', 'id', 'agentId', '_id']) ?? '-';
  const name = pickString(agent, ['agent_name', 'name']) ?? '-';
  const type = pickString(agent, ['agent_type', 'type']) ?? '-';
  const model = pickString(agent, ['model_name', 'model']) ?? '-';
  const description = pickString(agent, ['description']) ?? '-';
  const trust = getAgentTrustScore(agent);
  const tier = getAgentTrustTier(agent);
  const lastSeen = getAgentLastSeen(agent);
  const createdAt = agent.created_at ?? agent.createdAt;
  const sessionCount = pickNumber(agent, ['session_count', 'sessionCount', 'total_sessions', 'totalSessions']);
  const activeSessions = pickNumber(agent, ['active_sessions', 'activeSessions']);

  process.stdout.write(`${chalk.bold('Agent')}  ${chalk.gray(id)}\n`);
  process.stdout.write(`  ${chalk.cyan('Name'.padEnd(18))}  ${name}\n`);
  process.stdout.write(`  ${chalk.cyan('Type'.padEnd(18))}  ${type}\n`);
  process.stdout.write(`  ${chalk.cyan('Model'.padEnd(18))}  ${model}\n`);
  process.stdout.write(`  ${chalk.cyan('Description'.padEnd(18))}  ${description}\n`);
  process.stdout.write(`  ${chalk.cyan('Status'.padEnd(18))}  ${getAgentStatus(agent)}\n`);
  process.stdout.write(`  ${chalk.cyan('Trust score'.padEnd(18))}  ${scoreColor(trust)}\n`);
  process.stdout.write(`  ${chalk.cyan('Trust tier'.padEnd(18))}  ${tierBadge(tier)}\n`);
  if (sessionCount !== undefined) {
    process.stdout.write(`  ${chalk.cyan('Total sessions'.padEnd(18))}  ${sessionCount}\n`);
  }
  if (activeSessions !== undefined) {
    process.stdout.write(`  ${chalk.cyan('Active sessions'.padEnd(18))}  ${activeSessions}\n`);
  }
  process.stdout.write(`  ${chalk.cyan('Last seen'.padEnd(18))}  ${formatDate(lastSeen)}\n`);
  process.stdout.write(`  ${chalk.cyan('Created'.padEnd(18))}  ${formatDate(createdAt)}\n`);

  const trustObj = getTrustObj(agent);
  if (trustObj) {
    process.stdout.write(`\n${chalk.bold('Trust score breakdown')}\n`);
    const breakdownKeys: Array<[string, string]> = [
      ['initial_score', 'Initial score'],
      ['initial_tier', 'Initial tier'],
      ['aivss_baseline', 'AIVSS baseline'],
      ['behavioral_compliance', 'Behavioral compliance'],
      ['alignment_consistency', 'Alignment consistency'],
      ['violation_penalties', 'Violation penalties'],
      ['total_behavior_evaluations', 'Behavior evals (total)'],
      ['compliant_behavior_evaluations', 'Behavior evals (compliant)'],
      ['total_goal_evaluations', 'Goal evals (total)'],
      ['aligned_goal_evaluations', 'Goal evals (aligned)'],
      ['last_calculated_at', 'Last calculated'],
      ['last_violation_at', 'Last violation'],
    ];
    for (const [k, label] of breakdownKeys) {
      if (trustObj[k] !== undefined && trustObj[k] !== null) {
        const v = trustObj[k];
        const display = typeof v === 'string' && /\d{4}-\d{2}-\d{2}T/.test(v) ? formatDate(v) : String(v);
        process.stdout.write(`  ${chalk.cyan(label.padEnd(26))}  ${display}\n`);
      }
    }
  }
}

async function runRegisterWizard(cmd: Command): Promise<void> {
  const { client, format } = await getContext(cmd);

  process.stdout.write(`${chalk.bold('\nRegister a new agent')}\n`);
  process.stdout.write(`${chalk.gray('Press Enter to accept [defaults]. * = required.')}\n\n`);

  process.stdout.write(`${chalk.cyan('Basics')}\n`);
  const agent_name = await promptText('Agent name *', { required: true });
  const agent_type = await promptText('Agent type (e.g. chatbot)');
  const framework = await promptText('Framework (langchain, custom, ...)');
  const model_name = await promptText('Model name (e.g. gpt-4)');
  const description = await promptText('Description');
  const icon = await promptText('Icon URL *', { default: 'https://placeholder.local/icon.png', required: true });
  const tagsRaw = await promptText('Tags (comma-separated)');
  const teamRaw = await promptText('Team IDs (comma-separated) *', { required: true });

  const team_ids = teamRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const tags = tagsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  process.stdout.write(`\n${chalk.cyan('Risk profile — Base Security (25% weight)')}\n`);
  const base_security = {
    attack_vector: await promptNumber('  Attack Vector           1=Network 2=Adjacent 3=Local 4=Physical', 1, 4, 1),
    attack_complexity: await promptNumber('  Attack Complexity       1=Low 2=High', 1, 2, 1),
    privileges_required: await promptNumber('  Privileges Required     1=None 2=Low 3=High', 1, 3, 1),
    user_interaction: await promptNumber('  User Interaction        1=None 2=Required', 1, 2, 1),
    scope: await promptNumber('  Scope                   1=Unchanged 2=Changed', 1, 2, 1),
  };

  process.stdout.write(`\n${chalk.cyan('Risk profile — AI-Specific (45% weight)')}\n`);
  const ai_specific = {
    model_robustness: await promptNumber('  Model Robustness        1=Very High 5=Very Low', 1, 5, 2),
    data_sensitivity: await promptNumber('  Data Sensitivity        1=Public 5=Critical', 1, 5, 3),
    ethical_impact: await promptNumber('  Ethical Impact          1=Negligible 5=Severe', 1, 5, 2),
    decision_criticality: await promptNumber('  Decision Criticality    1=Non-critical 5=Safety-critical', 1, 5, 3),
    adaptability: await promptNumber('  Adaptability            1=Static 5=Highly adaptive', 1, 5, 4),
  };

  process.stdout.write(`\n${chalk.cyan('Risk profile — Impact (30% weight)')}\n`);
  const impact = {
    confidentiality_impact: await promptNumber('  Confidentiality         1=None 5=Critical', 1, 5, 2),
    integrity_impact: await promptNumber('  Integrity               1=None 5=Critical', 1, 5, 2),
    availability_impact: await promptNumber('  Availability            1=None 5=Critical', 1, 5, 2),
    safety_impact: await promptNumber('  Safety                  1=None 5=Critical', 1, 5, 2),
  };

  process.stdout.write(`\n${chalk.cyan('Goal alignment & drift detection')}\n`);
  const alignment_threshold = await promptNumber('  Alignment threshold %', 0, 100, 70);
  const llama_firewall_model = await promptChoice(
    '  LlamaFirewall model',
    ['gpt-4o-mini', 'gpt-4o', 'claude-3-haiku'] as const,
    'gpt-4o-mini',
  );
  const drift_detection_action = await promptChoice(
    '  Drift detection action',
    ['alert_only', 'constrain', 'terminate'] as const,
    'constrain',
  );
  const evaluation_frequency = await promptChoice(
    '  Evaluation frequency',
    ['every_action', 'every_5_actions', 'every_10_actions', 'session_end_only'] as const,
    'every_action',
  );

  const body: Record<string, unknown> = {
    agent_name,
    team_ids,
    icon,
    aivss_config: { base_security, ai_specific, impact },
    goal_alignment_config: {
      alignment_threshold,
      llama_firewall_model,
      drift_detection_action,
      evaluation_frequency,
    },
  };

  const config: Record<string, unknown> = {};
  if (framework) config.framework = framework;
  if (Object.keys(config).length) body.config = config;

  if (agent_type) body.agent_type = agent_type;
  if (model_name) body.model_name = model_name;
  if (description) body.description = description;
  if (tags.length) body.tags = tags;

  process.stdout.write(`\n${chalk.gray('Creating agent...')}\n`);
  const res = await client.request('POST', '/agent/create', { body });
  process.stdout.write(`${chalk.green('✓ Agent registered.')}\n\n`);
  printResult(res.data, { format });
}

function printAivssView(agent: Record<string, unknown>): void {
  const cfg = (agent.aivss_config ?? agent.aivssConfig) as Record<string, unknown> | undefined;
  const trust = getAgentTrustScore(agent);
  const tier = getAgentTrustTier(agent);

  process.stdout.write(`${chalk.bold('Risk profile (AIVSS)')}\n`);
  process.stdout.write(`  ${chalk.cyan('Trust score'.padEnd(18))}  ${scoreColor(trust)}\n`);
  process.stdout.write(`  ${chalk.cyan('Trust tier'.padEnd(18))}  ${tierBadge(tier)}\n\n`);

  if (!cfg) {
    process.stdout.write(chalk.yellow('No AIVSS configuration found on this agent.\n'));
    return;
  }

  const sections: Array<{ title: string; weight: string; key: 'base_security' | 'ai_specific' | 'impact' }> = [
    { title: 'Base Security', weight: '25%', key: 'base_security' },
    { title: 'AI-Specific', weight: '45%', key: 'ai_specific' },
    { title: 'Impact', weight: '30%', key: 'impact' },
  ];

  for (const s of sections) {
    const section = cfg[s.key] as Record<string, unknown> | undefined;
    process.stdout.write(`${chalk.cyan(s.title)} ${chalk.gray(`(${s.weight} weight)`)}\n`);
    if (!section) {
      process.stdout.write(`  ${chalk.gray('(not set)')}\n\n`);
      continue;
    }
    for (const [k, v] of Object.entries(section)) {
      process.stdout.write(`  ${k.padEnd(24)}  ${String(v)}\n`);
    }
    process.stdout.write('\n');
  }
}

async function runAssess(agentId: string, cmd: Command, opts: { rerun?: boolean; recalculate?: boolean }): Promise<void> {
  const { client, format } = await getContext(cmd);

  if (opts.rerun) {
    process.stdout.write(`${chalk.bold('Re-run risk profile')}\n`);
    process.stdout.write(`${chalk.gray('Enter new values for the 14 parameters. Press Enter to skip.')}\n\n`);

    process.stdout.write(`${chalk.cyan('Base Security (25% weight)')}\n`);
    const base_security = {
      attack_vector: await promptNumber('  Attack Vector (1-4)', 1, 4, 1),
      attack_complexity: await promptNumber('  Attack Complexity (1-2)', 1, 2, 1),
      privileges_required: await promptNumber('  Privileges Required (1-3)', 1, 3, 1),
      user_interaction: await promptNumber('  User Interaction (1-2)', 1, 2, 1),
      scope: await promptNumber('  Scope (1-2)', 1, 2, 1),
    };

    process.stdout.write(`\n${chalk.cyan('AI-Specific (45% weight)')}\n`);
    const ai_specific = {
      model_robustness: await promptNumber('  Model Robustness', 1, 5, 2),
      data_sensitivity: await promptNumber('  Data Sensitivity', 1, 5, 3),
      ethical_impact: await promptNumber('  Ethical Impact', 1, 5, 2),
      decision_criticality: await promptNumber('  Decision Criticality', 1, 5, 3),
      adaptability: await promptNumber('  Adaptability', 1, 5, 4),
    };

    process.stdout.write(`\n${chalk.cyan('Impact (30% weight)')}\n`);
    const impact = {
      confidentiality_impact: await promptNumber('  Confidentiality', 1, 5, 2),
      integrity_impact: await promptNumber('  Integrity', 1, 5, 2),
      availability_impact: await promptNumber('  Availability', 1, 5, 2),
      safety_impact: await promptNumber('  Safety', 1, 5, 2),
    };

    const reason = await promptText('\nReason for change *', { required: true });

    const res = await client.request('PUT', `/agent/${encodeURIComponent(agentId)}/aivss`, {
      body: {
        aivss_config: { base_security, ai_specific, impact },
        reason,
      },
    });
    process.stdout.write(`${chalk.green('✓ Risk profile updated.')}\n`);
    printResult(res.data, { format });

    const recal = await confirm('Recalculate trust score now?');
    if (recal) {
      const res2 = await client.request('POST', `/agent/${encodeURIComponent(agentId)}/aivss/recalculate`);
      process.stdout.write(`${chalk.green('✓ Trust score recalculated.')}\n`);
      printResult(res2.data, { format });
    }
    return;
  }

  if (opts.recalculate) {
    const res = await client.request('POST', `/agent/${encodeURIComponent(agentId)}/aivss/recalculate`);
    process.stdout.write(`${chalk.green('✓ Trust score recalculated.')}\n`);
    printResult(res.data, { format });
    return;
  }

  const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}`);
  const agent = extractFirstObject(res.data);
  if (format === 'json') {
    printResult(res.data, { format });
    return;
  }
  if (!agent) {
    process.stdout.write(chalk.yellow('No agent data returned.\n'));
    return;
  }
  printAivssView(agent);
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command('agent').description('Agent management');

  agent
    .command('register')
    .description('Interactive wizard: name, framework, risk profile questionnaire')
    .action(async (_opts: unknown, cmd: Command) => {
      await runRegisterWizard(cmd);
    });

  agent
    .command('list')
    .description('All agents with trust score, tier badge, and last-seen')
    .option('--page <n>', 'Page number (starts from 0)', '0')
    .option('--per-page <n>', 'Items per page', '20')
    .option('--all', 'Return all agents without pagination')
    .option('--search <text>', 'Search in name and description')
    .option('--team-id <id>', 'Filter by team ID')
    .option('--tier <tiers>', 'Comma-separated tier list (e.g. 1,2)')
    .action(
      async (
        opts: { page?: string; perPage?: string; all?: boolean; search?: string; teamId?: string; tier?: string },
        cmd: Command,
      ) => {
        const { client, format } = await getContext(cmd);

        const query: Record<string, string | string[]> = {};
        if (opts.all) {
          query.all = 'true';
        } else {
          if (opts.page !== undefined) query.page = String(opts.page);
          if (opts.perPage !== undefined) query.perPage = String(opts.perPage);
        }
        if (opts.search) query.search = opts.search;
        if (opts.teamId) query.team_id = opts.teamId;
        if (opts.tier) {
          query.tiers = opts.tier.split(',').map((s) => s.trim()).filter(Boolean);
        }

        const res = await client.request('GET', '/agent/list', { query: Object.keys(query).length ? query : undefined });

        if (format === 'json') {
          printResult(res.data, { format });
          return;
        }

        const agents = extractAgentArray(res.data);
        printAgentsTable(agents);

        const paginationObj = (() => {
          if (!res.data || typeof res.data !== 'object' || Array.isArray(res.data)) return undefined;
          const top = res.data as Record<string, unknown>;
          if (top.data && typeof top.data === 'object' && !Array.isArray(top.data)) {
            return top.data as Record<string, unknown>;
          }
          return top;
        })();
        if (paginationObj) {
          const total = pickNumber(paginationObj, ['total', 'totalCount', 'count']);
          const start = pickNumber(paginationObj, ['start', 'offset', 'page', 'currentPage']);
          const limit = pickNumber(paginationObj, ['limit', 'perPage', 'pageSize']);
          if (total !== undefined || start !== undefined || limit !== undefined) {
            const parts: string[] = [];
            if (start !== undefined) parts.push(`start ${start}`);
            if (limit !== undefined) parts.push(`limit ${limit}`);
            if (total !== undefined) parts.push(`total ${total}`);
            process.stdout.write(chalk.gray(`\n${parts.join(' · ')}\n`));
          }
        }
      },
    );

  agent
    .command('inspect <agentId>')
    .description('Full agent detail: score breakdown, tier, session count')
    .action(async (agentId: string, _opts: unknown, cmd: Command) => {
      const { client, format } = await getContext(cmd);
      const res = await client.request('GET', `/agent/${encodeURIComponent(agentId)}`);

      if (format === 'json') {
        printResult(res.data, { format });
        return;
      }

      const agent = extractFirstObject(res.data);
      if (!agent) {
        process.stdout.write(chalk.yellow('No agent data returned.\n'));
        return;
      }
      printAgentDetail(agent);
    });

  agent
    .command('assess <agentId>')
    .description('View/re-run risk profile; shows 14-param score across 3 categories')
    .option('--rerun', 'Interactively re-enter the 14 AIVSS parameters and update the agent')
    .option('--recalculate', 'Only recalculate trust score with existing AIVSS config')
    .action(async (agentId: string, opts: { rerun?: boolean; recalculate?: boolean }, cmd: Command) => {
      await runAssess(agentId, cmd, opts);
    });

  agent
    .command('delete <agentId>')
    .description('Deregister agent (confirmation prompt)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (agentId: string, opts: { yes?: boolean }, cmd: Command) => {
      const { client, format } = await getContext(cmd);

      if (!opts.yes) {
        process.stdout.write(chalk.yellow(`You are about to deregister agent ${chalk.bold(agentId)}.\n`));
        const ok = await confirm('This cannot be undone. Proceed?');
        if (!ok) {
          process.stdout.write('Aborted.\n');
          return;
        }
      }

      const res = await client.request('DELETE', `/agent/${encodeURIComponent(agentId)}`);
      process.stdout.write(`${chalk.green('✓ Agent deregistered.')}\n`);
      if (res.data) printResult(res.data, { format });
    });
}
