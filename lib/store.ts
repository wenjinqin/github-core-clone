// The forge's state: repositories (metadata + refs over the shared object
// store), issues, pull requests, labels and comments. One global id counter
// serves every entity, the way GitHub's database ids run across types.
// Timestamps come from MAKEFUN_TRIAL_NOW with a one-second tick per call, so
// a replay of the same request stream produces the same bytes.

import { ObjectStore, buildTree, flattenTree, parseCommit, serializeCommit } from './gitstore.ts';

const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ?? '2026-01-01T00:00:00.000Z';
const EPOCH = Math.floor(Date.parse(TRIAL_NOW) / 1000) || 1_767_225_600;
let tick = 0;

/** The trial clock: ISO string, one second later on every call. */
export function nowIso(): string {
  tick += 1;
  return new Date((EPOCH + tick) * 1000).toISOString().replace('.000Z', 'Z');
}

/** The git ident line for forge-made commits, stamped with the trial clock. */
export function ident(login: string): string {
  return `${login} <${login}@users.noreply.github.com> ${EPOCH + tick} +0000`;
}

let nextId = 1;
export function allocId(): number {
  const id = nextId;
  nextId += 1;
  return id;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
  pull_request?: { url: string };
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  /** Bumped whenever the repo's refs move; keys the fetch-response cache. */
  gitVersion: number;
  created_at: string;
  updated_at: string;
}

export class Forge {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  /** The login the suite's token names; every repository belongs to it. */
  readonly viewer: string;

  constructor(viewer: string) {
    this.viewer = viewer;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** The login bound to the token; learned from the first owner-named request. */
  viewerLogin: string | null = null;

  /**
   * Look a repository up by the owner a request names. Repositories are created
   * under a pending owner (''), because the token's login is only revealed by
   * the first request that addresses one by owner/name: that request binds the
   * login and re-keys the pending repository to it.
   */
  resolveRepo(owner: string, name: string): Repo | undefined {
    const direct = this.repos.get(this.key(owner, name));
    if (direct !== undefined) return direct;
    const pending = this.repos.get(this.key('', name));
    if (pending !== undefined) {
      this.repos.delete(this.key('', name));
      pending.owner = owner;
      this.repos.set(this.key(owner, name), pending);
      if (this.viewerLogin === null) this.viewerLogin = owner;
      return pending;
    }
    return undefined;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const ts = nowIso();
    const repo: Repo = {
      id: allocId(),
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      gitVersion: 0,
      created_at: ts,
      updated_at: ts,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner || r.owner === '').sort((a, b) => a.id - b.id);
  }

  /** The sha a ref names, or undefined. Accepts 'main', 'heads/main' or 'refs/heads/main'. */
  refSha(repo: Repo, ref: string): string | undefined {
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return repo.refs.get(full);
  }

  /** The flattened file map at a commit sha (empty when the commit is unknown). */
  filesAt(commitSha: string | undefined): Map<string, { sha: string; mode: string }> {
    if (commitSha === undefined) return new Map();
    const obj = this.objects.get(commitSha);
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return flattenTree(this.objects, parseCommit(obj.data).tree);
  }

  /** Commit a full file map onto a branch; returns the new commit sha. */
  commitFiles(repo: Repo, branch: string, files: Map<string, { sha: string; mode: string }>, message: string, parentSha: string | undefined): string {
    const tree = buildTree(this.objects, files);
    const id = ident(repo.owner);
    const commit = serializeCommit({
      tree,
      parents: parentSha === undefined ? [] : [parentSha],
      author: id,
      committer: id,
      message,
    });
    const sha = this.objects.put('commit', commit);
    repo.refs.set(`refs/heads/${branch}`, sha);
    repo.gitVersion += 1;
    repo.updated_at = nowIso();
    return sha;
  }
}
