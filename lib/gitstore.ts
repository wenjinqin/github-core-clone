// The git object model, in memory: blobs, trees, commits and tags in one
// content-addressed store (node:crypto SHA-1, node:zlib for pack streams).
// Objects are stored raw, so anything a client pushes round-trips byte for
// byte; objects the forge creates itself (contents commits, squash merges)
// are built with the same serializers a git client would produce.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

export function sha1Of(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export class ObjectStore {
  private map = new Map<string, { type: ObjType; data: Buffer }>();

  put(type: ObjType, data: Buffer): string {
    const sha = sha1Of(type, data);
    if (!this.map.has(sha)) this.map.set(sha, { type, data });
    return sha;
  }

  putHashed(sha: string, type: ObjType, data: Buffer): void {
    if (!this.map.has(sha)) this.map.set(sha, { type, data });
  }

  get(sha: string): { type: ObjType; data: Buffer } | undefined {
    return this.map.get(sha);
  }

  has(sha: string): boolean {
    return this.map.has(sha);
  }

  /** Every object reachable from the given tips (commits walk to trees and blobs). */
  closure(tips: Iterable<string>, exclude: ReadonlySet<string> = new Set()): Map<string, { type: ObjType; data: Buffer }> {
    const out = new Map<string, { type: ObjType; data: Buffer }>();
    const stack = [...tips];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (out.has(sha) || exclude.has(sha)) continue;
      const obj = this.map.get(sha);
      if (obj === undefined) continue;
      out.set(sha, obj);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree, ...c.parents);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.sha);
      } else if (obj.type === 'tag') {
        const t = parseTag(obj.data);
        if (t !== null) stack.push(t.object);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    const mode = data.toString('utf8', at, sp);
    const nul = data.indexOf(0, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    at = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> {sha, mode}, recursing into subtrees. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const obj = store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') flattenTree(store, e.sha, `${prefix}${e.name}/`, out);
    else out.set(`${prefix}${e.name}`, { sha: e.sha, mode: e.mode });
  }
  return out;
}

/** Build (and store) a tree hierarchy from a flat path -> blob map; returns the root tree sha. */
export function buildTree(store: ObjectStore, files: Map<string, { sha: string; mode: string }>): string {
  interface Node {
    dirs: Map<string, Node>;
    files: Map<string, { sha: string; mode: string }>;
  }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: new Map() });
      node = node.dirs.get(part)!;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, sha: write(sub) });
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
    return store.put('tree', serializeTree(entries));
  };
  return write(root);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function serializeCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const p of info.parents) head += `parent ${p}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.from(head + info.message, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } | null {
  const text = data.toString('utf8');
  const m = /^object ([0-9a-f]{40})\ntype (\w+)\ntag ([^\n]*)/.exec(text);
  return m === null ? null : { object: m[1]!, type: m[2]!, tag: m[3]! };
}

/** Is `ancestor` reachable from `descendant` through commit parents? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj !== undefined && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** The nearest common ancestor of two commits (first shared node in BFS from both). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = store.get(sha);
      if (obj !== undefined && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
    }
    return seen;
  };
  const fromA = ancestorsOf(a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (fromA.has(sha)) return sha;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj !== undefined && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

// ---------------------------------------------------------------- packs

/** Apply a git delta (copy/insert instructions) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) offset |= delta[at++]! << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= delta[at++]! << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || written !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/** Create a delta from base to target (simple matcher: common prefix/suffix + literal middle). */
export function createDelta(base: Buffer, target: Buffer): Buffer {
  let prefix = 0;
  const maxPrefix = Math.min(base.length, target.length);
  while (prefix < maxPrefix && base[prefix] === target[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(base.length - prefix, target.length - prefix);
  while (suffix < maxSuffix && base[base.length - 1 - suffix] === target[target.length - 1 - suffix]) suffix += 1;
  const head: Buffer[] = [];
  const writeVarint = (value: number): void => {
    const bytes: number[] = [];
    let v = value;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v > 0) b |= 0x80;
      bytes.push(b);
    } while (v > 0);
    head.push(Buffer.from(bytes));
  };
  writeVarint(base.length);
  writeVarint(target.length);
  const body: Buffer[] = [];
  const copy = (offset: number, size: number): void => {
    let remaining = size;
    let at = offset;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 0x10000);
      let op = 0x80;
      const offBytes: number[] = [];
      const sizeBytes: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const b = (at >>> (8 * i)) & 0xff;
        if (b !== 0) { op |= 1 << i; offBytes.push(b); } else offBytes.push(0);
      }
      let sizeField = chunk === 0x10000 ? 0 : chunk;
      for (let i = 0; i < 3; i += 1) {
        const b = (sizeField >>> (8 * i)) & 0xff;
        if (b !== 0) op |= 0x10 << i;
        sizeBytes.push(b);
      }
      const bytes = [op];
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) bytes.push(offBytes[i]!);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) bytes.push(sizeBytes[i]!);
      body.push(Buffer.from(bytes));
      at += chunk;
      remaining -= chunk;
    }
  };
  const insert = (data: Buffer): void => {
    let at = 0;
    while (at < data.length) {
      const chunk = Math.min(data.length - at, 0x7f);
      body.push(Buffer.from([chunk]), data.subarray(at, at + chunk));
      at += chunk;
    }
  };
  if (prefix > 0) copy(0, prefix);
  const middle = target.subarray(prefix, target.length - suffix);
  if (middle.length > 0) insert(middle);
  if (suffix > 0) copy(base.length - suffix, suffix);
  return Buffer.concat([...head, ...body]);
}

/** Inflate one zlib stream starting at `offset`; returns the data and the offset just past the stream. */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Read every object out of a pack body (the bytes after the 12-byte PACK header), resolving deltas. */
export function readPack(store: ObjectStore, pack: Buffer): { count: number; trailerOk: boolean } {
  if (pack.toString('utf8', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let at = 12;
  interface Entry {
    offset: number;
    type?: ObjType;
    data?: Buffer;
    baseOffset?: number;
    baseSha?: string;
    delta?: Buffer;
  }
  const entries: Entry[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = at;
    let byte = pack[at++]!;
    const typeNum = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    void size;
    if (typeNum === 6) {
      byte = pack[at++]!;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[at++]!;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      const { data, next } = inflateAt(pack, at);
      at = next;
      entries.push({ offset: entryOffset, baseOffset: entryOffset - back, delta: data });
    } else if (typeNum === 7) {
      const baseSha = pack.toString('hex', at, at + 20);
      at += 20;
      const { data, next } = inflateAt(pack, at);
      at = next;
      entries.push({ offset: entryOffset, baseSha, delta: data });
    } else {
      const { data, next } = inflateAt(pack, at);
      at = next;
      entries.push({ offset: entryOffset, type: NUM_TYPE[typeNum]!, data });
    }
  }
  const byOffset = new Map<number, Entry>();
  for (const e of entries) byOffset.set(e.offset, e);
  const resolved = new Map<number, string>();
  const resolve = (entry: Entry): string => {
    const memo = resolved.get(entry.offset);
    if (memo !== undefined) return memo;
    let sha: string;
    if (entry.delta === undefined) {
      sha = store.put(entry.type!, entry.data!);
    } else {
      let baseSha: string;
      if (entry.baseSha !== undefined) baseSha = entry.baseSha;
      else {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error('ofs-delta base not in this pack');
        baseSha = resolve(baseEntry);
      }
      const base = store.get(baseSha);
      if (base === undefined) throw new Error(`delta base ${baseSha} unknown (thin pack base missing)`);
      sha = store.put(base.type, applyDelta(base.data, entry.delta));
    }
    resolved.set(entry.offset, sha);
    return sha;
  };
  for (const entry of entries) resolve(entry);
  const trailer = pack.subarray(at, at + 20);
  const digest = createHash('sha1').update(pack.subarray(0, at)).digest();
  return { count, trailerOk: trailer.equals(digest) };
}

/** Write a pack holding the given objects (full objects only; deltas are the reader's problem). */
export function writePack(objects: Iterable<{ sha: string; type: ObjType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    const compressed = deflateSync(obj.data);
    let size = obj.data.length;
    const typeNum = TYPE_NUM[obj.type];
    const bytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    size >>>= 4;
    if (size > 0) first |= 0x80;
    bytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>>= 7;
      if (size > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes), compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
