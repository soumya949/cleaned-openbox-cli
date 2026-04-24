export type OpenBoxClientOptions = {
  baseUrl: string;
  token?: string;
};

export type OpenBoxResponse = {
  status: number;
  contentType: string | null;
  data: unknown;
};

export class OpenBoxClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(opts: OpenBoxClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
  }

  async getIdentity(): Promise<string> {
    if (!this.token) {
      return 'Not logged in.';
    }

    const profile = await this.requestJson<unknown>('GET', '/auth/profile');
    if (profile && typeof profile === 'object') {
      const p = profile as Record<string, unknown>;
      const email = typeof p.email === 'string' ? p.email : undefined;
      const id = typeof p.id === 'string' ? p.id : undefined;

      if (email) {
        return `Authenticated as: ${email}`;
      }

      if (id) {
        return `Authenticated as user id: ${id}`;
      }
    }

    return 'Authenticated.';
  }

  async request(method: string, pathname: string, opts?: { query?: Record<string, string | string[]>; body?: unknown }): Promise<OpenBoxResponse> {
    const url = new URL(pathname, this.baseUrl);

    if (opts?.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        url.searchParams.delete(key);
        if (Array.isArray(value)) {
          for (const v of value) {
            url.searchParams.append(key, v);
          }
        } else {
          url.searchParams.set(key, value);
        }
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-openbox-client': 'web',
    };

    if (opts?.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    const resp = await fetch(url, {
      method,
      headers,
      body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    const contentType = resp.headers.get('content-type');

    if (resp.status === 204) {
      return { status: resp.status, contentType, data: null };
    }

    const isJson = (contentType ?? '').toLowerCase().includes('application/json');
    const isText = (contentType ?? '').toLowerCase().startsWith('text/');

    let data: unknown;
    let text: string | undefined;

    if (isJson) {
      text = await resp.text();
      data = text ? (JSON.parse(text) as unknown) : null;
    } else if (isText) {
      data = await resp.text();
    } else {
      const ab = await resp.arrayBuffer();
      data = Buffer.from(ab);
    }

    if (!resp.ok) {
      const errBody = isJson ? JSON.stringify(data) : typeof data === 'string' ? data : `binary(${(data as Buffer).byteLength} bytes)`;
      throw new Error(`OpenBox request failed (${resp.status}): ${errBody || resp.statusText}`);
    }

    return { status: resp.status, contentType, data };
  }

  async requestJson<T>(method: string, pathname: string, opts?: { query?: Record<string, string | string[]>; body?: unknown }): Promise<T> {
    const res = await this.request(method, pathname, opts);
    return res.data as T;
  }
}
