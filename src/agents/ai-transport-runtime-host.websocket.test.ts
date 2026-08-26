import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAiTransportHost } from "@openclaw/ai";
import type { Model } from "@openclaw/llm-core";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import "./ai-transport-runtime-host.js";
import { createOpenAIResponsesWebSocketStream } from "../../packages/ai/src/transports/openai-responses-websocket.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";

const tempDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

function clearProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTlsMaterial() {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-responses-ws-"));
  tempDirs.push(dir);
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

async function startResponsesServer() {
  const tls = createTlsMaterial();
  const requests: unknown[] = [];
  let path: string | undefined;
  let headers: Record<string, string | string[] | undefined> = {};
  const server = createHttpsServer(tls);
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, request) => {
    path = request.url;
    headers = request.headers;
    socket.on("message", (data) => {
      requests.push(JSON.parse(data.toString()));
      socket.send(
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_proxy_contract",
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing response server address");
  }
  closers.push(async () => {
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return {
    baseUrl: `https://localhost:${address.port}/v1`,
    cert: tls.cert.toString(),
    requests,
    getPath: () => path,
    getHeaders: () => headers,
  };
}

async function startConnectProxy(requiredAuthorization?: string) {
  const requests: Array<{ authority: string; authorization?: string }> = [];
  const sockets = new Set<ReturnType<typeof connect>>();
  const server = createHttpServer();
  server.on("connect", (request, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.once("close", () => sockets.delete(clientSocket));
    const authorization =
      typeof request.headers["proxy-authorization"] === "string"
        ? request.headers["proxy-authorization"]
        : undefined;
    requests.push({ authority: request.url ?? "", ...(authorization ? { authorization } : {}) });
    if (requiredAuthorization && authorization !== requiredAuthorization) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const [hostname, portText] = (request.url ?? "").split(":");
    const upstream = connect(Number(portText), hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("error", () => clientSocket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing proxy address");
  }
  closers.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function makeModel(
  baseUrl: string,
  request?: Parameters<typeof attachModelProviderRequestTransport>[1],
) {
  const model = {
    id: "custom-responses",
    name: "Custom Responses",
    api: "openai-responses",
    provider: "custom",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: { supportsResponsesWebSocket: true },
  } satisfies Model<"openai-responses">;
  return attachModelProviderRequestTransport(model, request);
}

async function consume(model: Model<"openai-responses">, headers?: Record<string, string>) {
  const client = new OpenAI({ apiKey: "sdk-key", baseURL: model.baseUrl });
  const response = createOpenAIResponsesWebSocketStream({
    client,
    request: {
      model: model.id,
      input: "hello",
      stream: true,
      previous_response_id: "must-drop",
    },
    mode: "websocket",
    customEndpoint: true,
    headers,
    connectionOptions: getAiTransportHost().resolveWebSocketConnectionOptions(model),
  });
  const events: unknown[] = [];
  for await (const event of response.stream) {
    events.push(event);
  }
  response.finish();
  return events;
}

describe("custom Responses WebSocket proxy runtime contract", () => {
  it("tunnels through HTTPS_PROXY while applying destination TLS", async () => {
    clearProxyEnv();
    const target = await startResponsesServer();
    const proxy = await startConnectProxy();
    vi.stubEnv("HTTPS_PROXY", proxy.url);
    vi.stubEnv("NO_PROXY", "");
    const model = makeModel(target.baseUrl, { tls: { ca: target.cert } });

    await expect(
      consume(model, { Authorization: "Bearer target-secret", "x-tenant": "tenant-one" }),
    ).resolves.toEqual([expect.objectContaining({ type: "response.completed" })]);

    expect(proxy.requests).toEqual([{ authority: new URL(target.baseUrl).host }]);
    expect(target.getPath()).toBe("/v1/responses");
    expect(target.getHeaders().authorization).toBe("Bearer target-secret");
    expect(target.getHeaders()["x-tenant"]).toBe("tenant-one");
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]).not.toHaveProperty("previous_response_id");
  });

  it("uses an explicit HTTP CONNECT proxy", async () => {
    clearProxyEnv();
    const target = await startResponsesServer();
    const proxy = await startConnectProxy();
    const model = makeModel(target.baseUrl, {
      proxy: { mode: "explicit-proxy", url: proxy.url },
      tls: { ca: target.cert },
    });

    await consume(model);

    expect(proxy.requests).toHaveLength(1);
    expect(target.requests).toHaveLength(1);
  });

  it("isolates proxy URL credentials from destination authorization", async () => {
    clearProxyEnv();
    const target = await startResponsesServer();
    const proxyAuthorization = `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`;
    const proxy = await startConnectProxy(proxyAuthorization);
    const proxyUrl = new URL(proxy.url);
    proxyUrl.username = "proxy-user";
    proxyUrl.password = "proxy-pass";
    vi.stubEnv("HTTPS_PROXY", proxyUrl.href);
    vi.stubEnv("NO_PROXY", "");
    const model = makeModel(target.baseUrl, { tls: { ca: target.cert } });

    await consume(model, { Authorization: "Bearer target-secret" });

    expect(proxy.requests).toEqual([
      { authority: new URL(target.baseUrl).host, authorization: proxyAuthorization },
    ]);
    expect(target.getHeaders().authorization).toBe("Bearer target-secret");
    expect(target.getHeaders()["proxy-authorization"]).toBeUndefined();
  });

  it("honors NO_PROXY and ALL_PROXY fallback", async () => {
    clearProxyEnv();
    const directTarget = await startResponsesServer();
    const proxy = await startConnectProxy();
    vi.stubEnv("HTTPS_PROXY", proxy.url);
    vi.stubEnv("NO_PROXY", "localhost");
    await consume(makeModel(directTarget.baseUrl, { tls: { ca: directTarget.cert } }));
    expect(proxy.requests).toHaveLength(0);

    const proxiedTarget = await startResponsesServer();
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("ALL_PROXY", proxy.url);
    vi.stubEnv("NO_PROXY", "");
    await consume(makeModel(proxiedTarget.baseUrl, { tls: { ca: proxiedTarget.cert } }));
    expect(proxy.requests).toHaveLength(1);
  });

  it("fails closed for unsupported proxy TLS and missing env-proxy routes", () => {
    clearProxyEnv();
    const host = getAiTransportHost();
    expect(() =>
      host.resolveWebSocketConnectionOptions(
        makeModel("https://compatible.example/v1", {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.example:8080",
            tls: { ca: "proxy-ca" },
          },
        }),
      ),
    ).toThrow(/proxy TLS/i);
    expect(() =>
      host.resolveWebSocketConnectionOptions(
        makeModel("https://compatible.example/v1", { proxy: { mode: "env-proxy" } }),
      ),
    ).toThrow(/env-proxy.*no applicable/i);
  });
});
