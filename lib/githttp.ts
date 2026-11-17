// Git smart HTTP, implemented from the protocol up: pkt-line framing, the
// v0 and v2 ref advertisements, v2 ls-refs, upload-pack fetch (v0 and v2,
// with shallow/deepen boundaries) and receive-pack pushes with report-status
// in side-band-64k. Packs are written whole (no deltas) and read with full
// delta resolution; a fetch excludes everything reachable from the client's
// haves, honouring the client's shallow boundary when it computes that set.

import type { Forge, Repo } from './store.ts';
import { parseCommit, parseTag, readPack, writePack, type ObjType } from './gitstore.ts';

export interface GitHttpRequest {
  method: string;
  owner: string;
  repo: string;
  tail: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface GitHttpResponse {
  status: number;
  body: Buffer;
  headers?: Record<string, string>;
}

const ZERO = '0'.repeat(40);
const JSON_404 = (): GitHttpResponse => ({ status: 404, body: Buffer.from('{"message":"Not Found"}\n'), headers: { 'content-type': 'application/json; charset=utf-8' } });

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const size = data.length + 4;
  const head = Buffer.from(size.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse a pkt-line stream; stops at the first flush and reports where the raw tail begins. */
export function parsePackets(buf: Buffer, start = 0): { packets: Packet[]; tail: number } {
  const packets: Packet[] = [];
  let at = start;
  while (at + 4 <= buf.length) {
    const head = buf.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const size = parseInt(head, 16);
    if (size === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      return { packets, tail: at };
    }
    if (size === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (size === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      at += 4;
      return { packets, tail: at };
    }
    if (size < 4 || at + size > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(at + 4, at + size) });
    at += size;
  }
  return { packets, tail: at };
}

/** Split a buffer into pkt-line sections separated by flush packets. */
export function parseSections(buf: Buffer): { sections: Buffer[][]; tail: Buffer } {
  const sections: Buffer[][] = [];
  let current: Buffer[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const head = buf.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const size = parseInt(head, 16);
    if (size === 0) {
      sections.push(current);
      current = [];
      at += 4;
      // Anything after a flush that does not parse as pkt-lines is raw tail (a pack).
      const next = buf.toString('ascii', at, at + 4);
      if (at < buf.length && !/^[0-9a-fA-F]{4}$/.test(next)) break;
      if (at >= buf.length) break;
      continue;
    }
    if (size === 1 || size === 2) {
      current.push(buf.subarray(at, at + 4));
      at += 4;
      continue;
    }
    if (size < 4 || at + size > buf.length) break;
    current.push(buf.subarray(at + 4, at + size));
    at += size;
  }
  if (current.length > 0) sections.push(current);
  return { sections, tail: buf.subarray(at) };
}

/** Wrap a payload in sideband band-1 packets of a safe size. */
export function sidebandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < data.length; at += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(at, at + CHUNK)])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ref helpers

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Peel an object to its commit (through tag objects), or null. */
function peelToCommit(forge: Forge, sha: string): string | null {
  let current = sha;
  for (let i = 0; i < 10; i += 1) {
    const obj = forge.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag === null) return null;
      current = tag.object;
      continue;
    }
    return null;
  }
  return null;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  objects: Map<string, { type: ObjType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
  common: string | null;
}

/**
 * Plan a fetch: the objects to send, the new shallow boundary and the deepest
 * common have. `depth` limits commit generations from the wants; `clientShallow`
 * is the boundary the client already holds (its haves do not extend past it).
 */
function planFetch(forge: Forge, wants: string[], haves: string[], clientShallow: ReadonlySet<string>, depth: number | null): FetchPlan {
  const store = forge.objects;
  // What the client already holds: closure of haves, not crossing its shallow boundary.
  const held = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (held.has(sha)) continue;
      const obj = store.get(sha);
      if (obj === undefined) continue;
      held.add(sha);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        stack.push(info.tree);
        if (!clientShallow.has(sha)) stack.push(...info.parents);
      } else if (obj.type === 'tree') {
        for (const e of parseTreeEntries(store, sha)) stack.push(e);
      } else if (obj.type === 'tag') {
        const tag = parseTag(obj.data);
        if (tag !== null) stack.push(tag.object);
      }
    }
  }
  // The deepest have that is an ancestor-or-self of a want counts as common (for the ACK line).
  let common: string | null = null;
  for (const have of haves) {
    if (held.has(have) && store.get(have)?.type === 'commit') {
      common = have;
      break;
    }
  }

  // BFS by commit generation from the wants.
  const included = new Map<string, { type: ObjType; data: Buffer }>();
  const boundary = new Set<string>();
  const includeObject = (sha: string): void => {
    if (included.has(sha)) return;
    const obj = store.get(sha);
    if (obj === undefined) return;
    included.set(sha, obj);
    if (obj.type === 'tree') {
      for (const e of parseTreeEntries(store, sha)) includeObject(e);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag !== null) includeObject(tag.object);
    }
  };
  let frontier = [...new Set(wants)];
  let generation = 0;
  const seenCommits = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (seenCommits.has(sha)) continue;
      seenCommits.add(sha);
      const obj = store.get(sha);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        includeObject(sha);
        const tag = parseTag(obj.data);
        if (tag !== null) next.push(tag.object);
        continue;
      }
      if (obj.type !== 'commit') {
        includeObject(sha);
        continue;
      }
      includeObject(sha);
      const info = parseCommit(obj.data);
      includeObject(info.tree);
      const atEdge = depth !== null && generation + 1 >= depth;
      if (atEdge) {
        if (info.parents.length > 0) boundary.add(sha);
      } else {
        next.push(...info.parents);
      }
    }
    frontier = next;
    generation += 1;
    if (depth !== null && generation >= depth) break;
  }

  // Unshallow: a client-boundary commit whose parents are now included in full.
  const unshallow: string[] = [];
  for (const sha of clientShallow) {
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (info.parents.length > 0 && info.parents.every((p) => included.has(p) || held.has(p))) {
      if (boundary.has(sha)) continue;
      // Only when the commit itself is part of this fetch's graph.
      if (included.has(sha) || wants.includes(sha) || haves.includes(sha)) unshallow.push(sha);
    }
  }

  // Remove everything the client already holds.
  for (const sha of held) included.delete(sha);
  // A boundary commit the client already holds in full is not a boundary.
  for (const sha of [...boundary]) if (held.has(sha) && !clientShallow.has(sha)) boundary.delete(sha);

  return { objects: included, shallow: [...boundary], unshallow, common };
}

function parseTreeEntries(store: Forge['objects'], treeSha: string): string[] {
  const obj = store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return [];
  const out: string[] = [];
  let at = 0;
  const data = obj.data;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    const nul = data.indexOf(0, sp + 1);
    out.push(data.toString('hex', nul + 1, nul + 21));
    at = nul + 21;
  }
  return out;
}

// ---------------------------------------------------------------- the handler

export async function handleGitHttp(forge: Forge, req: GitHttpRequest): Promise<GitHttpResponse> {
  const repo = forge.resolveRepo(req.owner, req.repo);
  const service = req.query.get('service');

  if (req.tail === '/info/refs' && req.method === 'GET') {
    if (repo === undefined) return JSON_404();
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return JSON_404();
    return advertise(forge, repo, service, req);
  }
  if (req.tail === '/git-upload-pack' && req.method === 'POST') {
    if (repo === undefined) return JSON_404();
    return uploadPack(forge, repo, req);
  }
  if (req.tail === '/git-receive-pack' && req.method === 'POST') {
    if (repo === undefined) return JSON_404();
    return receivePack(forge, repo, req);
  }
  return JSON_404();
}

function wantsV2(req: GitHttpRequest): boolean {
  const header = req.headers['git-protocol'];
  const value = Array.isArray(header) ? header.join(',') : header ?? '';
  return value.includes('version=2');
}

function advertise(forge: Forge, repo: Repo, service: string, req: GitHttpRequest): GitHttpResponse {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantsV2(req)) {
    const lines = ['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow wait-for-done\n', 'object-format=sha1\n'];
    return { status: 200, body: Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]), headers: { 'content-type': contentType } };
  }
  const caps =
    service === 'git-upload-pack'
      ? `thin-pack side-band side-band-64k ofs-delta shallow no-progress symref=HEAD:${headTarget(repo)} agent=forge/1.0`
      : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    const headSha = repo.refs.get(headTarget(repo)) ?? ZERO;
    parts.push(pktLine(`${headSha} HEAD\0${caps}\n`));
    for (const [name, sha] of refs) {
      parts.push(pktLine(`${sha} ${name}\n`));
      const obj = forge.objects.get(sha);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(forge, sha);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return { status: 200, body: Buffer.concat(parts), headers: { 'content-type': contentType } };
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefs(forge: Forge, repo: Repo, argLines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headSha = repo.refs.get(target);
  if (prefixes.length === 0 || matches('HEAD')) {
    if (headSha !== undefined) {
      parts.push(pktLine(`${headSha} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    if (peel) {
      const obj = forge.objects.get(sha);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(forge, sha);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

/** Fetch responses are deterministic per (repo, git version, request): cache them whole. */
const fetchCache = new Map<string, Buffer>();

function fetchCacheKey(repo: Repo, wants: string[], haves: string[], clientShallow: ReadonlySet<string>, depth: number | null, v2: boolean): string {
  return `${repo.id}@${repo.gitVersion}|${v2 ? 'v2' : 'v0'}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...clientShallow].sort().join(',')}|${depth ?? ''}`;
}

function cachedFetch(repo: Repo, key: string, build: () => Buffer): Buffer {
  const hit = fetchCache.get(key);
  if (hit !== undefined) return hit;
  const body = build();
  if (fetchCache.size > 256) fetchCache.clear();
  fetchCache.set(key, body);
  return body;
}

async function uploadPack(forge: Forge, repo: Repo, req: GitHttpRequest): Promise<GitHttpResponse> {
  const resultType = 'application/x-git-upload-pack-result';
  const body = req.body;
  // A malformed body must be answered, never crash the server.
  const first = parsePackets(body);
  const firstLine = first.packets.find((p) => p.kind === 'data')?.payload.toString('utf8') ?? '';

  if (firstLine.startsWith('command=')) {
    const command = firstLine.trim().slice('command='.length);
    // v2 requests are one pkt-line block: command + args, a delim, then arguments, then flush.
    const lines: string[] = [];
    let delimSeen = false;
    const argLines: string[] = [];
    for (const packet of first.packets) {
      if (packet.kind === 'delim') {
        delimSeen = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (!delimSeen) lines.push(text);
      else argLines.push(text);
    }
    void lines;
    if (command === 'ls-refs') {
      return { status: 200, body: lsRefs(forge, repo, argLines), headers: { 'content-type': resultType } };
    }
    if (command === 'fetch') {
      const parsed = parseFetchArgs(argLines);
      const key = fetchCacheKey(repo, parsed.wants, parsed.haves, parsed.clientShallow, parsed.depth, true);
      const body = cachedFetch(repo, key, () => buildFetchV2(forge, repo, parsed));
      return { status: 200, body, headers: { 'content-type': resultType } };
    }
    return { status: 200, body: pktLine('ERR unknown command\n'), headers: { 'content-type': resultType } };
  }

  // v0: two sections — wants/shallow/deepen, flush, haves/done, flush.
  const { sections } = parseSections(body);
  const wantLines = (sections[0] ?? []).map((b) => b.toString('utf8').replace(/\n$/, ''));
  const haveLines = (sections[1] ?? []).map((b) => b.toString('utf8').replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  for (const line of wantLines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7)) || null;
  }
  for (const line of haveLines) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const plan = planFetch(forge, wants, haves, clientShallow, depth);
  const key = fetchCacheKey(repo, wants, haves, clientShallow, depth, false);
  const responseBody = cachedFetch(repo, key, () => {
    const pack = writePack([...plan.objects.values()]);
    const parts: Buffer[] = [];
    for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(pktLine(plan.common !== null ? `ACK ${plan.common}\n` : 'NAK\n'));
    parts.push(sidebandWrap(pack));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  });
  return { status: 200, body: responseBody, headers: { 'content-type': resultType } };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: Set<string>;
  depth: number | null;
}

function parseFetchArgs(argLines: string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  for (const line of argLines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7)) || null;
  }
  return { wants, haves, clientShallow, depth };
}

function buildFetchV2(forge: Forge, repo: Repo, args: FetchArgs): Buffer {
  const { wants, haves, clientShallow, depth } = args;
  const plan = planFetch(forge, wants, haves, clientShallow, depth);
  const pack = writePack([...plan.objects.values()]);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine(plan.common !== null ? `ACK ${plan.common}\n` : 'NAK\n'));
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

async function receivePack(forge: Forge, repo: Repo, req: GitHttpRequest): Promise<GitHttpResponse> {
  const resultType = 'application/x-git-receive-pack-result';
  const { packets, tail } = parsePackets(req.body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const fields = text.split(' ');
    if (fields.length >= 3) commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
  }
  const pack = req.body.subarray(tail);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const read = await readPack(forge.objects, pack);
      if (!read.trailerOk) {
        unpackOk = false;
        unpackDetail = 'pack checksum mismatch';
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const report: string[] = [`unpack ${unpackDetail}\n`];
  const useSideband = capabilities.includes('side-band-64k');
  for (const command of commands) {
    const verdict = unpackOk ? applyRefUpdate(forge, repo, command) : { ok: false, reason: 'unpack failed' };
    report.push(verdict.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict.reason}\n`);
  }
  const reportStream = Buffer.concat(report.map((line) => pktLine(line)));
  const body = useSideband ? Buffer.concat([sidebandWrap(reportStream), PKT_FLUSH]) : Buffer.concat([reportStream, PKT_FLUSH]);
  return { status: 200, body, headers: { 'content-type': resultType } };
}

function applyRefUpdate(forge: Forge, repo: Repo, command: { oldOid: string; newOid: string; ref: string }): { ok: boolean; reason: string } {
  const verdict = applyRefUpdateInner(forge, repo, command);
  if (verdict.ok) repo.gitVersion += 1;
  return verdict;
}

function applyRefUpdateInner(forge: Forge, repo: Repo, command: { oldOid: string; newOid: string; ref: string }): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref) ?? ZERO;
  if (command.newOid === ZERO) {
    // Delete: the ref must be at the named old value.
    if (current === ZERO) return { ok: false, reason: 'reference not found' };
    if (current !== command.oldOid) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  const target = forge.objects.get(command.newOid);
  if (target === undefined) return { ok: false, reason: 'object not found' };
  if (command.oldOid === ZERO) {
    if (current !== ZERO) return { ok: false, reason: 'reference already exists' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  if (current !== command.oldOid) return { ok: false, reason: 'non-fast-forward' };
  // Fast-forward: the old commit must be an ancestor of the new one (peeling tags).
  const oldCommit = peelToCommit(forge, command.oldOid);
  const newCommit = peelToCommit(forge, command.newOid);
  if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit) {
    if (!isAncestorOf(forge, oldCommit, newCommit)) return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

function isAncestorOf(forge: Forge, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = forge.objects.get(sha);
    if (obj !== undefined && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}
