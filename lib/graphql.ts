// The GraphQL v4 surface: a small parser and executor covering the documents
// gh and github-mcp-server send — viewer, repository fields, issue and pull
// request connections with cursor pagination, the create/close/merge/comment
// mutations, node(id) and __type introspection for Issue, PullRequest,
// Repository and the SearchType enum. Global ids are base64 "Type:dbId" and
// stable across reads; everything resolves against the same store as REST.

import type { Forge, Issue, Pull, Repo } from './store.ts';
import { allocId, nowIso } from './store.ts';
import { createPullRecord, diffFiles, mergePullSquash, threeWayMerge } from './api.ts';
import { mergeBase } from './gitstore.ts';

// ------------------------------------------------------------------ global ids

export function globalId(type: string, dbId: number): string {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const dbId = Number(text.slice(colon + 1));
    return Number.isInteger(dbId) ? { type: text.slice(0, colon), dbId } : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ parser

type Value = string | number | boolean | null | Value[] | { [k: string]: Value } | { $var: string } | { $enum: string };

interface FieldNode {
  name: string;
  alias?: string;
  args: Record<string, Value>;
  selection?: FieldNode[];
  fragmentType?: string; // inline fragment condition
}

interface Operation {
  kind: 'query' | 'mutation';
  selection: FieldNode[];
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (text.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$@=!'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          out += text[j + 1] === 'n' ? '\n' : text[j + 1] === 't' ? '\t' : text[j + 1]!;
          j += 2;
        } else {
          out += text[j];
          j += 1;
        }
      }
      tokens.push(`"${out}`);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && /[A-Za-z0-9_.-]/.test(text[j]!)) j += 1;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private at = 0;
  constructor(text: string) {
    this.tokens = tokenize(text);
  }
  private peek(): string {
    return this.tokens[this.at] ?? '';
  }
  private next(): string {
    return this.tokens[this.at++] ?? '';
  }
  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`GraphQL parse: expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.at < this.tokens.length) {
      const head = this.peek();
      if (head === 'query' || head === 'mutation') {
        const kind = this.next() as 'query' | 'mutation';
        if (this.peek() !== '(' && this.peek() !== '{') this.next(); // operation name
        if (this.peek() === '(') this.skipBalanced();
        operations.push({ kind, selection: this.parseSelectionSet() });
      } else if (head === '{') {
        operations.push({ kind: 'query', selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.next();
        this.next();
        this.next();
        this.next();
        this.skipBalancedBody();
      } else {
        this.next();
      }
    }
    return operations;
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t === '(' || t === '[' || t === '{') depth += 1;
      else if (t === ')' || t === ']' || t === '}') depth -= 1;
    } while (depth > 0 && this.at < this.tokens.length);
  }

  private skipBalancedBody(): void {
    if (this.peek() === '{') {
      let depth = 0;
      do {
        const t = this.next();
        if (t === '{') depth += 1;
        else if (t === '}') depth -= 1;
      } while (depth > 0 && this.at < this.tokens.length);
    }
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const type = this.next();
          const inner = this.parseSelectionSet();
          for (const f of inner) fields.push({ ...f, fragmentType: type });
          continue;
        }
        this.next(); // fragment spread name (unused)
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Record<string, Value> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.next();
      }
      let selection: FieldNode[] | undefined;
      if (this.peek() === '{') selection = this.parseSelectionSet();
      fields.push({ name, alias, args, selection });
    }
    this.next();
    return fields;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { $var: this.next() };
    if (token.startsWith('"')) return token.slice(1);
    if (token === '[') {
      const list: Value[] = [];
      while (this.peek() !== ']') list.push(this.parseValue());
      this.next();
      return list;
    }
    if (token === '{') {
      const obj: { [k: string]: Value } = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.next();
      return obj;
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?\d+$/.test(token)) return Number(token);
    if (/^-?\d+\.\d+$/.test(token)) return Number(token);
    return { $enum: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  if (typeof value === 'object' && value !== null) {
    if ('$var' in value) return variables[(value as { $var: string }).$var];
    if ('$enum' in value) return (value as { $enum: string }).$enum;
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, variables);
    return out;
  }
  return value;
}

// ------------------------------------------------------------------ schema (for introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'isPrivate', 'description', 'url', 'createdAt', 'updatedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'titleHTML', 'body', 'bodyHTML', 'state', 'author', 'editor',
    'labels', 'comments', 'assignees', 'milestone', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository',
    'locked', 'viewerDidAuthor',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'isDraft',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'headRepository', 'baseRepository', 'author',
    'files', 'commits', 'comments', 'reviews', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository',
    'mergeCommit', 'potentialMergeCommit', 'additions', 'deletions', 'changedFiles',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Comment: ['id', 'databaseId', 'body', 'bodyHTML', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueEdge: ['node', 'cursor'],
  CommentEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ------------------------------------------------------------------ execution

type Source =
  | { type: 'Query' }
  | { type: 'Mutation' }
  | { type: 'User'; login: string }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Issue'; repo: Repo; issue: Issue }
  | { type: 'PullRequest'; repo: Repo; pull: Pull }
  | { type: 'Ref'; name: string }
  | { type: 'Comment'; id: number; body: string }
  | { type: 'Connection'; nodes: Source[]; total: number; hasNext: boolean; endCursor: string | null }
  | { type: 'File'; path: string }
  | { type: 'Payload'; payload: Record<string, Source | null> }
  | { type: 'Edge'; node: Source }
  | { type: '__Type'; name: string }
  | { type: '__Field'; name: string }
  | { type: '__EnumValue'; name: string }
  | { type: 'PageInfo'; hasNext: boolean; endCursor: string | null };

interface Ctx {
  forge: Forge;
  errors: { message: string }[];
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { type: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: Pull): Source {
  return { type: 'PullRequest', repo, pull };
}

function paginateConnection(all: Source[], numbers: number[], first: unknown, after: unknown): Source {
  const limit = typeof first === 'number' && first > 0 ? first : all.length;
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const num = Number(text.replace('cursor:', ''));
      const idx = numbers.indexOf(num);
      if (idx >= 0) start = idx + 1;
    } catch {
      start = 0;
    }
  }
  const nodes = all.slice(start, start + limit);
  const hasNext = start + limit < all.length;
  const lastNumber = nodes.length > 0 ? numbers[start + nodes.length - 1]! : null;
  return { type: 'Connection', nodes, total: all.length, hasNext, endCursor: lastNumber !== null ? cursorFor(lastNumber) : null };
}

function repoByGlobalId(forge: Forge, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  for (const repo of forge.repos.values()) if (repo.id === parsed.dbId) return repo;
  return null;
}

function resolveField(ctx: Ctx, source: Source, field: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  switch (source.type) {
    case 'Query': {
      if (field === 'viewer') return { type: 'User', login: forge.viewerLogin ?? '' } satisfies Source;
      if (field === 'repository') {
        const repo = forge.resolveRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : ({ type: 'Repository', repo } satisfies Source);
      }
      if (field === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        if (parsed.type === 'Repository') {
          const repo = repoByGlobalId(forge, String(args.id));
          return repo === null ? null : ({ type: 'Repository', repo } satisfies Source);
        }
        if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
          for (const repo of forge.repos.values()) {
            const issue = [...repo.issues.values()].find((i) => i.id === parsed.dbId);
            if (issue !== undefined) return issueSource(repo, issue);
            const pull = [...repo.pulls.values()].find((p) => p.id === parsed.dbId);
            if (pull !== undefined) return pullSource(repo, pull);
          }
          return null;
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        return TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined ? ({ type: '__Type', name } satisfies Source) : null;
      }
      if (field === '__schema') return { type: '__Type', name: '__Schema' } satisfies Source;
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(forge, String(input.repositoryId ?? ''));
        if (repo === null) return null;
        const ts = nowIso();
        const issue: Issue = {
          id: allocId(),
          number: repo.nextNumber++,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          labels: [],
          comments: [],
          created_at: ts,
          updated_at: ts,
        };
        repo.issues.set(issue.number, issue);
        return { type: 'Payload', payload: { issue: issueSource(repo, issue) } } satisfies Source;
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        if (parsed === null) return null;
        for (const repo of forge.repos.values()) {
          const issue = [...repo.issues.values()].find((i) => i.id === parsed.dbId);
          if (issue !== undefined) {
            issue.state = 'closed';
            issue.updated_at = nowIso();
            return { type: 'Payload', payload: { issue: issueSource(repo, issue) } } satisfies Source;
          }
        }
        return null;
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(forge, String(input.repositoryId ?? ''));
        if (repo === null) return null;
        const headRaw = String(input.headRefName ?? '');
        const baseRaw = String(input.baseRefName ?? '');
        const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
        const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
        const pull = createPullRecord(repo, { title: String(input.title ?? ''), body: String(input.body ?? ''), head, base });
        return { type: 'Payload', payload: { pullRequest: pullSource(repo, pull) } } satisfies Source;
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        if (parsed === null) return null;
        for (const repo of forge.repos.values()) {
          const pull = [...repo.pulls.values()].find((p) => p.id === parsed.dbId);
          if (pull !== undefined) {
            mergePullSquash(forge, repo, pull);
            return { type: 'Payload', payload: { pullRequest: pullSource(repo, pull) } } satisfies Source;
          }
        }
        return null;
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        if (parsed === null) return null;
        for (const repo of forge.repos.values()) {
          const issue = [...repo.issues.values()].find((i) => i.id === parsed.dbId);
          if (issue !== undefined) {
            const comment = { id: allocId(), body: String(input.body ?? ''), created_at: nowIso(), updated_at: nowIso() };
            issue.comments.push(comment);
            const node: Source = { type: 'Comment', id: comment.id, body: comment.body };
            return { type: 'Payload', payload: { commentEdge: { type: 'Edge', node } } } satisfies Source;
          }
        }
        return null;
      }
      break;
    }
    case 'User': {
      if (field === 'login') return source.login;
      if (field === 'id') return globalId('User', 1000);
      if (field === 'databaseId') return 1000;
      if (field === 'name') return source.login;
      break;
    }
    case 'Repository': {
      const repo = source.repo;
      switch (field) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner === '' ? forge.viewerLogin ?? '' : repo.owner}/${repo.name}`;
        case 'owner': return { type: 'User', login: repo.owner === '' ? forge.viewerLogin ?? '' : repo.owner } satisfies Source;
        case 'defaultBranchRef': {
          const tip = forge.refSha(repo, repo.defaultBranch);
          return tip === undefined ? null : ({ type: 'Ref', name: repo.defaultBranch } satisfies Source);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasPullRequestsEnabled': return true;
        case 'isPrivate': return repo.private;
        case 'description': return repo.description;
        case 'createdAt': return repo.created_at;
        case 'updatedAt': return repo.updated_at;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueSource(repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s).toUpperCase()) : null;
          if (states !== null) list = list.filter((i) => states.includes(i.state.toUpperCase()));
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          const asc = orderBy?.direction === 'ASC';
          list.sort((a, b) => (asc ? a.number - b.number : b.number - a.number));
          return paginateConnection(list.map((i) => issueSource(repo, i)), list.map((i) => i.number), args.first, args.after);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullSource(repo, pull);
        }
        case 'pullRequests': {
          const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          return paginateConnection(list.map((p) => pullSource(repo, p)), list.map((p) => p.number), args.first, args.after);
        }
      }
      break;
    }
    case 'Issue': {
      const issue = source.issue;
      switch (field) {
        case 'id': return globalId('Issue', issue.id);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'createdAt': return issue.created_at;
        case 'updatedAt': return issue.updated_at;
        case 'closedAt': return issue.state === 'closed' ? issue.updated_at : null;
        case 'repository': return { type: 'Repository', repo: source.repo } satisfies Source;
        case 'author': return { type: 'User', login: source.repo.owner } satisfies Source;
      }
      break;
    }
    case 'PullRequest': {
      const pull = source.pull;
      const repo = source.repo;
      switch (field) {
        case 'id': return globalId('PullRequest', pull.id);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.merged ? pull.updated_at : null;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'createdAt': return pull.created_at;
        case 'updatedAt': return pull.updated_at;
        case 'closedAt': return pull.state === 'closed' ? pull.updated_at : null;
        case 'repository': return { type: 'Repository', repo } satisfies Source;
        case 'author': return { type: 'User', login: repo.owner } satisfies Source;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          const headSha = forge.refSha(repo, pull.headRef);
          const baseSha = forge.refSha(repo, pull.baseRef);
          if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
          const base = mergeBase(forge.objects, baseSha, headSha) ?? baseSha;
          const merged = threeWayMerge(forge, forge.filesAt(base), forge.filesAt(headSha), forge.filesAt(baseSha));
          return 'conflict' in merged ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'files': {
          const headSha = forge.refSha(repo, pull.headRef);
          const baseSha = forge.refSha(repo, pull.baseRef);
          const base = headSha !== undefined && baseSha !== undefined ? (mergeBase(forge.objects, baseSha, headSha) ?? baseSha) : baseSha;
          const files = diffFiles(forge, forge.filesAt(base), forge.filesAt(headSha));
          const nodes: Source[] = files.map((f) => ({ type: 'File', path: String(f.filename) }));
          return paginateConnection(nodes, files.map((_, i) => i), args.first, args.after);
        }
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return source.name;
      if (field === 'prefix') return 'refs/heads/';
      break;
    }
    case 'Comment': {
      if (field === 'id') return globalId('IssueComment', source.id);
      if (field === 'databaseId') return source.id;
      if (field === 'body') return source.body;
      break;
    }
    case 'Connection': {
      if (field === 'nodes') return source.nodes;
      if (field === 'totalCount') return source.total;
      if (field === 'pageInfo') return { type: 'PageInfo', hasNext: source.hasNext, endCursor: source.endCursor } satisfies Source;
      if (field === 'edges') return source.nodes.map((node) => ({ type: 'Edge', node }) satisfies Source);
      break;
    }
    case 'File': {
      if (field === 'path') return source.path;
      break;
    }
    case 'Payload': {
      const value = source.payload[field];
      return value === undefined ? null : value;
    }
    case 'Edge': {
      if (field === 'node') return source.node;
      if (field === 'cursor') return cursorFor(0);
      break;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return source.hasNext;
      if (field === 'hasPreviousPage') return false;
      if (field === 'endCursor') return source.endCursor;
      if (field === 'startCursor') return source.endCursor;
      break;
    }
    case '__Type': {
      if (field === 'name') return source.name;
      if (field === 'kind') return ENUM_VALUES[source.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        const names = TYPE_FIELDS[source.name] ?? [];
        return names.map((name) => ({ type: '__Field', name }) satisfies Source);
      }
      if (field === 'enumValues') {
        const names = ENUM_VALUES[source.name] ?? [];
        return names.map((name) => ({ type: '__EnumValue', name }) satisfies Source);
      }
      break;
    }
    case '__Field': {
      if (field === 'name') return source.name;
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return source.name;
      break;
    }
  }
  if (field === '__typename') return source.type;
  ctx.errors.push({ message: `Field '${field}' doesn't exist on type '${source.type}'` });
  return null;
}

function executeSelection(ctx: Ctx, source: Source, selection: FieldNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.fragmentType !== undefined && field.fragmentType !== source.type) continue;
    const key = field.alias ?? field.name;
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(field.args)) args[name] = resolveValue(value, variables);
    const value = field.name === '__typename' ? source.type : resolveField(ctx, source, field.name, args);
    out[key] = completeValue(ctx, value, field, variables);
  }
  return out;
}

function completeValue(ctx: Ctx, value: unknown, field: FieldNode, variables: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, field, variables));
  if (typeof value === 'object' && field.selection !== undefined) {
    return executeSelection(ctx, value as Source, field.selection, variables);
  }
  return value;
}

function executeOperation(forge: Forge, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const ctx: Ctx = { forge, errors: [] };
  const root: Source = operation.kind === 'mutation' ? { type: 'Mutation' } : { type: 'Query' };
  // Mutation root fields resolve against the Query resolver switch (case 'Mutation').
  const data = executeSelection(ctx, root, operation.selection, variables);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

export function handleGraphql(forge: Forge, raw: unknown): { status: number; body: unknown } {
  const runOne = (item: unknown): unknown => {
    const request = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const query = typeof request.query === 'string' ? request.query : '';
    const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
    if (query === '') return { errors: [{ message: 'No query provided' }] };
    let operations: Operation[];
    try {
      operations = new Parser(query).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
    if (operations.length === 0) return { errors: [{ message: 'No operation found' }] };
    // A document with several operations: the suite sends one per request (plus
    // the HTTP-level batch of two documents, handled by the array branch).
    const op = operations[0]!;
    const root: Source = op.kind === 'mutation' ? { type: 'Mutation' } : { type: 'Query' };
    void root;
    return executeOperation(forge, op, variables);
  };
  if (Array.isArray(raw)) {
    return { status: 200, body: raw.map(runOne) };
  }
  return { status: 200, body: runOne(raw) };
}
