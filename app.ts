// The forge application: one HTTP server routing /healthz, the REST v3 API
// under /api/v3, GraphQL at /api/graphql, MCP at /mcp, and git smart HTTP at
// /<owner>/<repo>.git/... — all over one shared Forge store.
//
// Kept from the kit starter: the exported createApp() shape that main.ts
// drives (no arguments; the token comes from $MAKEFUN_SHOP_TOKEN).
// Everything behind it is the implementation.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Forge } from "./forge.ts";
import { handleRest, requestId, sendError, sendJson, type RestRequest } from "./rest.ts";
import { executeGraphQL, type GraphQLRequest } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";
import { infoRefs, readBody, receivePack, uploadPack } from "./githttp.ts";

export interface ForgeOptions {
  /** The bearer token every surface (except /healthz) requires. */
  token?: string;
}

const DEFAULT_TOKEN = "makefun-shop-token";

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  return typeof header === "string" && header === `Bearer ${token}`;
}

function protocolVersion(req: IncomingMessage): number {
  const header = req.headers["git-protocol"];
  const value = Array.isArray(header) ? header.join(",") : header ?? "";
  return /(?:^|,)version=2(?:,|$)/.test(value.replace(/\s/g, "")) || value.includes("version=2") ? 2 : 0;
}

export function createApp(options: ForgeOptions = {}): Server {
  const token = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? DEFAULT_TOKEN;
  const forge = new Forge();

  const server = createServer((req, res) => {
    void handle(forge, token, req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, "Internal Server Error");
      else res.end();
    });
  });
  return server;
}

/** Alias kept for local tooling. */
export const createForge = createApp;

async function handle(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-github-request-id": requestId() });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!authorized(req, token)) {
    sendJson(res, 401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
    return;
  }

  const baseUrl = `http://${req.headers.host ?? "localhost"}`;

  // REST v3
  if (path === "/api/v3" || path.startsWith("/api/v3/")) {
    const rawSegments = path.slice("/api/v3".length).split("/").filter((s) => s.length > 0);
    const segments = rawSegments.map((s) => safeDecode(s));
    let body: unknown = undefined;
    let bodyMalformed = false;
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          bodyMalformed = true;
        }
      }
    }
    const restReq: RestRequest = { method, segments, query: url.searchParams, body, bodyMalformed, baseUrl };
    handleRest(forge, restReq, res);
    return;
  }

  // GraphQL v4
  if (path === "/api/graphql") {
    if (method !== "POST") {
      sendError(res, 404, "Not Found");
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { errors: [{ message: "Problems parsing JSON" }] });
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) => executeGraphQL(forge, normalizeGraphQLRequest(entry)));
      sendJson(res, 200, results);
      return;
    }
    const result = executeGraphQL(forge, normalizeGraphQLRequest(parsed));
    sendJson(res, 200, result);
    return;
  }

  // MCP
  if (path === "/mcp") {
    if (method !== "POST") {
      sendError(res, 404, "Not Found");
      return;
    }
    const raw = await readBody(req);
    const outcome = handleMcp(forge, raw.toString("utf8"));
    if (outcome.body === null) {
      res.writeHead(outcome.status, { "x-github-request-id": requestId() });
      res.end();
      return;
    }
    res.writeHead(outcome.status, {
      "content-type": "application/json; charset=utf-8",
      "x-github-request-id": requestId(),
      "mcp-session-id": "forge-session",
    });
    res.end(JSON.stringify(outcome.body));
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = safeDecode(gitMatch[1]);
    const repoName = safeDecode(gitMatch[2]);
    const repo = forge.getOwnedRepo(owner, repoName);
    if (!repo) {
      sendError(res, 404, "Not Found");
      return;
    }
    const endpoint = gitMatch[3];
    if (endpoint === "info/refs" && method === "GET") {
      const service = url.searchParams.get("service") ?? "";
      if (service !== "git-upload-pack" && service !== "git-receive-pack") {
        sendError(res, 400, "Bad Request");
        return;
      }
      infoRefs(forge, repo, service, protocolVersion(req), res);
      return;
    }
    if (endpoint === "git-upload-pack" && method === "POST") {
      const body = await readBody(req);
      uploadPack(forge, repo, body, protocolVersion(req), res);
      return;
    }
    if (endpoint === "git-receive-pack" && method === "POST") {
      const body = await readBody(req);
      receivePack(forge, repo, body, res);
      return;
    }
    sendError(res, 404, "Not Found");
    return;
  }

  sendError(res, 404, "Not Found");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizeGraphQLRequest(entry: unknown): GraphQLRequest {
  const record = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  return {
    query: typeof record.query === "string" ? record.query : "",
    variables: record.variables !== null && typeof record.variables === "object" ? (record.variables as Record<string, unknown>) : undefined,
    operationName: typeof record.operationName === "string" ? record.operationName : undefined,
  };
}
