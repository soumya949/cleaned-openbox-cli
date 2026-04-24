import type { Command } from 'commander';

import fs from 'node:fs/promises';

import { readConfig, resolveBaseUrl } from '../lib/config';
import { getSpec, type OpenApiSpec } from '../lib/openapi';
import { OpenBoxClient } from '../lib/openboxClient';
import { printResult, type OutputFormat } from '../lib/output';

type GlobalOpts = {
  json?: boolean;
  baseUrl?: string;
  token?: string;
};

function toKebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .toLowerCase();
}

function toCamel(input: string): string {
  return input.replace(/-([a-z])/g, (_m, p1: string) => p1.toUpperCase());
}

function isParamSegment(seg: string): boolean {
  return seg.startsWith('{') && seg.endsWith('}');
}

function paramName(seg: string): string {
  return seg.slice(1, -1);
}

function uniqueName(existing: Set<string>, base: string): string {
  if (!existing.has(base)) {
    existing.add(base);
    return base;
  }

  let i = 2;
  while (existing.has(`${base}-${i}`)) {
    i += 1;
  }
  const name = `${base}-${i}`;
  existing.add(name);
  return name;
}

function coerceQueryValue(value: unknown): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

async function readBodyFromOptions(opts: { data?: string; dataFile?: string }): Promise<unknown> {
  if (opts.dataFile) {
    const raw = await fs.readFile(opts.dataFile, 'utf8');
    return JSON.parse(raw) as unknown;
  }
  if (opts.data) {
    return JSON.parse(opts.data) as unknown;
  }
  return undefined;
}

function inferGroup(path: string, operation: Record<string, unknown>): string {
  const tags = operation.tags;
  if (Array.isArray(tags) && tags.length > 0) {
    return toKebab(String(tags[0]));
  }
  const segs = path.split('/').filter(Boolean);
  return toKebab(segs[0] ?? 'api');
}

function inferCommandName(operation: Record<string, unknown>, method: string, path: string): string {
  const opId = typeof operation.operationId === 'string' ? operation.operationId : `${method}_${path}`;
  const tail = opId.split('_').slice(-1)[0] ?? opId;
  return toKebab(tail);
}

function groupAliases(group: string): string[] {
  if (group === 'organization') {
    return ['org'];
  }
  if (group === 'api-keys') {
    return ['api-key'];
  }
  return [];
}

function commandAliases(group: string, method: string, pathTemplate: string, cmdName: string): string[] {
  if (group === 'user' && method === 'get' && pathTemplate === '/user/roles') {
    return ['roles'];
  }

  if (group === 'agent') {
    if (method === 'get' && pathTemplate === '/agent/list') {
      return ['list'];
    }
    if (method === 'post' && pathTemplate === '/agent/create') {
      return ['create'];
    }
    if (pathTemplate === '/agent/{agentId}') {
      if (method === 'get') return ['get'];
      if (method === 'put') return ['update'];
      if (method === 'delete') return ['delete'];
    }

    if (method === 'get' && pathTemplate === '/agent/metrics') {
      return ['metrics'];
    }
    if (method === 'get' && pathTemplate === '/agent/violations') {
      return ['violations'];
    }
  }

  if (group === 'webhook' && method === 'get' && pathTemplate === '/webhook/{id}/deliveries') {
    return ['deliveries'];
  }
  if (group === 'webhook' && method === 'post' && pathTemplate === '/webhook/{id}/regenerate-secret') {
    return ['regenerate'];
  }

  if (group === 'organization' && method === 'post' && pathTemplate === '/organization/register') {
    return ['register'];
  }

  if (group === 'policy' && cmdName === 'evaluate') {
    return ['eval'];
  }

  return [];
}

function extractPathParams(path: string): string[] {
  const segs = path.split('/').filter(Boolean);
  const params: string[] = [];
  for (const s of segs) {
    if (isParamSegment(s)) {
      params.push(paramName(s));
    }
  }
  return params;
}

function buildPath(pathTemplate: string, args: Record<string, string>): string {
  return pathTemplate.replace(/\{([^}]+)\}/g, (_m, p1: string) => encodeURIComponent(args[p1] ?? ''));
}

function extractQueryParams(parameters: unknown[], cmdOpts: Record<string, unknown>): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};

  for (const p of parameters) {
    if (!p || typeof p !== 'object') continue;
    const po = p as Record<string, unknown>;
    if (po.in !== 'query') continue;
    const name = String(po.name ?? '');
    if (!name) continue;

    const flag = toKebab(name);
    const camel = toCamel(flag);
    const v = (cmdOpts[camel] ?? cmdOpts[flag] ?? cmdOpts[name] ?? cmdOpts[toCamel(name)]) as unknown;

    const schema = po.schema as Record<string, unknown> | undefined;
    const schemaType = schema && typeof schema.type === 'string' ? schema.type : undefined;

    if (schemaType === 'array' && typeof v === 'string') {
      const arr = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (arr.length) {
        query[name] = arr;
      }
      continue;
    }

    const coerced = coerceQueryValue(v);
    if (coerced !== undefined) {
      query[name] = coerced;
    }
  }

  return query;
}

export async function registerGeneratedApiCommands(program: Command): Promise<void> {
  const cfg = await readConfig();
  const baseUrl = resolveBaseUrl(cfg);
  const spec = await getSpec(baseUrl);
  registerFromSpec(program, spec);
}

function registerFromSpec(program: Command, spec: OpenApiSpec): void {
  const groups = new Map<string, Command>();
  const groupNames = new Map<string, Set<string>>();

  for (const [pathTemplate, methods] of Object.entries(spec.paths ?? {})) {
    for (const [methodRaw, op] of Object.entries(methods ?? {})) {
      const method = methodRaw.toLowerCase();
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        continue;
      }

      const operation = op as Record<string, unknown>;
      const parameters = (operation.parameters as unknown[]) ?? [];
      const hasBody = Boolean(operation.requestBody);

      const group = inferGroup(pathTemplate, operation);

      // We provide a dedicated top-level `openbox health` command.
      // Avoid colliding with the Swagger 'Health' tag group.
      if (group === 'health') {
        continue;
      }

      // We provide a dedicated `openbox auth ...` command group with an
      // interactive login flow (reCAPTCHA) matching the web UI.
      if (group === 'auth') {
        continue;
      }

      // We provide a dedicated `openbox guardrail ...` command group.
      if (group === 'guardrail' || group === 'guardrails') {
        continue;
      }

      // Skip any group name that is already registered as a manual top-level
      // command (e.g. agent, policy, verify, approvals, insights, rule,
      // session, sessions, monitor, config, creds, init, spec, status,
      // whoami). Prevents "cannot add command 'x' as already have command 'x'"
      // commander errors when the OpenAPI spec produces a group with the same
      // name.
      if (!groups.has(group) && program.commands.some((c) => c.name() === group || c.aliases().includes(group))) {
        continue;
      }

      const cmdBaseName = inferCommandName(operation, method, pathTemplate);
      const pathParams = extractPathParams(pathTemplate);

      const existingGroup = groups.get(group);
      const groupCmd = existingGroup ?? program.command(group).description(`${group} API`);
      if (!existingGroup) {
        for (const a of groupAliases(group)) {
          groupCmd.alias(a);
        }
        groups.set(group, groupCmd);
      }

      const existing = groupNames.get(group) ?? new Set<string>();
      groupNames.set(group, existing);

      const cmdName = uniqueName(existing, cmdBaseName);

      let cmd = groupCmd.command(cmdName);

      for (const a of commandAliases(group, method, pathTemplate, cmdName)) {
        cmd.alias(a);
      }
      cmd = cmd.description(`${method.toUpperCase()} ${pathTemplate}`);

      // Path params as arguments
      for (const p of pathParams) {
        cmd = cmd.argument(`<${toKebab(p)}>`);
      }

      // Query params as options
      for (const p of parameters) {
        if (!p || typeof p !== 'object') continue;
        const po = p as Record<string, unknown>;
        if (po.in !== 'query') continue;
        const name = String(po.name ?? '');
        const flag = toKebab(name);
        const desc = typeof po.description === 'string' ? po.description : '';

        const schema = po.schema as Record<string, unknown> | undefined;
        const schemaType = schema && typeof schema.type === 'string' ? schema.type : undefined;

        if (schemaType === 'boolean') {
          cmd = cmd.option(`--${flag}`, desc);
        } else {
          cmd = cmd.option(`--${flag} <value>`, desc);
        }
      }

      // Body input
      if (hasBody) {
        cmd = cmd.option('--data <json>', 'Request body as JSON string').option('--data-file <path>', 'Request body as JSON file');
      }

      // Output / raw handling
      cmd = cmd.option('--out <file>', 'Write binary response to file (for downloads)');

      cmd.action(async (...actionArgs: unknown[]) => {
        const last = actionArgs[actionArgs.length - 1] as Command;
        const cmdOpts = last.opts() as Record<string, unknown>;
        const global = (last.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);

        const cfg2 = await readConfig();
        const baseUrl2 = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg2)).replace(/\/$/, '');

        const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg2.token;
        const format: OutputFormat = global.json ? 'json' : 'pretty';

        const client = new OpenBoxClient({ baseUrl: baseUrl2, token });

        const argValues = actionArgs.slice(0, -1).map((a) => String(a));
        const argMap: Record<string, string> = {};
        for (let i = 0; i < pathParams.length; i += 1) {
          argMap[pathParams[i]] = argValues[i] ?? '';
        }

        const pathname = buildPath(pathTemplate, argMap);
        const query = extractQueryParams(parameters, cmdOpts);
        const body = await readBodyFromOptions(cmdOpts as { data?: string; dataFile?: string });

        const res = await client.request(method.toUpperCase(), pathname, {
          query: Object.keys(query).length ? query : undefined,
          body,
        });

        const outPath = typeof cmdOpts.out === 'string' ? cmdOpts.out : undefined;
        if (outPath && res.data instanceof Buffer) {
          const buf = res.data as Buffer;
          await fs.writeFile(outPath, buf);
          process.stdout.write(`Wrote ${buf.byteLength} bytes to ${outPath}\n`);
          return;
        }

        printResult(res.data, { format });
      });
    }
  }
}
