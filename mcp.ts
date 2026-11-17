// MCP over Streamable HTTP: JSON-RPC 2.0 at POST /mcp. Speaks the modern
// 2026-07-28 revision (server/discover, no handshake) and the legacy
// initialize handshake. Tools act on the same store as REST and GraphQL.

import { Forge } from "./forge.ts";
import { issueJson, pullJson, repoJson } from "./rest.ts";

export const MCP_SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "github-core-clone", version: "1.0.0", title: "GitHub Core Clone" };
const CAPABILITIES = { tools: { listChanged: false } };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const str = (description: string) => ({ type: "string", description });

export const TOOLS: ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository for the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("The name of the repository."),
        description: str("A short description of the repository."),
        private: { type: "boolean", description: "Whether the repository is private." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: { owner: str("The repository owner login."), repo: str("The repository name.") },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: str("The repository owner login."),
        repo: str("The repository name."),
        title: str("The issue title."),
        body: str("The issue body."),
      },
      required: ["owner", "repo", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: {
        owner: str("The repository owner login."),
        repo: str("The repository name."),
        state: str("Filter by state: open, closed or all."),
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "create_pull_request",
    description: "Create a pull request from a head branch into a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: str("The repository owner login."),
        repo: str("The repository name."),
        title: str("The pull request title."),
        head: str("The head branch name."),
        base: str("The base branch name."),
        body: str("The pull request body."),
      },
      required: ["owner", "repo", "title", "head", "base"],
      additionalProperties: false,
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request by number.",
    inputSchema: {
      type: "object",
      properties: {
        owner: str("The repository owner login."),
        repo: str("The repository name."),
        pull_number: { type: "integer", description: "The pull request number." },
      },
      required: ["owner", "repo", "pull_number"],
      additionalProperties: false,
    },
  },
  {
    name: "get_issue",
    description: "Get one issue by number.",
    inputSchema: {
      type: "object",
      properties: {
        owner: str("The repository owner login."),
        repo: str("The repository name."),
        issue_number: { type: "integer", description: "The issue number." },
      },
      required: ["owner", "repo", "issue_number"],
      additionalProperties: false,
    },
  },
  {
    name: "list_pull_requests",
    description: "List pull requests in a repository, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: {
        owner: str("The repository owner login."),
        repo: str("The repository name."),
        state: str("Filter by state: open, closed or all."),
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpOutcome {
  status: number;
  body: unknown | null;
}

/** Handle one raw /mcp request body. Auth is enforced by the caller. */
export function handleMcp(forge: Forge, rawBody: string): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => handleOne(forge, entry as JsonRpcRequest)).filter((r) => r !== null);
    return { status: 200, body: results };
  }
  const single = handleOne(forge, parsed as JsonRpcRequest);
  if (single === null) return { status: 202, body: null };
  return { status: 200, body: single };
}

function handleOne(forge: Forge, request: JsonRpcRequest): Record<string, unknown> | null {
  const isNotification = request.id === undefined || request.id === null;
  const id = request.id ?? null;
  const method = typeof request.method === "string" ? request.method : "";
  const params = (request.params ?? {}) as Record<string, unknown>;

  const result = (value: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, result: value });
  const error = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "server/discover":
      return result({
        protocolVersion: MCP_SUPPORTED_VERSIONS[0],
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : "2025-11-25";
      return result({ protocolVersion: negotiated, capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
    }
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS });
    case "tools/call": {
      if (isNotification) return null;
      const outcome = callTool(forge, params);
      const marker = (outcome as { __jsonRpcError?: { code: number; message: string } }).__jsonRpcError;
      if (marker) return error(marker.code, marker.message);
      return result(outcome);
    }
    default:
      if (isNotification) return null;
      if (method.startsWith("notifications/")) return null;
      return error(-32601, `Method not found: ${method}`);
  }
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    content: [{ type: "text", text }],
    structuredContent: typeof value === "object" && value !== null ? value : { value },
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

function callTool(forge: Forge, params: Record<string, unknown>): Record<string, unknown> {
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    return { __jsonRpcError: { code: -32602, message: `Unknown tool: ${name}` } } as unknown as Record<string, unknown>;
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === "") {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  const owner = String(args.owner ?? forge.viewer.login);
  const repoName = String(args.repo ?? "");
  try {
    switch (name) {
      case "create_repo": {
        const repoNameNew = String(args.name);
        if (forge.getRepo(forge.viewer.login, repoNameNew)) return toolError(`Repository ${repoNameNew} already exists`);
        const repo = forge.createRepo(repoNameNew, {
          description: typeof args.description === "string" ? args.description : "",
          private: typeof args.private === "boolean" ? args.private : false,
        });
        return toolResult(repoJson(forge, repo));
      }
      case "get_repo": {
        const repo = forge.getOwnedRepo(owner, repoName);
        if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
        return toolResult(repoJson(forge, repo));
      }
      case "create_issue": {
        const repo = forge.getOwnedRepo(owner, repoName);
        if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
        const issue = forge.createIssue(repo, String(args.title), typeof args.body === "string" ? args.body : "");
        return toolResult(issueJson(forge, repo, issue));
      }
      case "list_issues": {
        const repo = forge.getOwnedRepo(owner, repoName);
        if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
        const state = typeof args.state === "string" ? args.state : "open";
        let issues = [...repo.issues.values()].filter((i) => !i.pullNumber);
        if (state === "open") issues = issues.filter((i) => i.state === "open");
        else if (state === "closed") issues = issues.filter((i) => i.state === "closed");
        issues.sort((a, b) => b.number - a.number);
        return toolResult({ issues: issues.map((i) => issueJson(forge, repo, i)), total_count: issues.length });
      }
      case "create_pull_request": {
        const repo = forge.getOwnedRepo(owner, repoName);
        if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
        const head = String(args.head);
        const base = String(args.base);
        if (!forge.branchTip(repo, head)) return toolError(`Head branch "${head}" does not exist`);
        if (!forge.branchTip(repo, base)) return toolError(`Base branch "${base}" does not exist`);
        const pull = forge.createPull(repo, String(args.title), typeof args.body === "string" ? args.body : "", head, base);
        return toolResult(pullJson(forge, repo, pull));
      }
      case "merge_pull_request": {
        const repo = forge.getOwnedRepo(owner, repoName);
        if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
        const pull = repo.pulls.get(Number(args.pull_number));
        if (!pull) return toolError(`Pull request ${String(args.pull_number)} not found`);
        if (!pull.merged) {
          const merged = forge.mergePull(repo, pull, "merge");
          if (merged === "conflict") return toolError("Pull Request is not mergeable");
        }
        return toolResult(pullJson(forge, repo, pull));
      }
      case "get_issue": {
        const repo = forge.getOwnedRepo(owner, repoName);
        if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
        const issue = repo.issues.get(Number(args.issue_number));
        if (!issue || issue.pullNumber) return toolError(`Issue ${String(args.issue_number)} not found`);
        return toolResult(issueJson(forge, repo, issue));
      }
      case "list_pull_requests": {
        const repo = forge.getOwnedRepo(owner, repoName);
        if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
        const state = typeof args.state === "string" ? args.state : "open";
        let pulls = [...repo.pulls.values()];
        if (state === "open") pulls = pulls.filter((p) => p.state === "open");
        else if (state === "closed") pulls = pulls.filter((p) => p.state === "closed");
        pulls.sort((a, b) => b.number - a.number);
        return toolResult({ pull_requests: pulls.map((p) => pullJson(forge, repo, p)), total_count: pulls.length });
      }
      default:
        return toolError(`Tool ${name} is not implemented`);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}
