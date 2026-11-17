// Git object store, packfiles and pkt-lines, pure Node stdlib (node:crypto, node:zlib).
// SHA-1 object ids, loose-object semantics kept in memory: the forge is one process
// and trials start from an empty store.

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export type ObjectType = "commit" | "tree" | "blob" | "tag";
export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = "0".repeat(40);
const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, "utf8");
  return createHash("sha1").update(header).update(data).digest("hex");
}

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObject(obj: GitObject): string {
    return this.put(obj.type, obj.data);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------------------
// Commits and trees
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? "" : text.slice(split + 2);
  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join("\n")}\n\n${info.message}`, "utf8");
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: "", type: "", tag: "", tagger: "", message: split === -1 ? "" : text.slice(split + 2) };
  for (const line of head.split("\n")) {
    if (line.startsWith("object ")) info.object = line.slice(7).trim();
    else if (line.startsWith("type ")) info.type = line.slice(5).trim();
    else if (line.startsWith("tag ")) info.tag = line.slice(4).trim();
    else if (line.startsWith("tagger ")) info.tagger = line.slice(7);
  }
  return info;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString("ascii");
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString("utf8");
    const oid = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: bytewise by name, directories sorting as if the name ended in "/". */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === "40000" ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"));
    parts.push(Buffer.from(entry.oid, "hex"));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> {oid, mode}; recursive. Missing trees flatten to nothing. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = "", out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = store.get(treeOid);
  if (!obj || obj.type !== "tree") return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === "40000") flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build nested trees from a flat path -> blob oid map; returns the root tree oid. */
export function buildTreeFromFiles(store: ObjectStore, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], oid);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: "100644", name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: "40000", name, oid: emit(child) });
    return store.put("tree", buildTree(entries));
  };
  return emit(root);
}

// ---------------------------------------------------------------------------
// Reachability and ancestry
// ---------------------------------------------------------------------------

/** Every object reachable from roots (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(store: ObjectStore, roots: Iterable<string>, stopAt?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (stopAt?.has(oid) && obj.type === "commit") {
      // Include the boundary commit and its trees, but not its parents.
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      continue;
    }
    if (obj.type === "commit") {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (obj.type === "tree") {
      for (const entry of parseTree(obj.data)) if (entry.mode !== "160000") queue.push(entry.oid);
    } else if (obj.type === "tag") {
      queue.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Peel a ref target to a commit oid (through annotated tags); null when it is not a commit. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth++) {
    const obj = store.get(current);
    if (!obj) return null;
    if (obj.type === "commit") return current;
    if (obj.type === "tag") {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** All commit ancestors of a commit, including itself. */
export function commitAncestors(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== "commit") continue;
    seen.add(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(store, descendant).has(ancestor);
}

/** A best common ancestor of two commits (BFS from both sides), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = commitAncestors(store, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = store.get(oid);
    if (obj && obj.type === "commit") queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** Commit generations: distance (min edges) from the given tips, commits only. */
export function commitDistances(store: ObjectStore, tips: Iterable<string>): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(store, tip);
    if (commit && !distance.has(commit)) {
      distance.set(commit, 0);
      frontier.push(commit);
    }
  }
  let depth = 0;
  while (frontier.length) {
    depth += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      const obj = store.get(oid);
      if (!obj || obj.type !== "commit") continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return distance;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A plain (undeltified) pack of the given objects, with a correct SHA-1 trailer. */
export function writePack(store: ObjectStore, oids: Iterable<string>): Buffer {
  const list = [...oids];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = store.get(oid);
    if (!obj) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (copy/insert instructions) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error("delta base size mismatch");
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) copyOffset += delta[offset++] * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) copySize += delta[offset++] * 2 ** (8 * (i + 2));
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error("delta opcode 0 is reserved");
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error("delta target size mismatch");
  return result;
}

export interface PackRead {
  objects: GitObject[];
  /** SHA-1 of the whole pack before the trailer, for verification by the caller. */
  count: number;
}

/**
 * Read a pack received from a client: plain entries plus ofs-delta and ref-delta
 * (ref-delta bases may live in `external`, i.e. objects the repo already holds).
 * Returns every object it reconstructed, in pack order of first reconstruction.
 */
export function readPack(pack: Buffer, external: (oid: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("not a packfile");
  }
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  let offset = 12;
  interface Pending {
    type: ObjectType | "ofs-delta" | "ref-delta";
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    offset: number;
  }
  const pending: Pending[] = [];
  const byOffset = new Map<number, GitObject>();
  const resolved: GitObject[] = [];
  for (let i = 0; i < count; i++) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      let b = pack[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString("hex");
      offset += 20;
    }
    const entry = inflateEntry(pack, offset, end, size);
    offset = entry.next;
    const raw = entry.data;
    if (typeCode === 6) pending.push({ type: "ofs-delta", data: Buffer.from(raw), baseOffset, offset: entryOffset });
    else if (typeCode === 7) pending.push({ type: "ref-delta", data: Buffer.from(raw), baseOid, offset: entryOffset });
    else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack type code ${typeCode}`);
      const obj: GitObject = { type, data: Buffer.from(raw) };
      byOffset.set(entryOffset, obj);
      resolved.push(obj);
    }
  }
  // Resolve deltas iteratively (a delta's base may itself be a delta).
  let progress = true;
  const remaining = [...pending];
  while (remaining.length && progress) {
    progress = false;
    for (let i = remaining.length - 1; i >= 0; i--) {
      const entry = remaining[i];
      let base: GitObject | undefined;
      if (entry.type === "ofs-delta") base = byOffset.get(entry.baseOffset!);
      else if (entry.baseOid) base = byOffsetByOid(byOffset, entry.baseOid) ?? external(entry.baseOid);
      if (!base) continue;
      const obj: GitObject = { type: base.type, data: applyDelta(base.data, entry.data) };
      byOffset.set(entry.offset, obj);
      resolved.push(obj);
      remaining.splice(i, 1);
      progress = true;
    }
  }
  if (remaining.length) throw new Error("pack has deltas with missing bases");
  return resolved;
}

function byOffsetByOid(byOffset: Map<number, GitObject>, oid: string): GitObject | undefined {
  for (const obj of byOffset.values()) if (objectId(obj.type, obj.data) === oid) return obj;
  return undefined;
}

/** Adler-32 of a buffer (the zlib stream trailer), computed in the standard blocks. */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let index = 0;
  while (index < data.length) {
    const block = Math.min(5552, data.length - index);
    for (let i = 0; i < block; i++) {
      a += data[index++];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the zlib stream starting at `start` and find where it ends.
 * inflateSync tolerates trailing bytes and returns exactly the first stream's
 * output, so inflate once to learn the object, then locate the stream's
 * Adler-32 trailer and verify each candidate position with one exact inflate.
 */
function inflateEntry(pack: Buffer, start: number, end: number, size: number): { data: Buffer; next: number } {
  const data = inflateSync(pack.subarray(start, end));
  if (data.length !== size) throw new Error("pack entry inflates to the wrong size");
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  let from = start + 2;
  for (;;) {
    const idx = pack.indexOf(needle, from);
    if (idx === -1 || idx + 4 > end) throw new Error("pack entry stream does not terminate");
    try {
      const check = inflateSync(pack.subarray(start, idx + 4));
      if (check.length === size && check.equals(data)) return { data, next: idx + 4 };
    } catch {
      // A false Adler candidate inside the compressed bytes; keep scanning.
    }
    from = idx + 1;
  }
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export type Pkt = string | Buffer | "flush" | "delim" | "response-end";

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error("pkt-line too long");
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, "0"), "ascii"), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from("0000", "ascii");
}

export function pktDelim(): Buffer {
  return Buffer.from("0001", "ascii");
}

export function encodePkts(pkts: Pkt[]): Buffer {
  const parts: Buffer[] = [];
  for (const pkt of pkts) {
    if (pkt === "flush") parts.push(pktFlush());
    else if (pkt === "delim") parts.push(pktDelim());
    else if (pkt === "response-end") parts.push(Buffer.from("0002", "ascii"));
    else parts.push(pktLine(pkt));
  }
  return Buffer.concat(parts);
}

export interface ParsedPkt {
  kind: "data" | "flush" | "delim" | "response-end";
  payload: Buffer;
}

/** Decode a complete pkt-line stream (request bodies are fully buffered). */
export function decodePkts(buffer: Buffer): ParsedPkt[] {
  const out: ParsedPkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error("truncated pkt-line header");
    const head = buffer.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      out.push({ kind: "flush", payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      out.push({ kind: "delim", payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      out.push({ kind: "response-end", payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 3) {
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error("truncated pkt-line payload");
      out.push({ kind: "data", payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return out;
}

/** Sideband-wrap a payload: split into <=65515-byte band-1 packets (plus optional progress).
 *  A pkt-line is at most 65520 bytes on the wire including its 4-byte header, so a
 *  sideband packet carries at most 65516 payload bytes, one of which is the band. */
export function sidebandWrap(data: Buffer, progress?: string): Buffer {
  const parts: Buffer[] = [];
  if (progress) parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(progress, "utf8")])));
  for (let offset = 0; offset < data.length; offset += 65515) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(offset, offset + 65515)])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}
