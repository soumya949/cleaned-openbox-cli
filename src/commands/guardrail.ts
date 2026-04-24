import type { Command } from 'commander';

import chalk from 'chalk';
import Table from 'cli-table3';

import fs from 'node:fs/promises';

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

type Guardrail = {
  id?: string;
  name?: string;
  guardrail_type?: string | number;
  processing_stage?: string | number;
  is_active?: boolean;
  description?: string;
  trust_impact?: number;
  trust_threshold?: number;
  [key: string]: unknown;
};

type GuardrailPage = {
  data?: Guardrail[];
  total?: number;
  start?: number;
  limit?: number;
  [key: string]: unknown;
};

type GuardrailEnvelope = {
  status?: number;
  data?: GuardrailPage | Guardrail[];
  [key: string]: unknown;
};

// Mapping confirmed against the staging UI.
const GUARDRAIL_TYPE_LABELS: Record<string, string> = {
  '1': 'PII Detection',
  '2': 'Content Filtering',
  '3': 'Toxicity Detection',
  '4': 'Ban Words',
};

const PROCESSING_STAGE_LABELS: Record<string, string> = {
  '0': 'Pre',
  '1': 'Post',
};

function labelType(value: unknown): string {
  if (value === undefined || value === null) return 'N/A';
  const key = String(value);
  return GUARDRAIL_TYPE_LABELS[key] ?? key;
}

function labelStage(value: unknown): string {
  if (value === undefined || value === null) return 'N/A';
  const key = String(value);
  return PROCESSING_STAGE_LABELS[key] ?? key;
}

function extractGuardrails(res: unknown): Guardrail[] {
  if (Array.isArray(res)) return res as Guardrail[];
  if (!res || typeof res !== 'object') return [];
  const envelope = res as GuardrailEnvelope;
  const inner = envelope.data;
  if (Array.isArray(inner)) return inner;
  if (inner && typeof inner === 'object' && Array.isArray((inner as GuardrailPage).data)) {
    return (inner as GuardrailPage).data as Guardrail[];
  }
  return [];
}

function printGuardrailTable(guardrails: Guardrail[]): void {
  if (guardrails.length === 0) {
    process.stdout.write('No guardrails found (N/A).\n');
    return;
  }

  const table = new Table({
    head: [
      chalk.cyan('Name'),
      chalk.cyan('Type'),
      chalk.cyan('Stage'),
      chalk.cyan('Enabled'),
    ],
    colWidths: [30, 18, 16, 10],
    wordWrap: true,
  });

  for (const g of guardrails) {
    const enabled = g.is_active !== false;
    table.push([
      g.name ?? '-',
      labelType(g.guardrail_type),
      labelStage(g.processing_stage),
      enabled ? chalk.green('Yes') : chalk.red('No'),
    ]);
  }

  process.stdout.write(`${table.toString()}\n`);
  process.stdout.write(chalk.gray(`\nTotal: ${guardrails.length} guardrail(s)\n`));
}

export function registerGuardrailCommands(program: Command): void {
  const guardrail = program.command('guardrail').description('Guardrail management commands');

  guardrail
    .command('list')
    .description('List PII/Content/Toxicity/BanWord rules with enabled state')
    .argument('<agent-id>', 'Agent ID')
    .option('--page <number>', 'Page number')
    .option('--per-page <number>', 'Results per page')
    .option('--processing-stage <stage>', 'Filter by processing stage')
    .action(async (agentId: string, opts: { page?: string; perPage?: string; processingStage?: string }, cmd: Command) => {
      const cfg = await readConfig();
      const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
      const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
      const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;
      const format = getOutputFormat(cmd);

      const client = new OpenBoxClient({ baseUrl, token });

      const query: Record<string, string> = {};
      if (opts.page) query.page = opts.page;
      if (opts.perPage) query.perPage = opts.perPage;
      if (opts.processingStage) query.processing_stage = opts.processingStage;

      const res = await client.requestJson<unknown>('GET', `/agent/${encodeURIComponent(agentId)}/guardrails`, {
        query: Object.keys(query).length ? query : undefined,
      });

      const guardrails = extractGuardrails(res);

      if (format === 'json') {
        printResult(res, { format });
        return;
      }

      printGuardrailTable(guardrails);
    });

  guardrail
    .command('create')
    .description('Interactive: type, pre/post, fields-to-check, thresholds')
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

      const name = (await prompt('Name: ')).trim();
      if (!name) throw new Error('Name is required.');

      const description = (await prompt('Description (optional): ')).trim();

      process.stdout.write(
        '\nType:\n  1) PII Detection\n  2) Content Filtering\n  3) Toxicity Detection\n  4) Ban Words\n',
      );
      const typeInput = (await prompt('Choose type [1-4]: ')).trim();
      if (!['1', '2', '3', '4'].includes(typeInput)) {
        throw new Error('Type must be 1, 2, 3, or 4.');
      }
      const guardrailType = typeInput;

      process.stdout.write('\nProcessing stage:\n  0) Pre (input)\n  1) Post (output)\n');
      const stageInput = (await prompt('Choose stage [0-1]: ')).trim();
      if (!['0', '1'].includes(stageInput)) {
        throw new Error('Stage must be 0 or 1.');
      }
      const processingStage = stageInput;
      const isPre = processingStage === '0';

      // Type-specific params
      let params: Record<string, unknown> = {};
      if (guardrailType === '1') {
        // PII Detection
        const entitiesRaw = (await prompt(
          'Entities to detect (comma-separated, e.g. US_PASSPORT,PHONE_NUMBER,US_DRIVER_LICENSE): ',
        )).trim();
        const entities = entitiesRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (entities.length === 0) throw new Error('At least one entity is required.');
        const replaceRaw = (await prompt(
          'Replacement values (comma-separated, blank = auto <ENTITY>): ',
        )).trim();
        const replace_values = replaceRaw
          ? replaceRaw.split(',').map((s) => s.trim())
          : entities.map((e) => `<${e}>`);
        params = { entities, replace_values };
      } else if (guardrailType === '2' || guardrailType === '3') {
        // Content Filtering / Toxicity Detection
        const thresholdStr = (await prompt('Threshold (0.0 - 1.0) [0.8]: ')).trim() || '0.8';
        const threshold = Number(thresholdStr);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
          throw new Error('Threshold must be a number between 0 and 1.');
        }
        const validation_method =
          (await prompt('Validation method [sentence]: ')).trim() || 'sentence';
        params = { threshold, validation_method };
      } else {
        // Ban Words
        const wordsRaw = (await prompt('Banned words (comma-separated): ')).trim();
        const banned_words = wordsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (banned_words.length === 0) throw new Error('At least one banned word is required.');
        const distStr = (await prompt('Max Levenshtein distance (integer) [1]: ')).trim() || '1';
        const max_l_dist = Number.parseInt(distStr, 10);
        if (!Number.isInteger(max_l_dist) || max_l_dist < 0) {
          throw new Error('max_l_dist must be a non-negative integer.');
        }
        params = { max_l_dist, banned_words };
      }

      // Fields to check (with stage-appropriate defaults)
      const defaultFields = isPre ? 'input.prompt,input.*.prompt' : 'output.response,output.*.response';
      const fieldsRaw =
        (await prompt(`Fields to check (comma-separated) [${defaultFields}]: `)).trim() ||
        defaultFields;
      const fields_to_check = fieldsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const defaultActivity = isPre ? 'agent_validatePrompt' : 'agent_toolPlanner';
      const activity_type =
        (await prompt(`Activity type [${defaultActivity}]: `)).trim() || defaultActivity;

      // Settings
      const onFailStr = (await prompt('On fail (0=warn, 1=block) [1]: ')).trim() || '1';
      const on_fail = Number.parseInt(onFailStr, 10);
      const timeoutStr = (await prompt('Timeout ms [5000]: ')).trim() || '5000';
      const timeout = Number.parseInt(timeoutStr, 10);
      const retriesStr = (await prompt('Retry attempts [3]: ')).trim() || '3';
      const retry_attempts = Number.parseInt(retriesStr, 10);
      const logStr = (await prompt('Log violations? (y/n) [y]: ')).trim().toLowerCase();
      const log_violation = logStr === '' || logStr === 'y' || logStr === 'yes';

      // Trust
      const trustImpact =
        (await prompt('Trust impact (none/low/medium/high) [none]: ')).trim() || 'none';
      const trustThresholdStr = (await prompt('Trust threshold (blank = none): ')).trim();
      const trust_threshold = trustThresholdStr ? Number(trustThresholdStr) : null;
      if (trustThresholdStr && !Number.isFinite(trust_threshold as number)) {
        throw new Error('Trust threshold must be a number.');
      }

      const body = {
        name,
        description: description || undefined,
        guardrail_type: guardrailType,
        processing_stage: processingStage,
        is_active: true,
        params,
        settings: {
          on_fail,
          timeout,
          activities: [{ activity_type, fields_to_check }],
          log_violation,
          retry_attempts,
        },
        trust_impact: trustImpact,
        trust_threshold,
      };

      process.stdout.write('\nPayload to be sent:\n');
      process.stdout.write(`${JSON.stringify(body, null, 2)}\n\n`);
      const confirm = (await prompt('Create this guardrail? (y/n): ')).trim().toLowerCase();
      if (confirm !== 'y' && confirm !== 'yes') {
        process.stdout.write('Aborted.\n');
        return;
      }

      const res = await client.requestJson<unknown>(
        'POST',
        `/agent/${encodeURIComponent(agentId)}/guardrails`,
        { body },
      );

      if (format === 'json') {
        printResult(res, { format });
        return;
      }

      const created =
        res && typeof res === 'object' && 'data' in (res as Record<string, unknown>)
          ? ((res as Record<string, unknown>).data as Record<string, unknown>)
          : (res as Record<string, unknown>);
      const createdId = typeof created?.id === 'string' ? created.id : undefined;
      process.stdout.write(chalk.green('Guardrail created.\n'));
      if (createdId) process.stdout.write(`ID: ${createdId}\n`);
      process.stdout.write(`Name: ${name}\nType: ${labelType(guardrailType)}\nStage: ${labelStage(processingStage)}\n`);
    });

  guardrail
    .command('test')
    .description('Send test payload JSON; show raw → validated output')
    .argument('<agent-id>', 'Agent ID')
    .argument('<guardrail-id>', 'Guardrail ID to test')
    .option('--data <json>', 'Test payload (logs) as JSON string')
    .option('--data-file <path>', 'Test payload (logs) as JSON file')
    .action(async (
      agentId: string,
      guardrailId: string,
      opts: { data?: string; dataFile?: string },
      cmd: Command,
    ) => {
      const cfg = await readConfig();
      const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
      const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
      const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;
      const format = getOutputFormat(cmd);

      const client = new OpenBoxClient({ baseUrl, token });

      // Obtain test payload (logs)
      let logsRaw: string;
      if (opts.dataFile) {
        logsRaw = await fs.readFile(opts.dataFile, 'utf8');
      } else if (opts.data) {
        logsRaw = opts.data;
      } else {
        process.stdout.write(
          'Paste test payload JSON (e.g. {"input":{"prompt":"..."}} for pre, {"output":{"response":"..."}} for post).\n',
        );
        logsRaw = await prompt('Test payload JSON: ');
      }

      let logs: unknown;
      try {
        logs = JSON.parse(logsRaw);
      } catch (e) {
        throw new Error(`Invalid JSON in test payload: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Fetch the guardrail to get its type/params/settings
      const guardrailRes = await client.requestJson<unknown>(
        'GET',
        `/agent/${encodeURIComponent(agentId)}/guardrails/${encodeURIComponent(guardrailId)}`,
      );

      const guardrail =
        guardrailRes && typeof guardrailRes === 'object' && 'data' in (guardrailRes as Record<string, unknown>)
          ? ((guardrailRes as Record<string, unknown>).data as Guardrail)
          : (guardrailRes as Guardrail);

      if (!guardrail || typeof guardrail !== 'object' || !guardrail.guardrail_type) {
        throw new Error('Could not resolve guardrail definition from API response.');
      }

      const body = {
        guardrail_type: String(guardrail.guardrail_type),
        params: (guardrail as Record<string, unknown>).params ?? {},
        settings: (guardrail as Record<string, unknown>).settings ?? {},
        logs,
      };

      const res = await client.requestJson<unknown>('POST', '/guardrails/run-test', { body });

      if (format === 'json') {
        printResult(res, { format });
        return;
      }

      const resultData =
        res && typeof res === 'object' && 'data' in (res as Record<string, unknown>)
          ? (res as Record<string, unknown>).data
          : res;

      process.stdout.write(chalk.cyan('\nGuardrail: ') + `${guardrail.name ?? guardrailId}\n`);
      process.stdout.write(
        chalk.cyan('Type:      ') + `${labelType(guardrail.guardrail_type)}\n`,
      );
      process.stdout.write(
        chalk.cyan('Stage:     ') + `${labelStage(guardrail.processing_stage)}\n`,
      );

      process.stdout.write(chalk.cyan('\nRaw input:\n'));
      process.stdout.write(`${JSON.stringify(logs, null, 2)}\n`);

      process.stdout.write(chalk.cyan('\nValidated output:\n'));
      process.stdout.write(`${JSON.stringify(resultData, null, 2)}\n`);
    });

  // Commander maps `--no-X` to `opts.x = false`, so undefined means "unchanged".
  type ToggleOpts = {
    block?: boolean;
    log?: boolean;
  };

  async function toggleGuardrail(
    agentId: string,
    guardrailId: string,
    isActive: boolean,
    opts: ToggleOpts,
    cmd: Command,
  ): Promise<void> {
    const cfg = await readConfig();
    const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
    const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
    const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;
    const format = getOutputFormat(cmd);

    const client = new OpenBoxClient({ baseUrl, token });

    const body: Record<string, unknown> = { is_active: isActive };

    // If user wants to also toggle settings flags, fetch current settings and merge
    const wantsSettingsChange = opts.block !== undefined || opts.log !== undefined;

    if (wantsSettingsChange) {
      const currentRes = await client.requestJson<unknown>(
        'GET',
        `/agent/${encodeURIComponent(agentId)}/guardrails/${encodeURIComponent(guardrailId)}`,
      );
      const current =
        currentRes && typeof currentRes === 'object' && 'data' in (currentRes as Record<string, unknown>)
          ? ((currentRes as Record<string, unknown>).data as Guardrail)
          : (currentRes as Guardrail);
      const currentSettings =
        (current as Record<string, unknown>)?.settings && typeof (current as Record<string, unknown>).settings === 'object'
          ? { ...((current as Record<string, unknown>).settings as Record<string, unknown>) }
          : {};

      if (opts.block === true) currentSettings.on_fail = 1;
      if (opts.block === false) currentSettings.on_fail = 0;
      if (opts.log === true) currentSettings.log_violation = true;
      if (opts.log === false) currentSettings.log_violation = false;

      body.settings = currentSettings;
    }

    const res = await client.requestJson<unknown>(
      'PUT',
      `/agent/${encodeURIComponent(agentId)}/guardrails/${encodeURIComponent(guardrailId)}`,
      { body },
    );

    if (format === 'json') {
      printResult(res, { format });
      return;
    }

    const updated =
      res && typeof res === 'object' && 'data' in (res as Record<string, unknown>)
        ? ((res as Record<string, unknown>).data as Guardrail)
        : (res as Guardrail);

    const name = (updated as Record<string, unknown>)?.name ?? guardrailId;
    const settings = (updated as Record<string, unknown>)?.settings as Record<string, unknown> | undefined;

    process.stdout.write(
      (isActive ? chalk.green('Enabled') : chalk.yellow('Disabled')) + ` guardrail: ${name}\n`,
    );
    process.stdout.write(`ID:                  ${guardrailId}\n`);
    process.stdout.write(`is_active:           ${updated?.is_active}\n`);
    if (settings) {
      if ('on_fail' in settings) {
        process.stdout.write(
          `block-on-violation:  ${settings.on_fail === 1 ? 'Yes' : 'No'} (on_fail=${settings.on_fail})\n`,
        );
      }
      if ('log_violation' in settings) {
        process.stdout.write(`log-violations:      ${settings.log_violation}\n`);
      }
    }
  }

  guardrail
    .command('enable')
    .description('Enable a guardrail; optionally toggle block-on-violation / log-violations')
    .argument('<agent-id>', 'Agent ID')
    .argument('<guardrail-id>', 'Guardrail ID')
    .option('--block', 'Set block-on-violation (on_fail=1)')
    .option('--no-block', 'Set warn-only (on_fail=0)')
    .option('--log', 'Enable log-violations')
    .option('--no-log', 'Disable log-violations')
    .action(async (agentId: string, guardrailId: string, opts: ToggleOpts, cmd: Command) => {
      await toggleGuardrail(agentId, guardrailId, true, opts, cmd);
    });

  guardrail
    .command('disable')
    .description('Disable a guardrail; optionally toggle block-on-violation / log-violations')
    .argument('<agent-id>', 'Agent ID')
    .argument('<guardrail-id>', 'Guardrail ID')
    .option('--block', 'Set block-on-violation (on_fail=1)')
    .option('--no-block', 'Set warn-only (on_fail=0)')
    .option('--log', 'Enable log-violations')
    .option('--no-log', 'Disable log-violations')
    .action(async (agentId: string, guardrailId: string, opts: ToggleOpts, cmd: Command) => {
      await toggleGuardrail(agentId, guardrailId, false, opts, cmd);
    });
}
