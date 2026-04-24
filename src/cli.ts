import { Command } from 'commander';

import fs from 'node:fs';
import path from 'node:path';

import { registerAuthCommands } from './commands/auth';
import { registerGeneratedApiCommands } from './commands/apiGenerated';
import { registerConfigCommands } from './commands/config';
import { registerCredsCommands } from './commands/creds';
import { registerHealthCommand } from './commands/health';
import { registerInitCommand } from './commands/init';
import { registerSpecCommands } from './commands/spec';
import { registerStatusCommand } from './commands/status';
import { registerWhoamiCommand } from './commands/whoami';
import { registerGuardrailCommands } from './commands/guardrail';
import { registerRuleCommands } from './commands/rule';
import { registerSessionCommands } from './commands/session';
import { registerMonitorCommand } from './commands/monitor';
import { registerAgentCommands } from './commands/agent';
import { registerPolicyCommands } from './commands/policy';
import { registerVerifyCommands } from './commands/verify';
import { registerApprovalsCommands } from './commands/approvals';
import { registerInsightsCommands } from './commands/insights';

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
// checking chenges
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('openbox')
    .description('OpenBox CLI')
    .version(getVersion());

  program
    .option('--json', 'Output raw JSON')
    .option('--base-url <url>', 'Override API base URL (or set OPENBOX_BASE_URL)')
    .option('--token <token>', 'Override bearer token (or set OPENBOX_TOKEN)');

  registerConfigCommands(program);
  registerCredsCommands(program);
  registerAuthCommands(program);
  registerHealthCommand(program);
  registerInitCommand(program);
  registerSpecCommands(program);
  registerStatusCommand(program);
  registerWhoamiCommand(program);
  registerAgentCommands(program);
  registerGuardrailCommands(program);
  registerRuleCommands(program);
  registerPolicyCommands(program);
  registerVerifyCommands(program);
  registerApprovalsCommands(program);
  registerInsightsCommands(program);
  registerSessionCommands(program);
  registerMonitorCommand(program);

  await registerGeneratedApiCommands(program);

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
