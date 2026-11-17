// The forge's HTTP server: one router over four surfaces — REST v3 under
// /api/v3, GraphQL at /api/graphql, MCP at /mcp and git smart HTTP at
// /{owner}/{repo}.git — plus the env's health probe. Every API reply is
// JSON with an X-GitHub-Request-Id; every surface but /healthz requires the
// trial's bearer token; unknown routes answer GitHub's JSON 404, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './lib/store.ts';
import { handleApi, type ApiRequest } from './lib/api.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleGitHttp } from './lib/githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `FORGE-${requestCounter.toString(16).toUpperCase().padStart(6, '0')}`,
    ...headers,
  });
  res.end(text);
}

function sendApiResponse(res: ServerResponse, out: { status: number; body?: unknown; headers?: Record<string, string> }): void {
  if (out.status === 204 || out.body === undefined) {
    requestCounter += 1;
    res.writeHead(out.status, { 'x-github-request-id': `FORGE-${requestCounter.toString(16).toUpperCase().padStart(6, '0')}`, ...(out.headers ?? {}) });
    res.end();
    return;
  }
  sendJson(res, out.status, out.body, out.headers);
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage): boolean {
  return (req.headers.authorization ?? '') === `Bearer ${TOKEN}`;
}

export function createApp(): Server {
  const forge = new Forge('');
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/api/graphql' || path === '/mcp' || path.startsWith('/api/v3')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          let body: Record<string, unknown> | null = null;
          let rawJson: unknown = null;
          if (raw.length > 0) {
            try {
              rawJson = JSON.parse(raw.toString('utf8'));
              body = typeof rawJson === 'object' && rawJson !== null && !Array.isArray(rawJson) ? (rawJson as Record<string, unknown>) : null;
            } catch {
              if (path === '/mcp') {
                sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
              } else {
                sendJson(res, 400, { message: 'Malformed JSON body' });
              }
              return;
            }
          }
          if (path === '/api/graphql') {
            const out = handleGraphql(forge, rawJson);
            sendApiResponse(res, out);
            return;
          }
          if (path === '/mcp') {
            const out = await handleMcp(forge, rawJson, req.headers);
            sendApiResponse(res, out);
            return;
          }
          const segments = path
            .slice('/api/v3'.length)
            .split('/')
            .filter((s) => s !== '')
            .map((s) => decodeURIComponent(s));
          const apiReq: ApiRequest = { method, segments, query: url.searchParams, body, url: `http://${req.headers.host ?? 'entry'}${req.url ?? ''}` };
          sendApiResponse(res, handleApi(forge, apiReq));
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          const out = await handleGitHttp(forge, {
            method,
            owner: decodeURIComponent(gitMatch[1]!),
            repo: decodeURIComponent(gitMatch[2]!),
            tail: gitMatch[3] ?? '',
            query: url.searchParams,
            headers: req.headers,
            body: raw,
          });
          requestCounter += 1;
          res.writeHead(out.status, {
            'x-github-request-id': `FORGE-${requestCounter.toString(16).toUpperCase().padStart(6, '0')}`,
            ...(out.headers ?? {}),
          });
          res.end(out.body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
