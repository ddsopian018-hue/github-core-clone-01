// A small GraphQL engine for the documents gh and github-mcp-server send:
// queries, mutations, variables, inline enums/input objects, fragments,
// Relay node(id:), connection pagination, batching (a JSON array body), and
// __type introspection. No external GraphQL library — the stdlib only.

import { Forge, type Issue, type PullRequest, type Repo } from "./forge.ts";

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: "name"; value: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "eof" };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === "﻿") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (source.startsWith("...", i)) {
      tokens.push({ kind: "punct", value: "..." });
      i += 3;
      continue;
    }
    if ("{}()[]:=@$!&|".includes(c)) {
      tokens.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error("unterminated block string");
        tokens.push({ kind: "string", value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = "";
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\") {
          const esc = source[j + 1];
          const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          if (esc === "u") {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j++;
        }
      }
      if (j >= source.length) throw new Error("unterminated string");
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === "-") j++;
      while (j < source.length && /[0-9]/.test(source[j])) j++;
      let isFloat = false;
      if (source[j] === ".") {
        isFloat = true;
        j++;
        while (j < source.length && /[0-9]/.test(source[j])) j++;
      }
      if (source[j] === "e" || source[j] === "E") {
        isFloat = true;
        j++;
        if (source[j] === "+" || source[j] === "-") j++;
        while (j < source.length && /[0-9]/.test(source[j])) j++;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: "float", value: Number(text) } : { kind: "int", value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j++;
      tokens.push({ kind: "name", value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: "variable"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: ValueNode[] }
  | { kind: "object"; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: "field";
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: "fragmentSpread"; name: string }
  | { kind: "inlineFragment"; typeCondition?: string; selectionSet: SelectionNode[] };

interface OperationNode {
  operation: "query" | "mutation";
  name?: string;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition?: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== "punct" || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === "punct" && token.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== "name") throw new Error("expected a name");
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition?: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== "eof") {
      const token = this.peek();
      if (token.kind === "punct" && token.value === "{") {
        operations.push({ operation: "query", variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== "name") throw new Error("expected a definition");
      if (token.value === "query" || token.value === "mutation" || token.value === "subscription") {
        this.next();
        const operation = token.value === "mutation" ? "mutation" : "query";
        let name: string | undefined;
        if (this.peek().kind === "name") name = this.expectName();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.skipPunct("(")) {
          while (!this.skipPunct(")")) {
            this.expectPunct("$");
            const varName = this.expectName();
            this.expectPunct(":");
            this.parseType();
            if (this.skipPunct("=")) variableDefaults.set(varName, this.parseValue());
            this.skipDirectives();
          }
        }
        this.skipDirectives();
        operations.push({ operation, name, variableDefaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === "fragment") {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== "on") throw new Error("expected 'on' in fragment definition");
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      // Schema/type definitions are not expected in client documents; skip a
      // definition's name and braces defensively.
      this.next();
      if (this.peek().kind === "name") this.next();
      if (this.peek().kind === "punct" && this.peek().value === "{") this.parseSelectionSet();
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skipPunct("[")) {
      this.parseType();
      this.expectPunct("]");
    } else {
      this.expectName();
    }
    this.skipPunct("!");
  }

  private skipDirectives(): void {
    while (this.skipPunct("@")) {
      this.expectName();
      if (this.skipPunct("(")) {
        while (!this.skipPunct(")")) {
          this.expectName();
          this.expectPunct(":");
          this.parseValue();
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct("{");
    const selections: SelectionNode[] = [];
    while (!this.skipPunct("}")) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === "punct" && token.value === "...") {
      this.next();
      const next = this.peek();
      if (next.kind === "name" && next.value === "on") {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: "inlineFragment", typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: "fragmentSpread", name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(":")) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.skipPunct("(")) {
      while (!this.skipPunct(")")) {
        const argName = this.expectName();
        this.expectPunct(":");
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === "punct" && (this.peek() as { value: string }).value === "{") {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: "field", alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case "int":
        return { kind: "int", value: token.value };
      case "float":
        return { kind: "float", value: token.value };
      case "string":
        return { kind: "string", value: token.value };
      case "name":
        if (token.value === "true") return { kind: "boolean", value: true };
        if (token.value === "false") return { kind: "boolean", value: false };
        if (token.value === "null") return { kind: "null" };
        return { kind: "enum", value: token.value };
      case "punct":
        if (token.value === "$") return { kind: "variable", name: this.expectName() };
        if (token.value === "[") {
          const values: ValueNode[] = [];
          while (!this.skipPunct("]")) values.push(this.parseValue());
          return { kind: "list", values };
        }
        if (token.value === "{") {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!this.skipPunct("}")) {
            const fieldName = this.expectName();
            this.expectPunct(":");
            fields.push({ name: fieldName, value: this.parseValue() });
          }
          return { kind: "object", fields };
        }
        break;
    }
    throw new Error("unexpected value token");
  }
}

function valueFromNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case "variable":
      return variables[node.name];
    case "int":
    case "float":
    case "string":
    case "boolean":
      return node.value;
    case "null":
      return null;
    case "enum":
      return node.value;
    case "list":
      return node.values.map((v) => valueFromNode(v, variables));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface Tagged {
  $type: string;
  [key: string]: unknown;
}

function tag(type: string, props: Record<string, unknown>): Tagged {
  return { $type: type, ...props };
}

interface FieldDef {
  type: string;
  resolve: (forge: Forge, source: Tagged, args: Record<string, unknown>) => unknown;
}

interface TypeDef {
  kind: "OBJECT" | "ENUM" | "INPUT_OBJECT" | "SCALAR" | "INTERFACE";
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  inputFields?: Record<string, string>;
  possibleTypes?: string[];
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

function repoTag(repo: Repo): Tagged {
  return tag("Repository", { repo });
}
function issueTag(repo: Repo, issue: Issue): Tagged {
  return tag("Issue", { repo, issue });
}
function pullTag(repo: Repo, pull: PullRequest): Tagged {
  return tag("PullRequest", { repo, pull });
}

function paginateConnection(items: Tagged[], args: Record<string, unknown>, typeName = "Connection"): Tagged {
  const first = typeof args.first === "number" ? args.first : items.length;
  const after = typeof args.after === "string" ? args.after : null;
  let startIndex = 0;
  if (after) {
    const decoded = Number.parseInt(after, 10);
    if (Number.isInteger(decoded)) startIndex = decoded + 1;
  }
  const slice = items.slice(startIndex, startIndex + first);
  const hasNext = startIndex + slice.length < items.length;
  return tag(typeName, {
    nodes: slice,
    edges: slice.map((node, i) => tag("Edge", { node, cursor: String(startIndex + i) })),
    pageInfo: tag("PageInfo", {
      hasNextPage: hasNext,
      hasPreviousPage: startIndex > 0,
      startCursor: slice.length ? String(startIndex) : null,
      endCursor: slice.length ? String(startIndex + slice.length - 1) : null,
    }),
    totalCount: items.length,
  });
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: "OBJECT",
    fields: {
      viewer: { type: "User", resolve: (forge) => tag("User", { user: forge.viewer }) },
      repository: {
        type: "Repository",
        resolve: (forge, _s, args) => {
          const repo = forge.getOwnedRepo(String(args.owner ?? ""), String(args.name ?? ""));
          return repo ? repoTag(repo) : null;
        },
      },
      node: {
        type: "Node",
        resolve: (forge, _s, args) => resolveNode(forge, String(args.id ?? "")),
      },
      __type: {
        type: "__Type",
        resolve: (_forge, _s, args) => {
          const name = String(args.name ?? "");
          return SCHEMA[name] ? tag("__Type", { typeName: name }) : null;
        },
      },
      __schema: { type: "__Schema", resolve: () => tag("__Schema", {}) },
      rateLimit: { type: "RateLimit", resolve: () => tag("RateLimit", {}) },
    },
  },
  Mutation: {
    kind: "OBJECT",
    fields: {
      createIssue: {
        type: "CreateIssuePayload",
        resolve: (forge, _s, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoByGlobalId(forge, String(input.repositoryId ?? ""));
          if (!repo) throw new Error("Repository not found");
          const issue = forge.createIssue(repo, String(input.title ?? ""), typeof input.body === "string" ? input.body : "");
          return tag("CreateIssuePayload", { repo, issue, clientMutationId: input.clientMutationId ?? null });
        },
      },
      closeIssue: {
        type: "CloseIssuePayload",
        resolve: (forge, _s, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = findIssueByGlobalId(forge, String(input.issueId ?? ""));
          if (!found) throw new Error("Issue not found");
          found.issue.state = "closed";
          found.issue.updatedAt = Date.now();
          return tag("CloseIssuePayload", { repo: found.repo, issue: found.issue, clientMutationId: input.clientMutationId ?? null });
        },
      },
      createPullRequest: {
        type: "CreatePullRequestPayload",
        resolve: (forge, _s, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoByGlobalId(forge, String(input.repositoryId ?? ""));
          if (!repo) throw new Error("Repository not found");
          const head = String(input.headRefName ?? "");
          const base = String(input.baseRefName ?? repo.defaultBranch);
          if (!forge.branchTip(repo, head)) throw new Error(`Head branch "${head}" does not exist`);
          if (!forge.branchTip(repo, base)) throw new Error(`Base branch "${base}" does not exist`);
          const pull = forge.createPull(repo, String(input.title ?? ""), typeof input.body === "string" ? input.body : "", head, base);
          return tag("CreatePullRequestPayload", { repo, pull, clientMutationId: input.clientMutationId ?? null });
        },
      },
      mergePullRequest: {
        type: "MergePullRequestPayload",
        resolve: (forge, _s, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = findPullByGlobalId(forge, String(input.pullRequestId ?? ""));
          if (!found) throw new Error("Pull request not found");
          if (!found.pull.merged) {
            const method = typeof input.mergeMethod === "string" ? input.mergeMethod.toLowerCase() : "merge";
            const result = forge.mergePull(found.repo, found.pull, method);
            if (result === "conflict") throw new Error("Pull Request is not mergeable");
          }
          return tag("MergePullRequestPayload", { repo: found.repo, pull: found.pull, clientMutationId: input.clientMutationId ?? null });
        },
      },
      addComment: {
        type: "AddCommentPayload",
        resolve: (forge, _s, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = findIssueByGlobalId(forge, String(input.subjectId ?? ""));
          if (!found) throw new Error("Subject not found");
          const comment = {
            id: forge.issueCommentId(),
            body: String(input.body ?? ""),
            user: forge.viewer,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          found.issue.comments.push(comment);
          const node = tag("IssueComment", { repo: found.repo, issue: found.issue, comment });
          return tag("AddCommentPayload", {
            commentEdge: tag("Edge", { node, cursor: String(comment.id) }),
            clientMutationId: input.clientMutationId ?? null,
          });
        },
      },
    },
  },
  User: {
    kind: "OBJECT",
    fields: {
      login: { type: "String", resolve: (_f, s) => (s.user as { login: string }).login },
      id: { type: "ID", resolve: (_f, s) => `U_${(s.user as { id: number }).id}` },
      databaseId: { type: "Int", resolve: (_f, s) => (s.user as { id: number }).id },
      name: { type: "String", resolve: (_f, s) => (s.user as { name: string }).name },
      email: { type: "String", resolve: (_f, s) => (s.user as { email: string }).email },
      url: { type: "URI", resolve: (_f, s) => `https://github.invalid/${(s.user as { login: string }).login}` },
      isViewer: { type: "Boolean", resolve: () => true },
    },
  },
  Repository: {
    kind: "OBJECT",
    fields: {
      id: { type: "ID", resolve: (_f, s) => `R_${(s.repo as Repo).id}` },
      databaseId: { type: "Int", resolve: (_f, s) => (s.repo as Repo).id },
      name: { type: "String", resolve: (_f, s) => (s.repo as Repo).name },
      nameWithOwner: { type: "String", resolve: (_f, s) => `${(s.repo as Repo).owner.login}/${(s.repo as Repo).name}` },
      owner: { type: "User", resolve: (_f, s) => tag("User", { user: (s.repo as Repo).owner }) },
      description: { type: "String", resolve: (_f, s) => (s.repo as Repo).description },
      isPrivate: { type: "Boolean", resolve: (_f, s) => (s.repo as Repo).private },
      viewerPermission: { type: "RepositoryPermission", resolve: () => "ADMIN" },
      hasIssuesEnabled: { type: "Boolean", resolve: () => true },
      hasWikiEnabled: { type: "Boolean", resolve: () => true },
      isArchived: { type: "Boolean", resolve: () => false },
      isFork: { type: "Boolean", resolve: () => false },
      stargazerCount: { type: "Int", resolve: () => 0 },
      forkCount: { type: "Int", resolve: () => 0 },
      createdAt: { type: "DateTime", resolve: (_f, s) => isoOf((s.repo as Repo).createdAt) },
      updatedAt: { type: "DateTime", resolve: (_f, s) => isoOf((s.repo as Repo).updatedAt) },
      url: { type: "URI", resolve: (_f, s) => `https://github.invalid/${(s.repo as Repo).owner.login}/${(s.repo as Repo).name}` },
      defaultBranchRef: {
        type: "Ref",
        resolve: (forge, s) => {
          const repo = s.repo as Repo;
          const tip = forge.branchTip(repo, repo.defaultBranch);
          if (!tip) return null;
          return tag("Ref", { name: repo.defaultBranch, target: tag("Commit", { repo, oid: tip }) });
        },
      },
      issue: {
        type: "Issue",
        resolve: (_f, s, args) => {
          const repo = s.repo as Repo;
          const issue = repo.issues.get(Number(args.number));
          return issue && !issue.pullNumber ? issueTag(repo, issue) : null;
        },
      },
      issues: {
        type: "IssueConnection",
        resolve: (_f, s, args) => {
          const repo = s.repo as Repo;
          let issues = [...repo.issues.values()].filter((i) => !i.pullNumber);
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length) {
            const wanted = states.map((x) => String(x).toLowerCase());
            issues = issues.filter((i) => wanted.includes(i.state));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const direction = typeof orderBy.direction === "string" ? orderBy.direction : "DESC";
          issues.sort((a, b) => (direction === "ASC" ? a.number - b.number : b.number - a.number));
          return paginateConnection(issues.map((i) => issueTag(repo, i)), args, "IssueConnection");
        },
      },
      pullRequest: {
        type: "PullRequest",
        resolve: (_f, s, args) => {
          const repo = s.repo as Repo;
          const pull = repo.pulls.get(Number(args.number));
          return pull ? pullTag(repo, pull) : null;
        },
      },
      pullRequests: {
        type: "PullRequestConnection",
        resolve: (_f, s, args) => {
          const repo = s.repo as Repo;
          let pulls = [...repo.pulls.values()];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length) {
            const wanted = states.map((x) => String(x).toUpperCase());
            pulls = pulls.filter((p) => wanted.includes(p.merged ? "MERGED" : p.state.toUpperCase()));
          }
          pulls.sort((a, b) => b.number - a.number);
          return paginateConnection(pulls.map((p) => pullTag(repo, p)), args, "PullRequestConnection");
        },
      },
    },
  },
  Ref: {
    kind: "OBJECT",
    fields: {
      name: { type: "String", resolve: (_f, s) => s.name },
      prefix: { type: "String", resolve: () => "refs/heads/" },
      target: { type: "GitObject", resolve: (_f, s) => s.target ?? null },
    },
  },
  Commit: {
    kind: "OBJECT",
    fields: {
      id: { type: "ID", resolve: (_f, s) => `C_${s.oid}` },
      oid: { type: "GitObjectID", resolve: (_f, s) => s.oid },
      message: { type: "String", resolve: () => "" },
      url: { type: "URI", resolve: () => "" },
    },
  },
  Issue: {
    kind: "OBJECT",
    fields: {
      id: { type: "ID", resolve: (_f, s) => `I_${(s.issue as Issue).globalId}` },
      databaseId: { type: "Int", resolve: (_f, s) => (s.issue as Issue).globalId },
      number: { type: "Int", resolve: (_f, s) => (s.issue as Issue).number },
      title: { type: "String", resolve: (_f, s) => (s.issue as Issue).title },
      body: { type: "String", resolve: (_f, s) => (s.issue as Issue).body },
      state: { type: "IssueState", resolve: (_f, s) => (s.issue as Issue).state.toUpperCase() },
      author: { type: "User", resolve: (_f, s) => tag("User", { user: (s.issue as Issue).user }) },
      repository: { type: "Repository", resolve: (_f, s) => repoTag(s.repo as Repo) },
      labels: {
        type: "LabelConnection",
        resolve: (_f, s, args) =>
          paginateConnection(((s.issue as Issue).labels ?? []).map((name) => tag("Label", { name })), args, "LabelConnection"),
      },
      comments: {
        type: "IssueCommentConnection",
        resolve: (_f, s, args) =>
          paginateConnection(
            (s.issue as Issue).comments.map((comment) => tag("IssueComment", { repo: s.repo as Repo, issue: s.issue as Issue, comment })),
            args,
            "IssueCommentConnection",
          ),
      },
      createdAt: { type: "DateTime", resolve: (_f, s) => isoOf((s.issue as Issue).createdAt) },
      updatedAt: { type: "DateTime", resolve: (_f, s) => isoOf((s.issue as Issue).updatedAt) },
      closedAt: { type: "DateTime", resolve: (_f, s) => ((s.issue as Issue).state === "closed" ? isoOf((s.issue as Issue).updatedAt) : null) },
      url: { type: "URI", resolve: (_f, s) => `https://github.invalid/${(s.repo as Repo).owner.login}/${(s.repo as Repo).name}/issues/${(s.issue as Issue).number}` },
    },
  },
  PullRequest: {
    kind: "OBJECT",
    fields: {
      id: { type: "ID", resolve: (_f, s) => `PR_${(s.pull as PullRequest).globalId}` },
      databaseId: { type: "Int", resolve: (_f, s) => (s.pull as PullRequest).globalId },
      number: { type: "Int", resolve: (_f, s) => (s.pull as PullRequest).number },
      title: { type: "String", resolve: (_f, s) => (s.pull as PullRequest).title },
      body: { type: "String", resolve: (_f, s) => (s.pull as PullRequest).body },
      state: {
        type: "PullRequestState",
        resolve: (_f, s) => {
          const pull = s.pull as PullRequest;
          return pull.merged ? "MERGED" : pull.state.toUpperCase();
        },
      },
      merged: { type: "Boolean", resolve: (_f, s) => (s.pull as PullRequest).merged },
      mergedAt: { type: "DateTime", resolve: (_f, s) => ((s.pull as PullRequest).mergedAt ? isoOf((s.pull as PullRequest).mergedAt as number) : null) },
      mergeable: {
        type: "MergeableState",
        resolve: (forge, s) => {
          const pull = s.pull as PullRequest;
          if (pull.state === "closed") return "UNKNOWN";
          return forge.mergeableState(s.repo as Repo, pull);
        },
      },
      headRefName: { type: "String", resolve: (_f, s) => (s.pull as PullRequest).headRef },
      baseRefName: { type: "String", resolve: (_f, s) => (s.pull as PullRequest).baseRef },
      headRefOid: { type: "GitObjectID", resolve: (forge, s) => forge.branchTip(s.repo as Repo, (s.pull as PullRequest).headRef) ?? "" },
      baseRefOid: { type: "GitObjectID", resolve: (forge, s) => forge.branchTip(s.repo as Repo, (s.pull as PullRequest).baseRef) ?? "" },
      author: { type: "User", resolve: (_f, s) => tag("User", { user: (s.pull as PullRequest).user }) },
      repository: { type: "Repository", resolve: (_f, s) => repoTag(s.repo as Repo) },
      mergeCommit: {
        type: "Commit",
        resolve: (_f, s) => {
          const pull = s.pull as PullRequest;
          return pull.mergeCommitSha ? tag("Commit", { repo: s.repo as Repo, oid: pull.mergeCommitSha }) : null;
        },
      },
      files: {
        type: "PullRequestChangedFileConnection",
        resolve: (forge, s, args) => {
          const repo = s.repo as Repo;
          const pull = s.pull as PullRequest;
          const files = forge.pullFiles(repo, pull).map((file) =>
            tag("PullRequestChangedFile", { path: file.path, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }),
          );
          return paginateConnection(files, args, "PullRequestChangedFileConnection");
        },
      },
      createdAt: { type: "DateTime", resolve: (_f, s) => isoOf((s.pull as PullRequest).createdAt) },
      updatedAt: { type: "DateTime", resolve: (_f, s) => isoOf((s.pull as PullRequest).updatedAt) },
      url: { type: "URI", resolve: (_f, s) => `https://github.invalid/${(s.repo as Repo).owner.login}/${(s.repo as Repo).name}/pull/${(s.pull as PullRequest).number}` },
    },
  },
  PullRequestChangedFile: {
    kind: "OBJECT",
    fields: {
      path: { type: "String", resolve: (_f, s) => s.path },
      additions: { type: "Int", resolve: (_f, s) => s.additions },
      deletions: { type: "Int", resolve: (_f, s) => s.deletions },
      changeType: { type: "PatchStatus", resolve: (_f, s) => s.changeType },
    },
  },
  IssueComment: {
    kind: "OBJECT",
    fields: {
      id: { type: "ID", resolve: (_f, s) => `C_${(s.comment as { id: number }).id}` },
      databaseId: { type: "Int", resolve: (_f, s) => (s.comment as { id: number }).id },
      body: { type: "String", resolve: (_f, s) => (s.comment as { body: string }).body },
      author: { type: "User", resolve: (_f, s) => tag("User", { user: (s.comment as { user: unknown }).user }) },
      createdAt: { type: "DateTime", resolve: (_f, s) => isoOf((s.comment as { createdAt: number }).createdAt) },
      url: { type: "URI", resolve: () => "" },
    },
  },
  Label: {
    kind: "OBJECT",
    fields: {
      id: { type: "ID", resolve: (_f, s) => `L_${String(s.name)}` },
      name: { type: "String", resolve: (_f, s) => s.name },
      color: { type: "String", resolve: () => "ededed" },
    },
  },
  PageInfo: {
    kind: "OBJECT",
    fields: {
      hasNextPage: { type: "Boolean", resolve: (_f, s) => (s as unknown as Record<string, unknown>).hasNextPage },
      hasPreviousPage: { type: "Boolean", resolve: (_f, s) => (s as unknown as Record<string, unknown>).hasPreviousPage },
      startCursor: { type: "String", resolve: (_f, s) => (s as unknown as Record<string, unknown>).startCursor },
      endCursor: { type: "String", resolve: (_f, s) => (s as unknown as Record<string, unknown>).endCursor },
    },
  },
  RateLimit: {
    kind: "OBJECT",
    fields: {
      limit: { type: "Int", resolve: () => 5000 },
      cost: { type: "Int", resolve: () => 1 },
      remaining: { type: "Int", resolve: () => 5000 },
      resetAt: { type: "DateTime", resolve: () => isoOf(Date.now() + 3600_000) },
      nodeCount: { type: "Int", resolve: () => 0 },
      used: { type: "Int", resolve: () => 0 },
    },
  },
  // Payload types
  CreateIssuePayload: {
    kind: "OBJECT",
    fields: {
      issue: { type: "Issue", resolve: (_f, s) => issueTag(s.repo as Repo, s.issue as Issue) },
      clientMutationId: { type: "String", resolve: (_f, s) => s.clientMutationId },
    },
  },
  CloseIssuePayload: {
    kind: "OBJECT",
    fields: {
      issue: { type: "Issue", resolve: (_f, s) => issueTag(s.repo as Repo, s.issue as Issue) },
      clientMutationId: { type: "String", resolve: (_f, s) => s.clientMutationId },
    },
  },
  CreatePullRequestPayload: {
    kind: "OBJECT",
    fields: {
      pullRequest: { type: "PullRequest", resolve: (_f, s) => pullTag(s.repo as Repo, s.pull as PullRequest) },
      clientMutationId: { type: "String", resolve: (_f, s) => s.clientMutationId },
    },
  },
  MergePullRequestPayload: {
    kind: "OBJECT",
    fields: {
      pullRequest: { type: "PullRequest", resolve: (_f, s) => pullTag(s.repo as Repo, s.pull as PullRequest) },
      clientMutationId: { type: "String", resolve: (_f, s) => s.clientMutationId },
    },
  },
  AddCommentPayload: {
    kind: "OBJECT",
    fields: {
      commentEdge: { type: "IssueCommentEdge", resolve: (_f, s) => s.commentEdge },
      subject: { type: "Node", resolve: () => null },
      clientMutationId: { type: "String", resolve: (_f, s) => s.clientMutationId },
    },
  },
  // Introspection types
  __Schema: {
    kind: "OBJECT",
    fields: {
      types: { type: "[__Type]", resolve: () => Object.keys(SCHEMA).map((name) => tag("__Type", { typeName: name })) },
      queryType: { type: "__Type", resolve: () => tag("__Type", { typeName: "Query" }) },
      mutationType: { type: "__Type", resolve: () => tag("__Type", { typeName: "Mutation" }) },
      subscriptionType: { type: "__Type", resolve: () => null },
      directives: { type: "[__Directive]", resolve: () => [] },
    },
  },
  __Type: {
    kind: "OBJECT",
    fields: {
      name: { type: "String", resolve: (_f, s) => s.typeName },
      kind: { type: "__TypeKind", resolve: (_f, s) => SCHEMA[String(s.typeName)]?.kind ?? "SCALAR" },
      description: { type: "String", resolve: () => null },
      fields: {
        type: "[__Field]",
        resolve: (_f, s) => {
          const def = SCHEMA[String(s.typeName)];
          if (!def?.fields) return null;
          return Object.entries(def.fields).map(([name, field]) => tag("__Field", { name, typeName: field.type }));
        },
      },
      enumValues: {
        type: "[__EnumValue]",
        resolve: (_f, s) => {
          const def = SCHEMA[String(s.typeName)];
          if (!def?.enumValues) return null;
          return def.enumValues.map((name) => tag("__EnumValue", { name }));
        },
      },
      inputFields: {
        type: "[__InputValue]",
        resolve: (_f, s) => {
          const def = SCHEMA[String(s.typeName)];
          if (!def?.inputFields) return null;
          return Object.entries(def.inputFields).map(([name, type]) => tag("__InputValue", { name, typeName: type }));
        },
      },
      possibleTypes: {
        type: "[__Type]",
        resolve: (_f, s) => {
          const def = SCHEMA[String(s.typeName)];
          if (!def?.possibleTypes) return null;
          return def.possibleTypes.map((name) => tag("__Type", { typeName: name }));
        },
      },
      ofType: { type: "__Type", resolve: () => null },
      specifiedByURL: { type: "String", resolve: () => null },
    },
  },
  __Field: {
    kind: "OBJECT",
    fields: {
      name: { type: "String", resolve: (_f, s) => s.name },
      description: { type: "String", resolve: () => null },
      args: { type: "[__InputValue]", resolve: () => [] },
      type: { type: "__Type", resolve: (_f, s) => tag("__Type", { typeName: String(s.typeName).replace(/[[\]!]/g, "") }) },
      isDeprecated: { type: "Boolean", resolve: () => false },
      deprecationReason: { type: "String", resolve: () => null },
    },
  },
  __EnumValue: {
    kind: "OBJECT",
    fields: {
      name: { type: "String", resolve: (_f, s) => s.name },
      description: { type: "String", resolve: () => null },
      isDeprecated: { type: "Boolean", resolve: () => false },
      deprecationReason: { type: "String", resolve: () => null },
    },
  },
  __InputValue: {
    kind: "OBJECT",
    fields: {
      name: { type: "String", resolve: (_f, s) => s.name },
      description: { type: "String", resolve: () => null },
      type: { type: "__Type", resolve: (_f, s) => tag("__Type", { typeName: String(s.typeName ?? "String").replace(/[[\]!]/g, "") }) },
      defaultValue: { type: "String", resolve: () => null },
    },
  },
  // Enums
  IssueState: { kind: "ENUM", enumValues: ["OPEN", "CLOSED"] },
  PullRequestState: { kind: "ENUM", enumValues: ["OPEN", "CLOSED", "MERGED"] },
  MergeableState: { kind: "ENUM", enumValues: ["MERGEABLE", "CONFLICTING", "UNKNOWN"] },
  OrderDirection: { kind: "ENUM", enumValues: ["ASC", "DESC"] },
  IssueOrderField: { kind: "ENUM", enumValues: ["CREATED_AT", "UPDATED_AT", "COMMENTS"] },
  RepositoryPermission: { kind: "ENUM", enumValues: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"] },
  SearchType: { kind: "ENUM", enumValues: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION"] },
  PullRequestMergeMethod: { kind: "ENUM", enumValues: ["MERGE", "SQUASH", "REBASE"] },
  PatchStatus: { kind: "ENUM", enumValues: ["ADDED", "CHANGED", "COPIED", "DELETED", "MODIFIED", "RENAMED"] },
  __TypeKind: { kind: "ENUM", enumValues: ["SCALAR", "OBJECT", "INTERFACE", "UNION", "ENUM", "INPUT_OBJECT", "LIST", "NON_NULL"] },
  // Scalars and inputs (introspection completeness)
  String: { kind: "SCALAR" },
  Int: { kind: "SCALAR" },
  Float: { kind: "SCALAR" },
  Boolean: { kind: "SCALAR" },
  ID: { kind: "SCALAR" },
  DateTime: { kind: "SCALAR" },
  URI: { kind: "SCALAR" },
  GitObjectID: { kind: "SCALAR" },
  CreateIssueInput: { kind: "INPUT_OBJECT", inputFields: { repositoryId: "ID", title: "String", body: "String", clientMutationId: "String" } },
  CloseIssueInput: { kind: "INPUT_OBJECT", inputFields: { issueId: "ID", clientMutationId: "String" } },
  CreatePullRequestInput: { kind: "INPUT_OBJECT", inputFields: { repositoryId: "ID", baseRefName: "String", headRefName: "String", title: "String", body: "String", clientMutationId: "String" } },
  MergePullRequestInput: { kind: "INPUT_OBJECT", inputFields: { pullRequestId: "ID", mergeMethod: "PullRequestMergeMethod", clientMutationId: "String" } },
  AddCommentInput: { kind: "INPUT_OBJECT", inputFields: { subjectId: "ID", body: "String", clientMutationId: "String" } },
  IssueOrder: { kind: "INPUT_OBJECT", inputFields: { field: "IssueOrderField", direction: "OrderDirection" } },
  Node: { kind: "INTERFACE", possibleTypes: ["Repository", "Issue", "PullRequest", "User", "IssueComment"] },
};

// Connection pseudo-types share the Connection tag shape; register them so
// field-type lookups and introspection resolve.
for (const name of ["IssueConnection", "PullRequestConnection", "PullRequestChangedFileConnection", "LabelConnection", "IssueCommentConnection"]) {
  SCHEMA[name] = {
    kind: "OBJECT",
    fields: {
      nodes: { type: "[Node]", resolve: (_f, s) => (s as unknown as Record<string, unknown>).nodes },
      edges: { type: "[Edge]", resolve: (_f, s) => (s as unknown as Record<string, unknown>).edges },
      pageInfo: { type: "PageInfo", resolve: (_f, s) => (s as unknown as Record<string, unknown>).pageInfo },
      totalCount: { type: "Int", resolve: (_f, s) => (s as unknown as Record<string, unknown>).totalCount },
    },
  };
}
SCHEMA["Edge"] = {
  kind: "OBJECT",
  fields: {
    node: { type: "Node", resolve: (_f, s) => (s as unknown as Record<string, unknown>).node },
    cursor: { type: "String", resolve: (_f, s) => (s as unknown as Record<string, unknown>).cursor },
  },
};
SCHEMA["IssueCommentEdge"] = SCHEMA["Edge"];

function repoByGlobalId(forge: Forge, id: string): Repo | null {
  const match = /^R_(\d+)$/.exec(id);
  if (match) {
    const wanted = Number(match[1]);
    for (const repo of forge.repos.values()) if (repo.id === wanted) return repo;
    return null;
  }
  // Some clients pass the REST URL or owner/name; accept "owner/name" too.
  if (id.includes("/")) {
    const [owner, name] = id.split("/");
    return forge.getOwnedRepo(owner, name) ?? null;
  }
  return null;
}

function findIssueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const match = /^I_(\d+)$/.exec(id);
  if (!match) return null;
  const wanted = Number(match[1]);
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.globalId === wanted && !issue.pullNumber) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: PullRequest } | null {
  const match = /^PR_(\d+)$/.exec(id);
  if (!match) return null;
  const wanted = Number(match[1]);
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.globalId === wanted) return { repo, pull };
  }
  return null;
}

function resolveNode(forge: Forge, id: string): Tagged | null {
  if (id.startsWith("R_")) {
    const repo = repoByGlobalId(forge, id);
    return repo ? repoTag(repo) : null;
  }
  if (id.startsWith("I_")) {
    const found = findIssueByGlobalId(forge, id);
    return found ? issueTag(found.repo, found.issue) : null;
  }
  if (id.startsWith("PR_")) {
    const found = findPullByGlobalId(forge, id);
    return found ? pullTag(found.repo, found.pull) : null;
  }
  if (id.startsWith("U_")) return tag("User", { user: forge.viewer });
  return null;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: DocumentNode["fragments"];
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function executeSelectionSet(ctx: ExecContext, typeName: string, source: Tagged, selections: SelectionNode[], path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === "fragmentSpread") {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}"`, path });
        continue;
      }
      if (fragment.typeCondition && !typeMatches(source.$type, fragment.typeCondition)) continue;
      Object.assign(out, executeSelectionSet(ctx, fragment.typeCondition ?? typeName, source, fragment.selectionSet, path));
      continue;
    }
    if (selection.kind === "inlineFragment") {
      if (selection.typeCondition && !typeMatches(source.$type, selection.typeCondition)) continue;
      Object.assign(out, executeSelectionSet(ctx, selection.typeCondition ?? typeName, source, selection.selectionSet, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === "__typename") {
      out[key] = source.$type;
      continue;
    }
    const fieldDef = typeDef?.fields?.[selection.name];
    if (!fieldDef) {
      ctx.errors.push({
        message: `Field '${selection.name}' doesn't exist on type '${typeName}'`,
        path: [...path, key],
      });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = valueFromNode(arg.value, ctx.variables);
    let raw: unknown;
    try {
      raw = fieldDef.resolve(ctx.forge, source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, fieldDef.type, raw, selection, [...path, key]);
  }
  return out;
}

function typeMatches(actual: string, condition: string): boolean {
  if (actual === condition) return true;
  const def = SCHEMA[condition];
  if (def?.kind === "INTERFACE" && def.possibleTypes?.includes(actual)) return true;
  return false;
}

function completeValue(ctx: ExecContext, typeName: string, raw: unknown, selection: FieldNode, path: Array<string | number>): unknown {
  if (raw === null || raw === undefined) return null;
  const bare = typeName.replace(/[[\]!]/g, "");
  if (Array.isArray(raw)) {
    return raw.map((item, index) => completeValue(ctx, bare, item, selection, [...path, index]));
  }
  if (typeof raw === "object" && raw !== null && "$type" in (raw as Record<string, unknown>)) {
    const tagged = raw as Tagged;
    if (!selection.selectionSet) return null;
    return executeSelectionSet(ctx, tagged.$type, tagged, selection.selectionSet, path);
  }
  return raw;
}

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export function executeGraphQL(forge: Forge, request: GraphQLRequest): { data: Record<string, unknown> | null; errors?: Array<{ message: string; path?: Array<string | number> }> } {
  let document: DocumentNode;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = request.operationName
    ? document.operations.find((op) => op.name === request.operationName) ?? document.operations[0]
    : document.operations[0];
  if (!operation) return { data: null, errors: [{ message: "No operation in document" }] };
  const variables: Record<string, unknown> = { ...(request.variables ?? {}) };
  for (const [name, defaultNode] of operation.variableDefaults) {
    if (variables[name] === undefined) variables[name] = valueFromNode(defaultNode, variables);
  }
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === "mutation" ? "Mutation" : "Query";
  const root = tag(rootType, {});
  const data = executeSelectionSet(ctx, rootType, root, operation.selectionSet, []);
  const result: { data: Record<string, unknown> | null; errors?: Array<{ message: string; path?: Array<string | number> }> } = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
