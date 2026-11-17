// Git smart HTTP: info/refs advertisements (protocol v2 for upload-pack, v0 for
// receive-pack), ls-refs, fetch (v2 and v0) and receive-pack with report-status.
// Implemented from the git protocol documents over node:zlib/node:crypto only.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Forge, type Repo } from "./forge.ts";
import {
  ZERO_OID,
  collectReachable,
  commitDistances,
  decodePkts,
  encodePkts,
  parseTag,
  pktLine,
  readPack,
  sidebandWrap,
  writePack,
  type ObjectStore,
} from "./gitstore.ts";

const AGENT = "git/forge-1.0";

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Peel an oid through annotated tags to the object it ultimately names. */
function peelFully(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let i = 0; i < 16; i++) {
    const obj = store.get(current);
    if (!obj || obj.type !== "tag") return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

function uploadCaps(repo: Repo): string {
  return [
    "multi_ack_detailed",
    "side-band-64k",
    "thin-pack",
    "ofs-delta",
    "shallow",
    "deepen-since",
    "deepen-not",
    `symref=HEAD:${`refs/heads/${repo.defaultBranch}`}`,
    `agent=${AGENT}`,
  ].join(" ");
}

function receiveCaps(): string {
  return ["report-status", "delete-refs", "side-band-64k", "ofs-delta", "quiet", `agent=${AGENT}`].join(" ");
}

export function infoRefs(forge: Forge, repo: Repo, service: string, protocolVersion: number, res: ServerResponse): void {
  const store = forge.store;
  if (service === "git-upload-pack" && protocolVersion === 2) {
    const body = encodePkts([
      "# service=git-upload-pack\n",
      "flush",
      "version 2\n",
      `agent=${AGENT}\n`,
      "ls-refs=unborn\n",
      "fetch=shallow wait-for-done\n",
      "object-format=sha1\n",
      "flush",
    ]);
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement", "cache-control": "no-cache" });
    res.end(body);
    return;
  }
  const isUpload = service === "git-upload-pack";
  const caps = isUpload ? uploadCaps(repo) : receiveCaps();
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = true;
    if (headTip) {
      lines.push(`${headTip} HEAD\0${caps}\n`);
      first = false;
    }
    for (const [name, oid] of refs) {
      lines.push(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`);
      first = false;
      const obj = store.get(oid);
      if (obj?.type === "tag") lines.push(`${peelFully(store, oid)} ${name}^{}\n`);
    }
  }
  const body = encodePkts([`# service=${service}\n`, "flush", ...lines, "flush"]);
  res.writeHead(200, {
    "content-type": `application/x-${service}-advertisement`,
    "cache-control": "no-cache",
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// ls-refs
// ---------------------------------------------------------------------------

function lsRefs(forge: Forge, repo: Repo, args: string[]): Buffer {
  const store = forge.store;
  const peel = args.includes("peel");
  const symrefs = args.includes("symrefs");
  const unborn = args.includes("unborn");
  const prefixes = args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice("ref-prefix ".length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (matches("HEAD")) {
    if (headTip) {
      lines.push(symrefs ? `${headTip} HEAD symref-target:${headRef}\n` : `${headTip} HEAD\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${headRef}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    const obj = store.get(oid);
    if (peel && obj?.type === "tag") line += ` peeled:${peelFully(store, oid)}`;
    lines.push(`${line}\n`);
  }
  return encodePkts([...lines, "flush"]);
}

// ---------------------------------------------------------------------------
// fetch (upload-pack POST)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, "");
    if (line.startsWith("want ")) args.wants.push(line.slice(5).trim());
    else if (line.startsWith("have ")) args.haves.push(line.slice(5).trim());
    else if (line.startsWith("shallow ")) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith("deepen ")) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === "done") args.done = true;
  }
  return args;
}

interface FetchPlan {
  packOids: string[];
  shallow: string[];
  unshallow: string[];
  commonHave: string | null;
}

function planFetch(forge: Forge, args: FetchArgs): FetchPlan {
  const store = forge.store;
  const clientShallow = new Set(args.shallow);
  // Exclusion: everything reachable from the haves, not crossing the client's
  // shallow boundary (the client does not hold anything below it).
  const exclude = args.haves.length ? collectReachable(store, args.haves, clientShallow) : new Set<string>();
  // A have counts as common when the server holds it as a commit.
  let commonHave: string | null = null;
  for (const have of args.haves) {
    const obj = store.get(have);
    if (obj?.type === "commit") {
      commonHave = have;
      break;
    }
  }
  const validWants = args.wants.filter((oid) => store.has(oid));
  let boundary = new Set<string>();
  let newShallow: string[] = [];
  if (args.depth != null && Number.isFinite(args.depth) && args.depth > 0) {
    const distances = commitDistances(store, validWants);
    for (const [commit, distance] of distances) {
      if (distance === args.depth - 1) {
        // Boundary commits are included but their parents are cut; a root commit
        // at the boundary cuts nothing and is not reported shallow.
        if (commitParents(store, commit).length > 0) boundary.add(commit);
      }
    }
    newShallow = [...boundary];
  }
  const include = collectReachable(store, validWants, boundary);
  const packOids = [...include].filter((oid) => !exclude.has(oid));
  const unshallow = [...clientShallow].filter((oid) => include.has(oid) && !boundary.has(oid));
  return { packOids, shallow: newShallow, unshallow, commonHave };
}

function commitParents(store: ObjectStore, oid: string): string[] {
  const obj = store.get(oid);
  if (!obj || obj.type !== "commit") return [];
  const parents: string[] = [];
  for (const line of obj.data.toString("utf8").split("\n")) {
    if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line === "") break;
  }
  return parents;
}

export function uploadPack(forge: Forge, repo: Repo, body: Buffer, protocolVersion: number, res: ServerResponse): void {
  let pkts;
  try {
    pkts = decodePkts(body);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad pkt-line stream");
    return;
  }
  const lines: string[] = [];
  for (const pkt of pkts) if (pkt.kind === "data") lines.push(pkt.payload.toString("utf8"));
  const commandLine = lines.find((l) => l.startsWith("command="));
  const command = commandLine ? commandLine.slice("command=".length).trim() : "";

  if (protocolVersion === 2 && command === "ls-refs") {
    const delimIndex = pkts.findIndex((p) => p.kind === "delim");
    const argLines = pkts
      .slice(delimIndex + 1)
      .filter((p) => p.kind === "data")
      .map((p) => p.payload.toString("utf8").replace(/\n$/, ""));
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" });
    res.end(lsRefs(forge, repo, argLines));
    return;
  }

  if (command === "fetch" || (protocolVersion !== 2 && lines.some((l) => l.startsWith("want ")))) {
    const args = parseFetchArgs(lines);
    const plan = planFetch(forge, args);
    const pack = writePack(forge.store, plan.packOids);
    if (protocolVersion === 2) {
      const parts: Buffer[] = [];
      if (args.done || args.haves.length) {
        const ackLines: string[] = ["acknowledgments\n"];
        if (plan.commonHave) {
          ackLines.push(`ACK ${plan.commonHave}\n`);
          if (args.done) ackLines.push("ready\n");
        } else {
          ackLines.push("NAK\n");
        }
        parts.push(encodePkts([...ackLines, "flush"]));
      }
      if (args.depth != null || plan.unshallow.length) {
        const shallowLines: string[] = ["shallow-info\n"];
        for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
        for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
        parts.push(encodePkts([...shallowLines, "flush"]));
      }
      parts.push(encodePkts(["packfile\n"]));
      parts.push(sidebandWrap(pack));
      parts.push(encodePkts(["flush"]));
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" });
      res.end(Buffer.concat(parts));
      return;
    }
    // Protocol v0: shallow lines and NAK/ACK as plain pkt-lines, then the pack in
    // sideband packets, then a flush.
    const head: string[] = [];
    for (const oid of plan.shallow) head.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) head.push(`unshallow ${oid}\n`);
    if (plan.commonHave) head.push(`ACK ${plan.commonHave} common\n`);
    else head.push("NAK\n");
    const bodyOut = Buffer.concat([encodePkts(head), sidebandWrap(pack), encodePkts(["flush"])]);
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" });
    res.end(bodyOut);
    return;
  }

  res.writeHead(400, { "content-type": "text/plain" });
  res.end("unsupported upload-pack command");
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, repo: Repo, body: Buffer, res: ServerResponse): void {
  const store = forge.store;
  // Split the pkt-line command list from the pack that follows the first flush.
  let offset = 0;
  const commands: PushCommand[] = [];
  let sideband = false;
  let parseError: string | null = null;
  try {
    let first = true;
    for (;;) {
      if (offset + 4 > body.length) throw new Error("truncated command list");
      const head = body.subarray(offset, offset + 4).toString("ascii");
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error("bad pkt-line in command list");
      const length = parseInt(head, 16);
      if (length === 0) {
        offset += 4;
        break;
      }
      if (length < 4 || offset + length > body.length) throw new Error("bad command pkt-line length");
      let payload = body.subarray(offset + 4, offset + length).toString("utf8");
      offset += length;
      if (first) {
        const nul = payload.indexOf("\0");
        if (nul >= 0) {
          const caps = payload.slice(nul + 1);
          if (caps.split(" ").includes("side-band-64k")) sideband = true;
          payload = payload.slice(0, nul);
        }
        first = false;
      }
      const line = payload.replace(/\n$/, "");
      const parts = line.split(" ");
      if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(" ") });
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  const report: string[] = [];
  if (parseError) {
    report.push(`unpack ${parseError}\n`);
  } else {
    const packBytes = body.subarray(offset);
    let unpackError: string | null = null;
    const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
    if (hasUpdates && packBytes.length > 0) {
      try {
        const objects = readPack(packBytes, (oid) => store.get(oid));
        for (const obj of objects) store.putObject(obj);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    } else if (hasUpdates) {
      unpackError = "no packfile sent";
    }
    report.push(unpackError ? `unpack ${unpackError}\n` : "unpack ok\n");

    for (const command of commands) {
      if (unpackError) {
        report.push(`ng ${command.ref} unpacker error\n`);
        continue;
      }
      const problem = applyRefUpdate(forge, repo, command);
      report.push(problem ? `ng ${command.ref} ${problem}\n` : `ok ${command.ref}\n`);
    }
  }
  const reportStream = encodePkts([...report, "flush"]);
  const out = sideband ? Buffer.concat([sidebandWrap(reportStream), encodePkts(["flush"])]) : reportStream;
  res.writeHead(200, { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" });
  res.end(out);
}

function applyRefUpdate(forge: Forge, repo: Repo, command: PushCommand): string | null {
  const store = forge.store;
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    // Delete: the named old value must be the current tip.
    if (current === ZERO_OID) return "reference does not exist";
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return "stale ref";
    repo.refs.delete(command.ref);
    return null;
  }
  const newObj = store.get(command.newOid);
  if (!newObj) return "missing object";
  if (command.oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return "reference already exists";
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  if (current !== command.oldOid) return "stale ref";
  // Fast-forward only for branches: the old tip must be an ancestor of the new one.
  if (command.ref.startsWith("refs/heads/")) {
    const oldCommit = oldCommitOf(store, command.oldOid);
    const newCommit = oldCommitOf(store, command.newOid);
    if (oldCommit && newCommit && !forge.ancestorsOf(newCommit).has(oldCommit)) {
      return "non-fast-forward";
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

function oldCommitOf(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 16; i++) {
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

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export { pktLine };
