// GitHub REST v3 surface. Every reply is JSON; errors are {"message": ...};
// pagination follows GitHub's page/per_page + Link header contract.

import type { ServerResponse } from "node:http";
import { Forge, type Issue, type PullRequest, type Repo, type User } from "./forge.ts";
import { parseCommit } from "./gitstore.ts";

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, decoded. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyMalformed: boolean;
  baseUrl: string;
}

export function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-github-request-id": requestId(),
    "x-oauth-scopes": "repo, read:org",
    ...extraHeaders,
  });
  res.end(text);
}

let requestCounter = 0;
export function requestId(): string {
  requestCounter += 1;
  return `FORGE-${Date.now().toString(36).toUpperCase()}-${requestCounter.toString(36).toUpperCase()}`;
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: "https://docs.github.com/rest" });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function userJson(user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `U_${user.id}`,
    type: user.type,
    name: user.name,
    email: user.email,
    site_admin: false,
  };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const base = `${forgeBase(forge)}`;
  void base;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner.login}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner),
    description: repo.description,
    fork: false,
    html_url: `https://github.invalid/${repo.owner.login}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}`,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    pushed_at: iso(repo.updatedAt),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === "open" && !i.pullNumber).length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? "private" : "public",
    default_branch: repo.defaultBranch,
    archived: false,
    disabled: false,
  };
}

function forgeBase(forge: Forge): string {
  void forge;
  return "";
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.globalId,
    node_id: `I_${issue.globalId}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => ({ name, color: "ededed", default: false, description: null })),
    user: userJson(issue.user),
    comments: issue.comments.length,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: issue.state === "closed" ? iso(issue.updatedAt) : null,
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.invalid/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
    ...(issue.pullNumber ? { pull_request: { url: `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${issue.number}` } } : {}),
  };
}

export function commentJson(forge: Forge, repo: Repo, issue: Issue, comment: Issue["comments"][number]): Record<string, unknown> {
  void forge;
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.updatedAt),
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.invalid/${repo.owner.login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.headRef) ?? "";
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? "";
  return {
    id: pull.globalId,
    node_id: `PR_${pull.globalId}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user),
    labels: [],
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
    closed_at: pull.state === "closed" ? iso(pull.updatedAt) : null,
    merged_at: pull.mergedAt ? iso(pull.mergedAt) : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      label: `${pull.headOwner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(pull.user),
      repo: repoJson(forge, repo),
    },
    base: {
      label: `${repo.owner.login}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(repo.owner),
      repo: repoJson(forge, repo),
    },
    merged: pull.merged,
    mergeable: pull.state === "open" ? forge.mergeableState(repo, pull) === "MERGEABLE" : null,
    mergeable_state: pull.state === "open" ? (forge.mergeableState(repo, pull) === "MERGEABLE" ? "clean" : "dirty") : "unknown",
    comments: 0,
    review_comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.invalid/${repo.owner.login}/${repo.name}/pull/${pull.number}`,
  };
}

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const page = Math.max(1, Number.parseInt(query.get("page") ?? "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get("per_page") ?? "30", 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], page: Page): { slice: T[]; headers: Record<string, string>; base?: never } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  return { slice, headers: {} };
}

function linkHeader(req: RestRequest, page: Page, total: number): Record<string, string> {
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  if (lastPage <= 1) return {};
  const url = (p: number): string => {
    const params = new URLSearchParams(req.query);
    params.set("page", String(p));
    params.set("per_page", String(page.perPage));
    return `${req.baseUrl}/api/v3/${req.segments.join("/")}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page.page < lastPage) {
    links.push(`<${url(page.page + 1)}>; rel="next"`);
    links.push(`<${url(lastPage)}>; rel="last"`);
  }
  if (page.page > 1) {
    links.push(`<${url(page.page - 1)}>; rel="prev"`);
    links.push(`<${url(1)}>; rel="first"`);
  }
  return links.length ? { link: links.join(", ") } : {};
}

function bodyObject(req: RestRequest): Record<string, unknown> {
  return req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleRest(forge: Forge, req: RestRequest, res: ServerResponse): void {
  const seg = req.segments;
  const method = req.method;

  if (req.bodyMalformed && (method === "POST" || method === "PUT" || method === "PATCH")) {
    sendError(res, 400, "Problems parsing JSON");
    return;
  }

  // Root and meta
  if (seg.length === 0) {
    if (method !== "GET") return sendError(res, 404, "Not Found");
    const root: Record<string, string> = {
      current_user_url: `${req.baseUrl}/api/v3/user`,
      current_user_repositories_url: `${req.baseUrl}/api/v3/user/repos`,
      repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
      issue_search_url: `${req.baseUrl}/api/v3/search/issues`,
      emojis_url: `${req.baseUrl}/api/v3/emojis`,
      meta_url: `${req.baseUrl}/api/v3/meta`,
    };
    sendJson(res, 200, root);
    return;
  }
  if (seg.length === 1 && seg[0] === "meta") {
    if (method !== "GET") return sendError(res, 404, "Not Found");
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: "forge-1.0.0",
      hooks: [],
      git: [],
      api: [],
      web: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
    });
    return;
  }
  if (seg.length === 1 && seg[0] === "user" && method === "GET") {
    sendJson(res, 200, userJson(forge.viewer));
    return;
  }
  if (seg.length === 2 && seg[0] === "user" && seg[1] === "repos") {
    if (method === "GET") {
      const all = forge.listViewerRepos().map((repo) => repoJson(forge, repo));
      const page = pageOf(req.query);
      const { slice } = paginate(all, page);
      sendJson(res, 200, slice, linkHeader(req, page, all.length));
      return;
    }
    if (method === "POST") {
      const body = bodyObject(req);
      const name = typeof body.name === "string" ? body.name : "";
      if (!name) return sendError(res, 422, "Validation Failed: name is required");
      if (forge.getRepo(forge.viewer.login, name)) {
        sendJson(res, 422, {
          message: "Validation Failed",
          errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }],
        });
        return;
      }
      const repo = forge.createRepo(name, {
        description: typeof body.description === "string" ? body.description : "",
        private: typeof body.private === "boolean" ? body.private : false,
      });
      if (typeof body.default_branch === "string" && body.default_branch) repo.defaultBranch = body.default_branch;
      sendJson(res, 201, repoJson(forge, repo));
      return;
    }
    return sendError(res, 404, "Not Found");
  }

  if (seg.length >= 3 && seg[0] === "repos") {
    const owner = seg[1];
    const name = seg[2];
    const repo = forge.getOwnedRepo(owner, name);
    if (!repo) return sendError(res, 404, "Not Found");
    handleRepo(forge, repo, req, res, seg.slice(3));
    return;
  }

  sendError(res, 404, "Not Found");
}

function handleRepo(forge: Forge, repo: Repo, req: RestRequest, res: ServerResponse, seg: string[]): void {
  const method = req.method;
  const body = bodyObject(req);

  if (seg.length === 0) {
    if (method === "GET") return sendJson(res, 200, repoJson(forge, repo));
    if (method === "PATCH") {
      if (typeof body.description === "string") repo.description = body.description;
      if (typeof body.private === "boolean") repo.private = body.private;
      if (typeof body.name === "string" && body.name && body.name !== repo.name) {
        forge.repos.delete(forge.repoKey(repo.owner.login, repo.name));
        repo.name = body.name;
        forge.repos.set(forge.repoKey(repo.owner.login, repo.name), repo);
      }
      if (typeof body.default_branch === "string" && body.default_branch) repo.defaultBranch = body.default_branch;
      repo.updatedAt = Date.now();
      return sendJson(res, 200, repoJson(forge, repo));
    }
    if (method === "DELETE") {
      forge.deleteRepo(repo);
      res.writeHead(204, { "x-github-request-id": requestId() });
      res.end();
      return;
    }
    return sendError(res, 404, "Not Found");
  }

  if (seg[0] === "branches" && seg.length === 1 && method === "GET") {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith("refs/heads/"))
      .map(([ref, oid]) => ({
        name: ref.slice("refs/heads/".length),
        commit: { sha: oid, url: `/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${oid}` },
        protected: false,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return sendJson(res, 200, branches);
  }
  if (seg[0] === "branches" && seg.length === 2 && method === "GET") {
    const branch = seg[1];
    const tip = forge.branchTip(repo, branch);
    if (!tip) return sendError(res, 404, "Not Found");
    return sendJson(res, 200, {
      name: branch,
      commit: commitJson(forge, repo, tip),
      protected: false,
    });
  }

  if (seg[0] === "commits" && seg.length === 1 && method === "GET") {
    const ref = req.query.get("sha") ?? repo.defaultBranch;
    const tip = forge.resolveCommit(repo, ref);
    if (!tip) return sendJson(res, 200, []);
    const page = pageOf(req.query);
    const commits: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length && commits.length < page.page * page.perPage + page.perPage) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      commits.push(oid);
      const obj = forge.store.get(oid);
      if (obj?.type === "commit") queue.push(...parseCommit(obj.data).parents);
    }
    const { slice } = paginate(commits, page);
    return sendJson(res, 200, slice.map((oid) => commitJson(forge, repo, oid)), linkHeader(req, page, commits.length));
  }
  if (seg[0] === "commits" && seg.length === 2 && method === "GET") {
    const oid = seg[1];
    if (!forge.store.get(oid)) return sendError(res, 404, "Not Found");
    return sendJson(res, 200, commitJson(forge, repo, oid));
  }

  if (seg[0] === "git" && seg[1] === "refs") {
    if (seg.length === 2 && method === "POST") {
      const ref = typeof body.ref === "string" ? body.ref : "";
      const sha = typeof body.sha === "string" ? body.sha : "";
      if (!ref.startsWith("refs/") || !forge.store.has(sha)) return sendError(res, 422, "Validation Failed");
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.owner.login}/${repo.name}/git/refs/${ref}`, object: { sha, type: forge.store.get(sha)!.type, url: "" } });
    }
    if (seg.length >= 3 && method === "GET") {
      const ref = `refs/${seg.slice(2).join("/")}`;
      const oid = repo.refs.get(ref);
      if (!oid) return sendError(res, 404, "Not Found");
      return sendJson(res, 200, { ref, node_id: `REF_${ref}`, url: "", object: { sha: oid, type: forge.store.get(oid)?.type ?? "commit", url: "" } });
    }
    return sendError(res, 404, "Not Found");
  }

  if (seg[0] === "contents") {
    const path = seg.slice(1).join("/");
    if (!path) return sendError(res, 404, "Not Found");
    if (method === "GET") return getContents(forge, repo, req, res, path);
    if (method === "PUT") {
      const message = typeof body.message === "string" ? body.message : "Update file";
      const contentB64 = typeof body.content === "string" ? body.content : "";
      const branch = typeof body.branch === "string" ? body.branch : undefined;
      const sha = typeof body.sha === "string" ? body.sha : undefined;
      const result = forge.putContent(repo, path, Buffer.from(contentB64, "base64"), message, branch, sha);
      if ("error" in result) return sendError(res, result.status, result.error);
      const commit = forge.store.get(result.commitSha);
      const commitInfo = commit?.type === "commit" ? parseCommit(commit.data) : null;
      return sendJson(res, result.status, {
        content: {
          name: path.split("/").pop(),
          path,
          sha: result.blobSha,
          size: Buffer.from(contentB64, "base64").length,
          url: "",
          html_url: "",
          git_url: "",
          download_url: null,
          type: "file",
          encoding: "base64",
        },
        commit: {
          sha: result.commitSha,
          node_id: `C_${result.commitSha}`,
          url: "",
          html_url: "",
          author: { name: forge.viewer.name, email: forge.viewer.email, date: iso(Date.now()) },
          committer: { name: forge.viewer.name, email: forge.viewer.email, date: iso(Date.now()) },
          tree: { sha: commitInfo?.tree ?? "", url: "" },
          message,
          parents: (commitInfo?.parents ?? []).map((p) => ({ sha: p, url: "", html_url: "" })),
        },
      });
    }
    if (method === "DELETE") {
      const message = typeof body.message === "string" ? body.message : "Delete file";
      const branch = typeof body.branch === "string" ? body.branch : undefined;
      const sha = typeof body.sha === "string" ? body.sha : undefined;
      const result = forge.deleteContent(repo, path, message, branch, sha);
      if ("error" in result) return sendError(res, result.status, result.error);
      return sendJson(res, 200, {
        content: null,
        commit: { sha: result.commitSha, message },
      });
    }
    return sendError(res, 404, "Not Found");
  }

  if (seg[0] === "labels") {
    if (seg.length === 1 && method === "POST") {
      const labelName = typeof body.name === "string" ? body.name : "";
      if (!labelName) return sendError(res, 422, "Validation Failed");
      if (repo.labels.has(labelName)) return sendError(res, 422, "Validation Failed: label already exists");
      repo.labels.add(labelName);
      return sendJson(res, 201, {
        id: [...repo.labels].indexOf(labelName) + 1,
        node_id: `L_${labelName}`,
        url: "",
        name: labelName,
        color: typeof body.color === "string" ? body.color : "ededed",
        default: false,
        description: typeof body.description === "string" ? body.description : null,
      });
    }
    if (seg.length === 1 && method === "GET") {
      return sendJson(res, 200, [...repo.labels].sort().map((labelName) => ({ name: labelName, color: "ededed", default: false, description: null })));
    }
    return sendError(res, 404, "Not Found");
  }

  if (seg[0] === "issues") return handleIssues(forge, repo, req, res, seg.slice(1));
  if (seg[0] === "pulls") return handlePulls(forge, repo, req, res, seg.slice(1));

  sendError(res, 404, "Not Found");
}

function commitJson(forge: Forge, repo: Repo, oid: string): Record<string, unknown> {
  const obj = forge.store.get(oid);
  const info = obj?.type === "commit" ? parseCommit(obj.data) : { tree: "", parents: [], author: "", committer: "", message: "" };
  const person = (line: string) => {
    const match = /^(.*?) <(.*?)> (\d+) /.exec(line);
    return {
      name: match?.[1] ?? "",
      email: match?.[2] ?? "",
      date: match ? iso(Number(match[3]) * 1000) : iso(0),
    };
  };
  void repo;
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: person(info.author),
      committer: person(info.committer),
      message: info.message,
      tree: { sha: info.tree, url: "" },
      url: "",
      comment_count: 0,
    },
    url: "",
    html_url: "",
    comments_url: "",
    author: null,
    committer: null,
    parents: info.parents.map((p) => ({ sha: p, url: "", html_url: "" })),
  };
}

function getContents(forge: Forge, repo: Repo, req: RestRequest, res: ServerResponse, path: string): void {
  const ref = req.query.get("ref") ?? repo.defaultBranch;
  const commit = forge.resolveCommit(repo, ref);
  const files = forge.filesAt(commit);
  const entry = files.get(path);
  if (entry) {
    const blob = forge.store.get(entry.oid);
    const data = blob?.data ?? Buffer.alloc(0);
    return sendJson(res, 200, {
      name: path.split("/").pop(),
      path,
      sha: entry.oid,
      size: data.length,
      url: "",
      html_url: "",
      git_url: "",
      download_url: null,
      type: "file",
      encoding: "base64",
      content: data.toString("base64"),
    });
  }
  // Directory listing: entries directly under path.
  const prefix = `${path}/`;
  const dirs = new Map<string, { type: string; name: string; oid: string; mode: string }>();
  for (const [filePath, fileEntry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      dirs.set(rest, { type: "file", name: rest, oid: fileEntry.oid, mode: fileEntry.mode });
    } else {
      const dirName = rest.slice(0, slash);
      if (!dirs.has(dirName)) dirs.set(dirName, { type: "dir", name: dirName, oid: "", mode: "40000" });
    }
  }
  if (dirs.size === 0) return sendError(res, 404, "Not Found");
  const listing = [...dirs.values()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((entry) => ({
      name: entry.name,
      path: `${path}/${entry.name}`,
      sha: entry.oid,
      size: entry.type === "file" ? (forge.store.get(entry.oid)?.data.length ?? 0) : 0,
      url: "",
      html_url: "",
      git_url: "",
      download_url: null,
      type: entry.type,
    }));
  return sendJson(res, 200, listing);
}

function handleIssues(forge: Forge, repo: Repo, req: RestRequest, res: ServerResponse, seg: string[]): void {
  const method = req.method;
  const body = bodyObject(req);
  if (seg.length === 0) {
    if (method === "POST") {
      const title = typeof body.title === "string" ? body.title : "";
      if (!title) return sendError(res, 422, "Validation Failed: title is required");
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === "string") : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          return sendJson(res, 422, {
            message: "Validation Failed",
            errors: [{ resource: "Issue", code: "custom", field: "labels", message: `label "${label}" does not exist` }],
          });
        }
      }
      const issue = forge.createIssue(repo, title, typeof body.body === "string" ? body.body : "", labels);
      return sendJson(res, 201, issueJson(forge, repo, issue));
    }
    if (method === "GET") {
      const state = req.query.get("state") ?? "open";
      let issues = [...repo.issues.values()].filter((issue) => !issue.pullNumber);
      if (state === "open") issues = issues.filter((i) => i.state === "open");
      else if (state === "closed") issues = issues.filter((i) => i.state === "closed");
      const labelsParam = req.query.get("labels");
      if (labelsParam) {
        const wanted = labelsParam.split(",").map((s) => s.trim()).filter(Boolean);
        issues = issues.filter((i) => wanted.every((w) => i.labels.includes(w)));
      }
      const direction = (req.query.get("direction") ?? "desc").toLowerCase();
      issues.sort((a, b) => (direction === "asc" ? a.number - b.number : b.number - a.number));
      const page = pageOf(req.query);
      const { slice } = paginate(issues, page);
      return sendJson(res, 200, slice.map((i) => issueJson(forge, repo, i)), linkHeader(req, page, issues.length));
    }
    return sendError(res, 404, "Not Found");
  }

  const number = Number.parseInt(seg[0], 10);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (seg.length === 1) {
    if (!issue || issue.pullNumber) return sendError(res, 404, "Not Found");
    if (method === "GET") return sendJson(res, 200, issueJson(forge, repo, issue));
    if (method === "PATCH") {
      if (typeof body.title === "string") issue.title = body.title;
      if (typeof body.body === "string") issue.body = body.body;
      if (body.state === "open" || body.state === "closed") issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === "string");
        for (const label of labels) if (!repo.labels.has(label)) return sendError(res, 422, "Validation Failed");
        issue.labels = labels;
      }
      issue.updatedAt = Date.now();
      return sendJson(res, 200, issueJson(forge, repo, issue));
    }
    return sendError(res, 404, "Not Found");
  }

  if (seg.length === 2 && seg[1] === "comments") {
    if (!issue) return sendError(res, 404, "Not Found");
    if (method === "POST") {
      const text = typeof body.body === "string" ? body.body : "";
      if (!text) return sendError(res, 422, "Validation Failed: body is required");
      const comment = { id: forge.issueCommentId(), body: text, user: forge.viewer, createdAt: Date.now(), updatedAt: Date.now() };
      issue.comments.push(comment);
      return sendJson(res, 201, commentJson(forge, repo, issue, comment));
    }
    if (method === "GET") {
      const page = pageOf(req.query);
      const { slice } = paginate(issue.comments, page);
      return sendJson(res, 200, slice.map((c) => commentJson(forge, repo, issue, c)), linkHeader(req, page, issue.comments.length));
    }
    return sendError(res, 404, "Not Found");
  }

  sendError(res, 404, "Not Found");
}

function handlePulls(forge: Forge, repo: Repo, req: RestRequest, res: ServerResponse, seg: string[]): void {
  const method = req.method;
  const body = bodyObject(req);
  if (seg.length === 0) {
    if (method === "POST") {
      const title = typeof body.title === "string" ? body.title : "";
      const head = typeof body.head === "string" ? body.head : "";
      const base = typeof body.base === "string" ? body.base : repo.defaultBranch;
      if (!title || !head) return sendError(res, 422, "Validation Failed");
      const headBranch = head.includes(":") ? head.split(":").slice(1).join(":") : head;
      const headTip = forge.branchTip(repo, headBranch);
      if (!headTip) return sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: `head branch "${head}" does not exist` }] });
      const baseTip = forge.branchTip(repo, base);
      if (!baseTip) return sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: `base branch "${base}" does not exist` }] });
      const headCommit = forge.resolveCommit(repo, headBranch);
      const baseCommit = forge.resolveCommit(repo, base);
      if (headCommit && baseCommit && forge.ancestorsOf(baseCommit).has(headCommit)) {
        return sendJson(res, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between base and head" }] });
      }
      const pull = forge.createPull(repo, title, typeof body.body === "string" ? body.body : "", headBranch, base);
      return sendJson(res, 201, pullJson(forge, repo, pull));
    }
    if (method === "GET") {
      const state = req.query.get("state") ?? "open";
      let pulls = [...repo.pulls.values()];
      if (state === "open") pulls = pulls.filter((p) => p.state === "open");
      else if (state === "closed") pulls = pulls.filter((p) => p.state === "closed");
      pulls.sort((a, b) => b.number - a.number);
      const page = pageOf(req.query);
      const { slice } = paginate(pulls, page);
      return sendJson(res, 200, slice.map((p) => pullJson(forge, repo, p)), linkHeader(req, page, pulls.length));
    }
    return sendError(res, 404, "Not Found");
  }

  const number = Number.parseInt(seg[0], 10);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (seg.length === 1) {
    if (!pull) return sendError(res, 404, "Not Found");
    if (method === "GET") return sendJson(res, 200, pullJson(forge, repo, pull));
    if (method === "PATCH") {
      if (typeof body.title === "string") pull.title = body.title;
      if (typeof body.body === "string") pull.body = body.body;
      if (body.state === "open" || body.state === "closed") pull.state = body.state;
      pull.updatedAt = Date.now();
      return sendJson(res, 200, pullJson(forge, repo, pull));
    }
    return sendError(res, 404, "Not Found");
  }

  if (seg.length === 2 && seg[1] === "files" && method === "GET") {
    if (!pull) return sendError(res, 404, "Not Found");
    const files = forge.pullFiles(repo, pull).map((file) => ({
      sha: file.headOid ?? file.baseOid ?? "",
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      patch: "",
    }));
    const page = pageOf(req.query);
    const { slice } = paginate(files, page);
    return sendJson(res, 200, slice);
  }

  if (seg.length === 2 && seg[1] === "merge" && method === "PUT") {
    if (!pull) return sendError(res, 404, "Not Found");
    if (pull.state === "closed" && !pull.merged) return sendError(res, 405, "Pull Request is not mergeable");
    if (pull.merged) return sendJson(res, 200, { sha: pull.mergeCommitSha ?? "", merged: true, message: "Pull Request successfully merged" });
    const methodName = typeof body.merge_method === "string" ? body.merge_method : "merge";
    const result = forge.mergePull(repo, pull, methodName);
    if (result === "conflict") return sendError(res, 405, "Pull Request is not mergeable");
    return sendJson(res, 200, { sha: result, merged: true, message: "Pull Request successfully merged" });
  }

  sendError(res, 404, "Not Found");
}
