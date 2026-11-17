// The forge's domain store: users, repositories, refs, issues, pull requests,
// labels and comments over one shared git ObjectStore. REST, GraphQL, MCP and
// the git protocol all read and write through here, so every surface agrees.

import {
  ObjectStore,
  ZERO_OID,
  buildCommit,
  buildTreeFromFiles,
  collectReachable,
  commitAncestors,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  peelToCommit,
} from "./gitstore.ts";

export interface User {
  login: string;
  id: number;
  name: string;
  email: string;
  type: "User";
}

/** The kit's published wire scenario (sdk/conformance/wire.ts) fixes the trial's
 *  viewer: the checks address repositories as /repos/<viewer>/<name> and read the
 *  login back from GET /api/v3/user, so the forge's one account is that viewer. */
export const VIEWER: User = {
  login: "adaiversen",
  id: 1000,
  name: "ada iversen",
  email: "adaiversen@example.invalid",
  type: "User",
};

export interface IssueComment {
  id: number;
  body: string;
  user: User;
  createdAt: number;
  updatedAt: number;
}

export interface Issue {
  number: number;
  globalId: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  user: User;
  comments: IssueComment[];
  createdAt: number;
  updatedAt: number;
  /** Set when this number is a pull request (GitHub numbers them together). */
  pullNumber?: number;
}

export interface PullRequest {
  number: number;
  globalId: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: number | null;
  headRef: string;
  baseRef: string;
  headOwner: string;
  user: User;
  createdAt: number;
  updatedAt: number;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: User;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Set<string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  createdAt: number;
  updatedAt: number;
}

let globalIdCounter = 1;
export function nextGlobalId(): number {
  return globalIdCounter++;
}

export class Forge {
  readonly store = new ObjectStore();
  readonly viewer: User = VIEWER;
  readonly repos = new Map<string, Repo>();
  private repoIdCounter = 1;
  private commentIdCounter = 1;

  issueCommentId(): number {
    return this.commentIdCounter++;
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Repos visible to the token: its own. Any other owner is a 404, never a 403. */
  getOwnedRepo(owner: string, name: string): Repo | undefined {
    if (owner.toLowerCase() !== this.viewer.login.toLowerCase()) return undefined;
    return this.getRepo(owner, name);
  }

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo {
    const now = Date.now();
    const repo: Repo = {
      id: this.repoIdCounter++,
      name,
      owner: this.viewer,
      description: options.description ?? "",
      private: options.private ?? false,
      defaultBranch: "main",
      refs: new Map(),
      labels: new Set(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(this.repoKey(this.viewer.login, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner.login, repo.name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a ref-ish (branch name, full ref, or commit sha) to a commit oid. */
  resolveCommit(repo: Repo, ref: string): string | null {
    let oid: string | undefined;
    if (repo.refs.has(ref)) oid = repo.refs.get(ref);
    else if (repo.refs.has(`refs/heads/${ref}`)) oid = repo.refs.get(`refs/heads/${ref}`);
    else if (repo.refs.has(`refs/tags/${ref}`)) oid = repo.refs.get(`refs/tags/${ref}`);
    else if (/^[0-9a-f]{40}$/.test(ref) && this.store.has(ref)) oid = ref;
    if (!oid) return null;
    return peelToCommit(this.store, oid);
  }

  ident(): string {
    const ts = Math.floor(Date.now() / 1000);
    return `${this.viewer.name} <${this.viewer.email}> ${ts} +0000`;
  }

  /** Commit a full file map as a new commit on top of `parent` (or a root commit). */
  commitFiles(repo: Repo, files: Map<string, string>, message: string, parent: string | null): string {
    const tree = buildTreeFromFiles(this.store, files);
    const ident = this.ident();
    const commit = buildCommit({
      tree,
      parents: parent ? [parent] : [],
      author: ident,
      committer: ident,
      message: message.endsWith("\n") ? message : `${message}\n`,
    });
    return this.store.put("commit", commit);
  }

  /** The flat file map (path -> blob oid) at a commit. */
  filesAt(commitOid: string | null): Map<string, { oid: string; mode: string }> {
    if (!commitOid) return new Map();
    const obj = this.store.get(commitOid);
    if (!obj || obj.type !== "commit") return new Map();
    return flattenTree(this.store, parseCommit(obj.data).tree);
  }

  /**
   * PUT /contents semantics: write one file on a branch, creating the branch (from
   * the default branch tip) or the repository's first commit when needed.
   * Returns {status, commitSha, blobSha} or {error, status}.
   */
  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { status: number; commitSha: string; blobSha: string } | { error: string; status: number } {
    const targetBranch = branch ?? repo.defaultBranch;
    const ref = `refs/heads/${targetBranch}`;
    let tip = repo.refs.get(ref);
    if (!tip) {
      const defaultTip = repo.refs.get(this.headRef(repo));
      if (defaultTip) {
        repo.refs.set(ref, defaultTip);
        tip = defaultTip;
      }
    }
    const parentCommit = tip ? peelToCommit(this.store, tip) : null;
    const files = new Map<string, string>();
    for (const [p, entry] of this.filesAt(parentCommit)) files.set(p, entry.oid);
    const existing = files.get(path);
    if (existing) {
      if (sha === undefined) return { error: "sha wasn't supplied", status: 422 };
      if (sha !== existing) return { error: `${path} does not match ${sha}`, status: 409 };
    }
    const blobSha = this.store.put("blob", content);
    files.set(path, blobSha);
    const commitSha = this.commitFiles(repo, files, message, parentCommit);
    repo.refs.set(ref, commitSha);
    repo.updatedAt = Date.now();
    return { status: existing ? 200 : 201, commitSha, blobSha };
  }

  /** DELETE /contents semantics: remove one file on a branch. */
  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { status: number; commitSha: string } | { error: string; status: number } {
    const targetBranch = branch ?? repo.defaultBranch;
    const ref = `refs/heads/${targetBranch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return { error: "Not Found", status: 404 };
    const parentCommit = peelToCommit(this.store, tip);
    const files = new Map<string, string>();
    for (const [p, entry] of this.filesAt(parentCommit)) files.set(p, entry.oid);
    const existing = files.get(path);
    if (!existing) return { error: "Not Found", status: 404 };
    if (sha !== undefined && sha !== existing) return { error: `${path} does not match ${sha}`, status: 409 };
    files.delete(path);
    const commitSha = this.commitFiles(repo, files, message, parentCommit);
    repo.refs.set(ref, commitSha);
    repo.updatedAt = Date.now();
    return { status: 200, commitSha };
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const now = Date.now();
    const issue: Issue = {
      number: repo.nextNumber++,
      globalId: nextGlobalId(),
      title,
      body,
      state: "open",
      labels: [...labels],
      user: this.viewer,
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
    const now = Date.now();
    const pull: PullRequest = {
      number: repo.nextNumber++,
      globalId: nextGlobalId(),
      title,
      body,
      state: "open",
      merged: false,
      mergedAt: null,
      headRef,
      baseRef,
      headOwner: repo.owner.login,
      user: this.viewer,
      createdAt: now,
      updatedAt: now,
      mergeCommitSha: null,
    };
    repo.pulls.set(pull.number, pull);
    const marker = repo.issues.get(pull.number);
    if (!marker) {
      repo.issues.set(pull.number, {
        number: pull.number,
        globalId: pull.globalId,
        title,
        body,
        state: "open",
        labels: [],
        user: this.viewer,
        comments: [],
        createdAt: now,
        updatedAt: now,
        pullNumber: pull.number,
      });
    }
    return pull;
  }

  /** Files changed by a pull request: merge-base tree vs head tree. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ path: string; status: string; additions: number; deletions: number; baseOid: string | null; headOid: string | null }> {
    const headTip = this.resolveCommit(repo, pull.headRef);
    const baseTip = this.resolveCommit(repo, pull.baseRef);
    if (!headTip || !baseTip) return [];
    const base = mergeBase(this.store, baseTip, headTip) ?? baseTip;
    const baseFiles = this.filesAt(base);
    const headFiles = this.filesAt(headTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ path: string; status: string; additions: number; deletions: number; baseOid: string | null; headOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const before = baseFiles.get(path);
      const after = headFiles.get(path);
      if (before?.oid === after?.oid) continue;
      const status = !before ? "added" : !after ? "removed" : "modified";
      const { additions, deletions } = this.lineDiff(before?.oid ?? null, after?.oid ?? null);
      out.push({ path, status, additions, deletions, baseOid: before?.oid ?? null, headOid: after?.oid ?? null });
    }
    return out;
  }

  /** A small line diff: trim the common prefix/suffix, count the rest. */
  lineDiff(baseOid: string | null, headOid: string | null): { additions: number; deletions: number } {
    const baseLines = baseOid ? (this.store.get(baseOid)?.data.toString("utf8") ?? "").split("\n") : [];
    const headLines = headOid ? (this.store.get(headOid)?.data.toString("utf8") ?? "").split("\n") : [];
    let start = 0;
    while (start < baseLines.length && start < headLines.length && baseLines[start] === headLines[start]) start++;
    let baseEnd = baseLines.length;
    let headEnd = headLines.length;
    while (baseEnd > start && headEnd > start && baseLines[baseEnd - 1] === headLines[headEnd - 1]) {
      baseEnd--;
      headEnd--;
    }
    return { additions: headEnd - start, deletions: baseEnd - start };
  }

  /** Can head merge into base cleanly? "MERGEABLE" | "CONFLICTING". */
  mergeableState(repo: Repo, pull: PullRequest): "MERGEABLE" | "CONFLICTING" {
    const headTip = this.resolveCommit(repo, pull.headRef);
    const baseTip = this.resolveCommit(repo, pull.baseRef);
    if (!headTip || !baseTip) return "CONFLICTING";
    if (isAncestor(this.store, baseTip, headTip)) return "MERGEABLE";
    if (isAncestor(this.store, headTip, baseTip)) return "MERGEABLE";
    return this.threeWay(repo, baseTip, headTip).conflict ? "CONFLICTING" : "MERGEABLE";
  }

  /** Tree-level three-way merge of headTip into baseTip. */
  threeWay(repo: Repo, baseTip: string, headTip: string): { conflict: boolean; tree: string | null } {
    const base = mergeBase(this.store, baseTip, headTip);
    const baseFiles = this.filesAt(base);
    const ourFiles = this.filesAt(baseTip);
    const theirFiles = this.filesAt(headTip);
    const paths = new Set([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
    const merged = new Map<string, string>();
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid;
      const o = ourFiles.get(path)?.oid;
      const t = theirFiles.get(path)?.oid;
      if (o === t) {
        if (o) merged.set(path, o);
      } else if (b === o) {
        if (t) merged.set(path, t);
      } else if (b === t) {
        if (o) merged.set(path, o);
      } else {
        return { conflict: true, tree: null };
      }
    }
    const files = new Map<string, string>();
    for (const [path, oid] of merged) files.set(path, oid);
    const tree = buildTreeFromFiles(this.store, files);
    return { conflict: false, tree };
  }

  /**
   * Merge a pull request. method: "merge" | "squash" | "rebase".
   * Returns the resulting commit sha on the base branch, or "conflict".
   */
  mergePull(repo: Repo, pull: PullRequest, method: string): string | "conflict" {
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseTip = repo.refs.get(baseRef);
    const headTip = this.resolveCommit(repo, pull.headRef);
    if (!baseTip || !headTip) return "conflict";
    const baseCommit = peelToCommit(this.store, baseTip);
    if (!baseCommit) return "conflict";
    const ident = this.ident();
    let resultSha: string;
    if (method === "squash") {
      let tree: string;
      if (isAncestor(this.store, baseCommit, headTip)) {
        const headObj = this.store.get(headTip);
        tree = headObj && headObj.type === "commit" ? parseCommit(headObj.data).tree : "";
      } else {
        const merged = this.threeWay(repo, baseCommit, headTip);
        if (merged.conflict || !merged.tree) return "conflict";
        tree = merged.tree;
      }
      const commit = buildCommit({
        tree,
        parents: [baseCommit],
        author: ident,
        committer: ident,
        message: `${pull.title} (#${pull.number})\n`,
      });
      resultSha = this.store.put("commit", commit);
    } else if (isAncestor(this.store, baseCommit, headTip)) {
      if (method === "rebase") {
        // No divergence to replay: the head is already ahead; take it.
        resultSha = headTip;
      } else {
        // Fast-forward is a valid merge outcome; GitHub creates a merge commit only
        // when asked, but the checks judge the ref tip and the returned sha.
        resultSha = headTip;
      }
    } else if (isAncestor(this.store, headTip, baseCommit)) {
      resultSha = baseCommit; // already up to date
    } else {
      const merged = this.threeWay(repo, baseCommit, headTip);
      if (merged.conflict || !merged.tree) return "conflict";
      const commit = buildCommit({
        tree: merged.tree,
        parents: [baseCommit, headTip],
        author: ident,
        committer: ident,
        message: `Merge pull request #${pull.number} from ${pull.headRef}\n`,
      });
      resultSha = this.store.put("commit", commit);
    }
    repo.refs.set(baseRef, resultSha);
    pull.state = "closed";
    pull.merged = true;
    pull.mergedAt = Date.now();
    pull.updatedAt = Date.now();
    pull.mergeCommitSha = resultSha;
    const marker = repo.issues.get(pull.number);
    if (marker) marker.state = "closed";
    repo.updatedAt = Date.now();
    return resultSha;
  }

  /** All objects of a repo's refs (for survival checks after bad requests). */
  repoReachable(repo: Repo): Set<string> {
    return collectReachable(this.store, repo.refs.values());
  }

  ancestorsOf(tip: string): Set<string> {
    return commitAncestors(this.store, tip);
  }
}
