import type { Command } from 'commander';

import { exec } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

import { OpenBoxClient } from '../lib/openboxClient';
import { prompt } from '../lib/prompt';
import { readConfig, resolveBaseUrl, updateConfig, writeConfig } from '../lib/config';
import { printResult, type OutputFormat } from '../lib/output';

const DEFAULT_RECAPTCHA_SITE_KEY = '6LeNyFosAAAAAKJWRGrC7_onDnhqmdQ-aM92k-Mh';
const DEFAULT_PLATFORM_URL = 'https://openbox.node.lat';

type GlobalOpts = {
  json?: boolean;
  baseUrl?: string;
  token?: string;
};

function getOutputFormat(cmd: Command): OutputFormat {
  const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (cmd.parent?.opts() as GlobalOpts);
  return global?.json ? 'json' : 'pretty';
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const quoted = `"${url.replace(/"/g, '\\"')}"`;

    let cmd: string;
    if (process.platform === 'win32') {
      cmd = `cmd /c start "" ${quoted}`;
    } else if (process.platform === 'darwin') {
      cmd = `open ${quoted}`;
    } else {
      cmd = `xdg-open ${quoted}`;
    }

    exec(cmd, () => resolve());
  });
}

function readClipboard(): Promise<string> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    if (process.platform === 'win32') {
      cmd = 'powershell -NoProfile -Command "Get-Clipboard -Raw"';
    } else if (process.platform === 'darwin') {
      cmd = 'pbpaste';
    } else {
      cmd = 'wl-paste -n';
    }

    exec(cmd, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (!err) {
        resolve(stdout);
        return;
      }

      if (process.platform !== 'win32' && process.platform !== 'darwin') {
        exec('xclip -selection clipboard -o', { maxBuffer: 5 * 1024 * 1024 }, (err2, stdout2) => {
          if (err2) {
            reject(err);
            return;
          }
          resolve(stdout2);
        });
        return;
      }

      reject(err);
    });
  });
}

async function pasteFromStdin(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  process.stdout.write(question);

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    const lines: string[] = [];
    let idleTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      rl.close();
      resolve(lines.join(''));
    };

    const onLine = (line: string) => {
      if (line === '' && lines.length > 0) {
        finish();
        return;
      }

      lines.push(line);

      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(finish, 1500);
    };

    rl.on('line', onLine);
    rl.on('close', () => resolve(lines.join('')));
  });
}

async function getRecaptchaToken(siteKey: string): Promise<string> {
  const state = randomBytes(16).toString('hex');
  let resolveToken: ((t: string) => void) | undefined;
  let rejectToken: ((e: Error) => void) | undefined;

  const tokenPromise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const timeout = setTimeout(() => {
    rejectToken?.(new Error('Timed out waiting for reCAPTCHA.'));
  }, 5 * 60 * 1000);

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenBox CLI Login</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; padding: 20px; }
      .box { max-width: 520px; margin: 0 auto; }
      button { padding: 10px 14px; font-size: 14px; cursor: pointer; }
      .muted { color: #555; font-size: 13px; }
      .err { color: #b00020; font-size: 13px; }
    </style>
    <script src="https://www.google.com/recaptcha/api.js" async defer></script>
  </head>
  <body>
    <div class="box">
      <h2>Verify reCAPTCHA</h2>
      <p class="muted">Complete the reCAPTCHA challenge, then click Continue.</p>
      <div class="g-recaptcha" data-sitekey="${siteKey}"></div>
      <div style="margin-top: 12px; display: flex; gap: 8px; align-items: center;">
        <button id="btn" type="button">Continue</button>
        <span id="status" class="muted"></span>
      </div>
      <p id="err" class="err"></p>
    </div>
    <script>
      const btn = document.getElementById('btn');
      const status = document.getElementById('status');
      const err = document.getElementById('err');

      btn.addEventListener('click', async () => {
        err.textContent = '';
        const token = (window.grecaptcha && window.grecaptcha.getResponse) ? window.grecaptcha.getResponse() : '';
        if (!token) {
          err.textContent = 'Please complete the reCAPTCHA first.';
          return;
        }

        status.textContent = 'Sending token to CLI...';
        try {
          const resp = await fetch('/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ state: '${state}', token })
          });
          if (!resp.ok) throw new Error('Failed to send token');
          status.textContent = 'Done. You can close this window.';
        } catch (e) {
          err.textContent = String(e);
          status.textContent = '';
        }
      });
    </script>
  </body>
</html>`);
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { state?: string; token?: string };
          if (parsed.state !== state || !parsed.token) {
            res.statusCode = 400;
            res.end('Bad request');
            return;
          }

          res.statusCode = 200;
          res.end('OK');
          resolveToken?.(parsed.token);
        } catch (e) {
          res.statusCode = 400;
          res.end('Bad request');
          rejectToken?.(e instanceof Error ? e : new Error('Invalid request'));
        }
      });
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('Failed to start local reCAPTCHA server.');
  }

  const url = `http://127.0.0.1:${addr.port}/`;
  process.stdout.write(`Open this URL to complete reCAPTCHA:\n${url}\n`);
  await openBrowser(url);

  try {
    return await tokenPromise;
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

function findAccessToken(data: unknown): string | undefined {
  if (!data) {
    return undefined;
  }
  if (typeof data === 'string') {
    return data.trim() ? data : undefined;
  }
  if (typeof data !== 'object') {
    return undefined;
  }

  const obj = data as Record<string, unknown>;
  const candidates = ['accessToken', 'access_token', 'token', 'jwt', 'bearerToken'];
  for (const k of candidates) {
    if (typeof obj[k] === 'string' && obj[k]) {
      return obj[k];
    }
  }
  if (obj.data) {
    return findAccessToken(obj.data);
  }
  if (obj.result) {
    return findAccessToken(obj.result);
  }
  return undefined;
}

function extractJwtFromText(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const token = findAccessToken(parsed);
      if (token) return token;
    } catch {
      // ignore
    }
  }

  const match = trimmed.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (match && match[0]) {
    return match[0];
  }

  return findAccessToken(trimmed);
}

function extractJwtRobust(input: string): string | undefined {
  const candidates = [
    input,
    input.replace(/\s+/g, ''),
    input.replace(/[^A-Za-z0-9._-]+/g, ''),
  ];
  for (const c of candidates) {
    const t = extractJwtFromText(c);
    if (t) return t;
  }
  return undefined;
}

async function waitForClipboardJwt(opts: { timeoutMs: number; pollMs: number; requireChangeFrom?: string }): Promise<string> {
  const start = Date.now();
  let lastRaw = '';

  while (Date.now() - start < opts.timeoutMs) {
    let raw = '';
    try {
      raw = await readClipboard();
    } catch {
      raw = '';
    }

    if (raw && raw !== lastRaw) {
      lastRaw = raw;
      const jwt = extractJwtRobust(raw);
      if (jwt && (!opts.requireChangeFrom || jwt !== opts.requireChangeFrom)) {
        return jwt;
      }
    }

    await new Promise((r) => setTimeout(r, opts.pollMs));
  }

  throw new Error('Timed out waiting for a token in clipboard.');
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication commands');

  auth
    .command('login')
    .description('Login via browser and store token locally')
    .option('--realm <realm>', 'Organization name (realm)')
    .option('--platform-url <url>', 'Override platform URL (or set OPENBOX_PLATFORM_URL)')
    .option('--direct', 'Login by calling OpenBox API /auth/login directly (advanced)')
    .option('--username <email>', 'Email address (direct mode)')
    .option('--password <password>', 'Password (direct mode)')
    .option('--recaptcha-token <token>', 'Provide a reCAPTCHA token manually (advanced)')
    .option('--recaptcha-site-key <siteKey>', 'Override reCAPTCHA site key (advanced)')
    .action(async (opts: { realm?: string; platformUrl?: string; direct?: boolean; username?: string; password?: string; recaptchaToken?: string; recaptchaSiteKey?: string }, cmd: Command) => {
      const cfg = await readConfig();
      const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
      const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');

      const realm = opts.realm?.trim() ?? (await prompt('Organization (realm): ')).trim();
      if (!realm) {
        throw new Error('realm is required.');
      }

      if (!opts.direct) {
        const platformUrl = (opts.platformUrl ?? process.env.OPENBOX_PLATFORM_URL ?? DEFAULT_PLATFORM_URL).replace(/\/$/, '');
        const loginUrl = `${platformUrl}/login?orgId=${encodeURIComponent(realm)}`;

        process.stdout.write(`A browser window will open for login:\n${loginUrl}\n`);
        await openBrowser(loginUrl);

        await prompt('After you complete login in the browser, press Enter to continue...');

        process.stdout.write(
          `\nTo get your token, open DevTools in the same browser (F12), go to the Console tab, and run:\n` +
          `  JSON.parse(localStorage.getItem('openbox.auth')).token\n` +
          `\nCopy the output value.\n`,
        );

        const raw = await pasteFromStdin('Paste token: ');
        const pasted = extractJwtRobust(raw) ?? raw.trim().replace(/^"|"$/g, '');
        if (!pasted) {
          throw new Error('Token is required.');
        }

        await updateConfig({ token: pasted });
        process.stdout.write('Logged in.\n');
        return;
      }

      const username = opts.username?.trim() ?? (await prompt('Email: ')).trim();
      const password = opts.password ?? (await prompt('Password: '));

      if (!username) {
        throw new Error('username is required.');
      }
      if (!password) {
        throw new Error('password is required.');
      }

      const siteKey = opts.recaptchaSiteKey?.trim() ?? process.env.OPENBOX_RECAPTCHA_SITE_KEY ?? DEFAULT_RECAPTCHA_SITE_KEY;
      const recaptchaToken = opts.recaptchaToken?.trim() ?? (await getRecaptchaToken(siteKey));

      const client = new OpenBoxClient({ baseUrl });
      const result = await client.requestJson<unknown>('POST', '/auth/login', {
        body: {
          realm,
          username,
          password,
          recaptchaToken,
        },
      });

      const token = findAccessToken(result);
      if (!token) {
        const format = getOutputFormat(cmd);
        process.stderr.write('Login response did not include an access token. Raw response:\n');
        printResult(result, { format });
        throw new Error('Login succeeded but no bearer token was found in response.');
      }

      await updateConfig({ token });
      process.stdout.write('Logged in.\n');
    });

  auth
    .command('logout')
    .description('Logout and remove locally stored token')
    .action(async (_opts: unknown, cmd: Command) => {
      const cfg = await readConfig();
      const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
      const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
      const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;

      if (token) {
        try {
          const client = new OpenBoxClient({ baseUrl, token });
          await client.request('POST', '/auth/logout', { body: {} });
        } catch {
          // Ignore API errors — always clear local state
        }
      }

      const { token: _token, ...rest } = cfg;
      await writeConfig(rest);
      process.stdout.write('Logged out.\n');
    });

  auth
    .command('get-profile')
    .description('GET /auth/profile')
    .action(async (_opts: unknown, cmd: Command) => {
      const cfg = await readConfig();
      const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
      const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
      const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;

      const client = new OpenBoxClient({ baseUrl, token });
      const res = await client.request('GET', '/auth/profile');
      const format = getOutputFormat(cmd);
      printResult(res.data, { format });
    });

  auth
    .command('profile')
    .description('Alias for get-profile')
    .action(async (_opts: unknown, cmd: Command) => {
      const cfg = await readConfig();
      const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
      const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
      const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;

      const client = new OpenBoxClient({ baseUrl, token });
      const res = await client.request('GET', '/auth/profile');
      const format = getOutputFormat(cmd);
      printResult(res.data, { format });
    });

  auth
    .command('whoami')
    .description('Show current org, user, and API endpoint')
    .action(async (_opts: unknown, cmd: Command) => {
      const cfg = await readConfig();
      const global = (cmd.optsWithGlobals() as GlobalOpts) ?? (program.opts() as GlobalOpts);
      const baseUrl = (global.baseUrl ?? process.env.OPENBOX_BASE_URL ?? resolveBaseUrl(cfg)).replace(/\/$/, '');
      const token = global.token ?? process.env.OPENBOX_TOKEN ?? cfg.token;
      const format = getOutputFormat(cmd);

      if (!token) {
        if (format === 'json') {
          process.stdout.write(`${JSON.stringify({ loggedIn: false, apiEndpoint: baseUrl }, null, 2)}\n`);
        } else {
          process.stdout.write(`Not logged in.\nAPI endpoint: ${baseUrl}\n`);
        }
        return;
      }

      const pickUser = (src: Record<string, unknown>): string | undefined =>
        (typeof src.email === 'string' && src.email) ||
        (typeof src.preferred_username === 'string' && src.preferred_username) ||
        (typeof src.username === 'string' && src.username) ||
        (typeof src.name === 'string' && src.name) ||
        (typeof src.sub === 'string' && src.sub) ||
        (typeof src.id === 'string' && src.id) ||
        undefined;

      const pickOrg = (src: Record<string, unknown>): string | undefined => {
        const direct =
          (typeof src.realm === 'string' && src.realm) ||
          (typeof src.orgId === 'string' && src.orgId) ||
          (typeof src.organizationId === 'string' && src.organizationId) ||
          (typeof src.tenant === 'string' && src.tenant) ||
          undefined;
        if (direct) return direct;
        const nested = (src.organization ?? src.org) as Record<string, unknown> | undefined;
        if (nested && typeof nested.name === 'string') return nested.name;
        if (nested && typeof nested.id === 'string') return nested.id;
        if (typeof src.iss === 'string') {
          const m = src.iss.match(/\/realms\/([^/?#]+)/);
          if (m) return m[1];
        }
        return undefined;
      };

      let user: string | undefined;
      let org: string | undefined;
      let apiProfile: Record<string, unknown> | undefined;
      let apiError: string | undefined;

      try {
        const client = new OpenBoxClient({ baseUrl, token });
        apiProfile = (await client.requestJson<Record<string, unknown>>('GET', '/auth/profile')) ?? {};
        user = pickUser(apiProfile);
        org = pickOrg(apiProfile);
      } catch (e) {
        apiError = e instanceof Error ? e.message : String(e);
      }

      const parts = token.split('.');
      let jwtPayload: Record<string, unknown> | undefined;
      if (parts.length === 3) {
        try {
          const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
          jwtPayload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
        } catch {
          // ignore
        }
      }
      if (jwtPayload) {
        user = user ?? pickUser(jwtPayload);
        org = org ?? pickOrg(jwtPayload);
      }

      const loggedIn = !apiError;

      if (format === 'json') {
        process.stdout.write(
          `${JSON.stringify(
            {
              loggedIn,
              org: org ?? null,
              user: user ?? null,
              apiEndpoint: baseUrl,
              ...(apiError ? { apiError } : {}),
            },
            null,
            2,
          )}\n`,
        );
        if (apiError) process.exitCode = 1;
        return;
      }

      process.stdout.write(`Org:          ${org ?? 'unknown'}\n`);
      process.stdout.write(`User:         ${user ?? 'unknown'}\n`);
      process.stdout.write(`API endpoint: ${baseUrl}\n`);
    });
}
