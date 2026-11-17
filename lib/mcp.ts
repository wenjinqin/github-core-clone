// The MCP surface: JSON-RPC 2.0 over streamable HTTP, speaking the classic
// handshake era (initialize + notifications/initialized). server/discover is
// refused with -32601, which the client reads as a pre-discover server. The
// six tools act on the same store as REST and answer with the REST-shaped
// objects as JSON text, so an object made here reads back identically there.

import type { Forge, Repo } from './store.ts';
import { issueJson, pullJson, repoJson, createPullRecord, mergePullSquash, handleApi } from './api.ts';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the given owner (or the token owner when omitted).',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      owner: { type: 'string', description: 'The owner login; defaults to the token owner.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository and return it.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List a repository\u2019s issues, newest first; state filters open, closed or all.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all (default open).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch and return it.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request and return it with merged set.',
    properties: {
      owner: { type: 'string', description: 'The owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolList(): unknown {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: t.properties, required: t.required },
    })),
  };
}

function textResult(value: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError };
}

function argStr(args: Record<string, unknown>, field: string): string {
  const v = args[field];
  return typeof v === 'string' ? v : '';
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((t) => t.name === name);
  if (def === undefined) throw new RpcError(-32602, `Unknown tool: ${name}`);
  for (const field of def.required) {
    if (args[field] === undefined || args[field] === '') {
      return textResult(`Missing required argument: ${field}`, true);
    }
  }
  const owner = argStr(args, 'owner') || forge.viewerLogin || '';
  const repoName = argStr(args, 'repo') || argStr(args, 'name');
  const needRepo = (): Repo => {
    const repo = forge.resolveRepo(owner, repoName);
    if (repo === undefined) throw new ToolFailure(`Repository ${owner}/${repoName} not found`);
    return repo;
  };

  switch (name) {
    case 'create_repo': {
      const repoNameArg = argStr(args, 'name');
      const existing = forge.resolveRepo(owner, repoNameArg);
      if (existing !== undefined) return textResult(repoJson(existing, owner));
      const repo = forge.createRepo(owner, repoNameArg, argStr(args, 'description'), args.private !== false);
      if (forge.viewerLogin === null && owner !== '') forge.viewerLogin = owner;
      return textResult(repoJson(repo, owner));
    }
    case 'get_repo': {
      return textResult(repoJson(needRepo(), owner));
    }
    case 'create_issue': {
      needRepo();
      // Reuse the REST path so ids, numbers and shapes are identical.
      const out = handleApi(forge, {
        method: 'POST',
        segments: ['repos', owner, repoName, 'issues'],
        query: new URLSearchParams(),
        body: { title: argStr(args, 'title'), body: argStr(args, 'body') },
        url: 'http://entry/api/v3',
      });
      if (out.status !== 201) return textResult(`create_issue failed: ${JSON.stringify(out.body)}`, true);
      return textResult(out.body);
    }
    case 'list_issues': {
      const repo = needRepo();
      const state = argStr(args, 'state') || 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.number - a.number);
      return textResult(list.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const repo = needRepo();
      const head = argStr(args, 'head');
      const base = argStr(args, 'base');
      if (forge.refSha(repo, head) === undefined || forge.refSha(repo, base) === undefined) {
        return textResult(`Branch not found: ${head} or ${base}`, true);
      }
      const pull = createPullRecord(repo, { title: argStr(args, 'title'), body: argStr(args, 'body'), head, base });
      return textResult(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = needRepo();
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return textResult(`Pull request ${String(args.pull_number)} not found`, true);
      const out = mergePullSquash(forge, repo, pull);
      if (out.status !== 200) return textResult(`Merge failed: ${JSON.stringify(out.body)}`, true);
      return textResult(pullJson(forge, repo, pull));
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

class ToolFailure extends Error {}

export async function handleMcp(forge: Forge, raw: unknown, _headers: Record<string, string | string[] | undefined>): Promise<{ status: number; body?: unknown }> {
  const request = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  // Notifications carry no id: accept and answer nothing.
  if (id === undefined) return { status: 202 };

  const reply = (result: unknown): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const replyError = (code: number, message: string): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  try {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
        return reply({
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'forge', version: '1.0.0' },
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply(toolList());
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        try {
          return reply(callTool(forge, name, args));
        } catch (err) {
          if (err instanceof RpcError) return replyError(err.code, err.message);
          if (err instanceof ToolFailure) return reply(textResult(err.message, true));
          throw err;
        }
      }
      default:
        return replyError(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return replyError(-32603, err instanceof Error ? err.message : 'Internal error');
  }
}
