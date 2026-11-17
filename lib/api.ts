// The REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, serialized the way GitHub serializes
// them and checked field by field by the suite. Everything sits on the git
// object store: a contents write is a real commit, a branch is a real ref,
// and a squash merge is a real three-way tree merge.

import type { Forge, Issue, Pull, Repo } from './store.ts';
import { allocId, nowIso } from './store.ts';
import { isAncestor, mergeBase, parseCommit, parseTree } from './gitstore.ts';

export interface ApiRequest {
  method: string;
  /** Path segments after /api/v3, decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  /** Absolute URL of this request, for Link headers. */
  url: string;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): ApiResponse => ({ status, body, headers });
const fail = (status: number, message: string): ApiResponse => ({ status, body: { message } });
export const notFound = (): ApiResponse => fail(404, 'Not Found');

// ------------------------------------------------------------------ serializers

function ownerJson(login: string): Record<string, unknown> {
  return { login, id: 1000, type: 'User' };
}

export function repoJson(repo: Repo, displayOwner: string): Record<string, unknown> {
  const owner = repo.owner === '' ? displayOwner : repo.owner;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: ownerJson(owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: ownerJson(repo.owner),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = forge.refSha(repo, pull.headRef) ?? '';
  const baseSha = forge.refSha(repo, pull.baseRef) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: ownerJson(repo.owner),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.merged ? pull.updated_at : null,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? true : null,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, commentId: number): Record<string, unknown> {
  const comment = issue.comments.find((c) => c.id === commentId)!;
  return {
    id: comment.id,
    body: comment.body,
    user: ownerJson(repo.owner),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

// ------------------------------------------------------------------ helpers

function paginate<T>(req: ApiRequest, items: T[]): { page: T[]; headers?: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let headers: Record<string, string> | undefined;
  if (start + perPage < items.length) {
    const next = new URL(req.url);
    next.searchParams.set('page', String(pageNum + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(req.url);
    last.searchParams.set('page', String(Math.ceil(items.length / perPage)));
    last.searchParams.set('per_page', String(perPage));
    headers = { link: `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"` };
  }
  return { page: slice, headers };
}

function str(body: Record<string, unknown> | null, field: string): string {
  const v = body?.[field];
  return typeof v === 'string' ? v : '';
}

/** Line-diff counts between two texts (LCS over lines; files here are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: n - common, deletions: m - common };
}

/** The changed files between two file maps, with diff counts. */
export function diffFiles(forge: Forge, from: Map<string, { sha: string; mode: string }>, to: Map<string, { sha: string; mode: string }>): Record<string, unknown>[] {
  const paths = new Set([...from.keys(), ...to.keys()]);
  const out: Record<string, unknown>[] = [];
  const textOf = (sha: string | undefined): string => {
    if (sha === undefined) return '';
    const obj = forge.objects.get(sha);
    return obj === undefined ? '' : obj.data.toString('utf8');
  };
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.sha === after?.sha) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const { additions, deletions } = lineDiff(textOf(before?.sha), textOf(after?.sha));
    out.push({
      sha: after?.sha ?? before?.sha ?? '',
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

// ------------------------------------------------------------------ the router

export function handleApi(forge: Forge, req: ApiRequest): ApiResponse {
  const seg = req.segments;
  const viewer = forge.viewerLogin ?? forge.viewer;

  if (seg.length === 0) {
    return ok(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (seg[0] === 'meta' && req.method === 'GET') {
    return ok(200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
  }
  if (seg[0] === 'user' && seg.length === 1 && req.method === 'GET') {
    return ok(200, { login: viewer, id: 1000, type: 'User' });
  }
  if (seg[0] === 'user' && seg[1] === 'repos') {
    if (req.method === 'GET') {
      const { page, headers } = paginate(req, forge.listRepos(viewer).map((r) => repoJson(r, viewer)));
      return ok(200, page, headers);
    }
    if (req.method === 'POST') {
      const name = str(req.body, 'name');
      if (name === '') return fail(422, 'Repository creation failed.');
      if (forge.getRepo('', name) !== undefined || forge.repos.has(forge.key(viewer, name))) {
        return ok(422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
      }
      const repo = forge.createRepo('', name, str(req.body, 'description'), req.body?.private !== false);
      return ok(201, repoJson(repo, viewer));
    }
  }
  if (seg[0] !== 'repos' || seg.length < 3) return notFound();

  const owner = seg[1]!;
  const repo = forge.resolveRepo(owner, seg[2]!);
  if (repo === undefined) return notFound();
  const rest = seg.slice(3);
  const displayOwner = repo.owner === '' ? owner : repo.owner;

  if (rest.length === 0) {
    if (req.method === 'GET') return ok(200, repoJson(repo, displayOwner));
    if (req.method === 'PATCH') {
      if (typeof req.body?.description === 'string') repo.description = req.body.description;
      if (typeof req.body?.private === 'boolean') repo.private = req.body.private;
      if (typeof req.body?.name === 'string' && req.body.name !== repo.name) {
        forge.repos.delete(forge.key(repo.owner, repo.name));
        repo.name = req.body.name;
        forge.repos.set(forge.key(repo.owner, repo.name), repo);
      }
      repo.updated_at = nowIso();
      return ok(200, repoJson(repo, displayOwner));
    }
    if (req.method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  if (rest[0] === 'branches') {
    if (req.method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const { page, headers } = paginate(req, branches);
      return ok(200, page, headers);
    }
    if (req.method === 'GET' && rest.length === 2) {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) return notFound();
      return ok(200, { name: rest[1], commit: { sha, url: '' }, protected: false });
    }
    return notFound();
  }

  if (rest[0] === 'git' && rest[1] === 'refs' && req.method === 'POST') {
    const ref = str(req.body, 'ref');
    const sha = str(req.body, 'sha');
    if (!ref.startsWith('refs/')) return fail(422, 'Invalid ref.');
    const obj = forge.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') return fail(422, 'Invalid sha.');
    repo.refs.set(ref, sha);
    repo.gitVersion += 1;
    return ok(201, { ref, object: { sha, type: 'commit', url: '' } });
  }

  if (rest[0] === 'commits' && req.method === 'GET') {
    const refParam = req.query.get('sha') ?? repo.defaultBranch;
    let tip = forge.refSha(repo, refParam) ?? (forge.objects.has(refParam) ? refParam : undefined);
    const commits: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    while (tip !== undefined && !seen.has(tip) && commits.length < 500) {
      seen.add(tip);
      const obj = forge.objects.get(tip);
      if (obj === undefined || obj.type !== 'commit') break;
      const info = parseCommit(obj.data);
      const identParts = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(info.author);
      commits.push({
        sha: tip,
        commit: {
          message: info.message,
          tree: { sha: info.tree },
          author: identParts ? { name: identParts[1], email: identParts[2], date: new Date(Number(identParts[3]) * 1000).toISOString() } : { name: '', email: '', date: '' },
          committer: identParts ? { name: identParts[1], email: identParts[2], date: new Date(Number(identParts[3]) * 1000).toISOString() } : { name: '', email: '', date: '' },
        },
        parents: info.parents.map((sha) => ({ sha })),
      });
      tip = info.parents[0];
    }
    const { page, headers } = paginate(req, commits);
    return ok(200, page, headers);
  }

  if (rest[0] === 'contents') {
    return handleContents(forge, repo, req, rest.slice(1).join('/'));
  }

  if (rest[0] === 'labels') {
    if (req.method === 'POST' && rest.length === 1) {
      const name = str(req.body, 'name');
      if (name === '') return fail(422, 'Validation Failed');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed');
      repo.labels.set(name, { id: allocId(), name, color: str(req.body, 'color') || 'ededed', description: typeof req.body?.description === 'string' ? req.body.description : null });
      return ok(201, labelJson(repo, name));
    }
    if (req.method === 'GET' && rest.length === 1) {
      return ok(200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
    }
    return notFound();
  }

  if (rest[0] === 'issues') return handleIssues(forge, repo, req, rest.slice(1));
  if (rest[0] === 'pulls') return handlePulls(forge, repo, req, rest.slice(1));

  return notFound();
}

// ------------------------------------------------------------------ contents

function handleContents(forge: Forge, repo: Repo, req: ApiRequest, path: string): ApiResponse {
  const refParam = req.query.get('ref') ?? (typeof req.body?.branch === 'string' ? req.body.branch : repo.defaultBranch);

  if (req.method === 'GET') {
    const tip = forge.refSha(repo, refParam);
    if (tip === undefined) return notFound();
    const files = forge.filesAt(tip);
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean !== '' && files.has(clean)) {
      const entry = files.get(clean)!;
      const obj = forge.objects.get(entry.sha)!;
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: obj.data.length,
        name: clean.split('/').pop(),
        path: clean,
        sha: entry.sha,
        content: obj.data.toString('base64'),
      });
    }
    // Directory listing ('' is the root).
    const prefix = clean === '' ? '' : `${clean}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const tail = filePath.slice(prefix.length);
      const slash = tail.indexOf('/');
      if (slash === -1) {
        entries.set(tail, { type: 'file', sha: entry.sha, size: forge.objects.get(entry.sha)?.data.length ?? 0 });
      } else {
        const dirName = tail.slice(0, slash);
        if (!entries.has(dirName)) entries.set(dirName, { type: 'dir', sha: dirTreeSha(forge, tip, prefix + dirName), size: 0 });
      }
    }
    if (clean !== '' && entries.size === 0) return notFound();
    const list = [...entries.entries()]
      .map(([name, e]) => ({ type: e.type, size: e.size, name, path: prefix + name, sha: e.sha }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return ok(200, list);
  }

  if (req.method === 'PUT') {
    const branch = typeof req.body?.branch === 'string' ? req.body.branch : repo.defaultBranch;
    const contentB64 = str(req.body, 'content');
    const message = str(req.body, 'message') || 'Update file';
    const data = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
    const tip = forge.refSha(repo, branch);
    const files = forge.filesAt(tip);
    const existing = files.get(path);
    const givenSha = typeof req.body?.sha === 'string' ? req.body.sha : undefined;
    if (existing !== undefined && givenSha !== undefined && givenSha !== existing.sha) {
      return fail(409, 'Conflict: the sha does not match the current file.');
    }
    if (existing !== undefined && givenSha === undefined) {
      return fail(422, 'Validation Failed: sha is required when updating a file.');
    }
    const blobSha = forge.objects.put('blob', data);
    files.set(path, { sha: blobSha, mode: '100644' });
    const commitSha = forge.commitFiles(repo, branch, files, message, tip);
    return ok(existing === undefined ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  }

  if (req.method === 'DELETE') {
    const branch = typeof req.body?.branch === 'string' ? req.body.branch : repo.defaultBranch;
    const message = str(req.body, 'message') || 'Delete file';
    const tip = forge.refSha(repo, branch);
    const files = forge.filesAt(tip);
    const existing = files.get(path);
    if (existing === undefined) return notFound();
    const givenSha = typeof req.body?.sha === 'string' ? req.body.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.sha) return fail(409, 'Conflict: the sha does not match.');
    files.delete(path);
    const commitSha = forge.commitFiles(repo, branch, files, message, tip);
    return ok(200, { content: null, commit: { sha: commitSha, message } });
  }

  return notFound();
}

/** The tree sha of a directory inside a commit (for directory listings). */
function dirTreeSha(forge: Forge, commitSha: string, dirPath: string): string {
  const commit = forge.objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return '';
  let treeSha = parseCommit(commit.data).tree;
  for (const part of dirPath.split('/').filter((p) => p !== '')) {
    const tree = forge.objects.get(treeSha);
    if (tree === undefined || tree.type !== 'tree') return '';
    const entry = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return '';
    treeSha = entry.sha;
  }
  return treeSha;
}

// ------------------------------------------------------------------ issues

function handleIssues(forge: Forge, repo: Repo, req: ApiRequest, rest: string[]): ApiResponse {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const title = str(req.body, 'title');
      const labels = Array.isArray(req.body?.labels) ? (req.body.labels as unknown[]).map((l) => String(l)) : [];
      for (const name of labels) {
        if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist.`);
      }
      const ts = nowIso();
      const issue: Issue = {
        id: allocId(),
        number: repo.nextNumber++,
        title,
        body: str(req.body, 'body'),
        state: 'open',
        labels,
        comments: [],
        created_at: ts,
        updated_at: ts,
      };
      repo.issues.set(issue.number, issue);
      return ok(201, issueJson(repo, issue));
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
      const direction = req.query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, headers } = paginate(req, list.map((i) => issueJson(repo, i)));
      return ok(200, page, headers);
    }
    return notFound();
  }

  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) return notFound();

  if (rest.length === 1) {
    if (req.method === 'GET') return ok(200, issueJson(repo, issue));
    if (req.method === 'PATCH') {
      if (typeof req.body?.title === 'string') issue.title = req.body.title;
      if (typeof req.body?.body === 'string') issue.body = req.body.body;
      if (req.body?.state === 'open' || req.body?.state === 'closed') issue.state = req.body.state;
      if (Array.isArray(req.body?.labels)) {
        const labels = (req.body.labels as unknown[]).map((l) => String(l));
        for (const name of labels) if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist.`);
        issue.labels = labels;
      }
      issue.updated_at = nowIso();
      return ok(200, issueJson(repo, issue));
    }
    return notFound();
  }

  if (rest[1] === 'comments') {
    if (req.method === 'POST' && rest.length === 2) {
      const comment = { id: allocId(), body: str(req.body, 'body'), created_at: nowIso(), updated_at: nowIso() };
      issue.comments.push(comment);
      return ok(201, commentJson(repo, issue, comment.id));
    }
    if (req.method === 'GET' && rest.length === 2) {
      const { page, headers } = paginate(req, issue.comments.map((c) => commentJson(repo, issue, c.id)));
      return ok(200, page, headers);
    }
  }
  return notFound();
}

// ------------------------------------------------------------------ pulls

export function createPullRecord(repo: Repo, input: { title: string; body: string; head: string; base: string }): Pull {
  const ts = nowIso();
  const pull: Pull = {
    id: allocId(),
    number: repo.nextNumber++,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    merged: false,
    mergeCommitSha: null,
    created_at: ts,
    updated_at: ts,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Three-way tree merge for a squash: {files} or {conflict: path}. */
export function threeWayMerge(forge: Forge, baseFiles: Map<string, { sha: string; mode: string }>, headFiles: Map<string, { sha: string; mode: string }>, tipFiles: Map<string, { sha: string; mode: string }>): { files: Map<string, { sha: string; mode: string }> } | { conflict: string } {
  const out = new Map(tipFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const base = baseFiles.get(path)?.sha;
    const head = headFiles.get(path)?.sha;
    const tip = tipFiles.get(path)?.sha;
    if (head === base) continue; // the head did not change it: the tip version stands
    if (tip === base || tip === head) {
      // Only the head changed it (or both changed it the same way): take the head.
      const entry = headFiles.get(path);
      if (entry === undefined) out.delete(path);
      else out.set(path, entry);
      continue;
    }
    return { conflict: path };
  }
  return { files: out };
}

export function mergePullSquash(forge: Forge, repo: Repo, pull: Pull): ApiResponse {
  if (pull.merged || pull.state === 'closed') return fail(405, 'Pull Request already merged or closed.');
  const headSha = forge.refSha(repo, pull.headRef);
  const baseSha = forge.refSha(repo, pull.baseRef);
  if (headSha === undefined || baseSha === undefined) return fail(405, 'Pull Request is not mergeable.');
  const base = mergeBase(forge.objects, baseSha, headSha) ?? baseSha;
  const merged = threeWayMerge(forge, forge.filesAt(base), forge.filesAt(headSha), forge.filesAt(baseSha));
  if ('conflict' in merged) return fail(405, `Merge conflict in ${merged.conflict}.`);
  const commitSha = forge.commitFiles(repo, pull.baseRef, merged.files, `${pull.title} (#${pull.number})`, baseSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commitSha;
  pull.updated_at = nowIso();
  return ok(200, { sha: commitSha, merged: true, message: 'Pull Request successfully merged' });
}

function handlePulls(forge: Forge, repo: Repo, req: ApiRequest, rest: string[]): ApiResponse {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const headRaw = str(req.body, 'head');
      const baseRaw = str(req.body, 'base');
      const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
      if (forge.refSha(repo, head) === undefined || forge.refSha(repo, base) === undefined) {
        return fail(422, 'Validation Failed: head or base branch does not exist.');
      }
      const pull = createPullRecord(repo, { title: str(req.body, 'title'), body: str(req.body, 'body'), head, base });
      return ok(201, pullJson(forge, repo, pull));
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page, headers } = paginate(req, list.map((p) => pullJson(forge, repo, p)));
      return ok(200, page, headers);
    }
    return notFound();
  }

  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return notFound();

  if (rest.length === 1 && req.method === 'GET') return ok(200, pullJson(forge, repo, pull));
  if (rest.length === 1 && req.method === 'PATCH') {
    if (typeof req.body?.title === 'string') pull.title = req.body.title;
    if (typeof req.body?.body === 'string') pull.body = req.body.body;
    if (req.body?.state === 'open' || req.body?.state === 'closed') pull.state = req.body.state;
    pull.updated_at = nowIso();
    return ok(200, pullJson(forge, repo, pull));
  }
  if (rest[1] === 'files' && req.method === 'GET') {
    const headSha = forge.refSha(repo, pull.headRef);
    const baseSha = forge.refSha(repo, pull.baseRef);
    const base = headSha !== undefined && baseSha !== undefined ? (mergeBase(forge.objects, baseSha, headSha) ?? baseSha) : baseSha;
    const files = diffFiles(forge, forge.filesAt(base), forge.filesAt(headSha));
    const { page, headers } = paginate(req, files);
    return ok(200, page, headers);
  }
  if (rest[1] === 'merge' && req.method === 'PUT') {
    return mergePullSquash(forge, repo, pull);
  }
  return notFound();
}
