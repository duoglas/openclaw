import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiProviderRequestCapabilities,
} from "@openclaw/ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNodeProxyAgent } from "../infra/net/node-proxy-agent.js";
import "../llm/ai-transport-host.js";
import { getModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import {
  resolveProviderStreamFn,
  resolveProviderTransportTurnStateWithPlugin,
  wrapProviderSimpleCompletionStreamFn,
} from "../plugins/provider-runtime.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";
import {
  attachModelProviderLocalService,
  getModelProviderLocalService,
} from "./provider-local-service.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
  getModelProviderRequestRouteFacts,
  inheritModelProviderRequestRouteFacts,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";
import { transformTransportMessages } from "./transport-message-transform.js";

let configured = false;

/** Installs the agent and plugin ports only on paths that execute provider runtime. */
export function configureAiTransportRuntimeHost(): void {
  if (configured) {
    return;
  }
  const host = getAiTransportHost();
  configureAiTransportHost({
    ...host,
    plugin: {
      ...host.plugin,
      resolveProviderStream: (params) =>
        resolveProviderStreamFn({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          context: {
            ...params.context,
            config: params.context.config as OpenClawConfig | undefined,
            model: params.context.model as ProviderRuntimeModel,
          },
        }),
      resolveTransportTurnState: (params) =>
        resolveProviderTransportTurnStateWithPlugin({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          runtimeHandle: getModelProviderRuntimePluginHandle(params.context.model),
          context: {
            ...params.context,
            model: params.context.model as ProviderRuntimeModel | undefined,
          },
        }),
      wrapSimpleCompletionStream: (params) =>
        wrapProviderSimpleCompletionStreamFn({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          context: {
            ...params.context,
            config: params.context.config as OpenClawConfig | undefined,
            model: params.context.model as ProviderRuntimeModel,
          },
        }),
      createAnthropicVertexStream: createAnthropicVertexStreamFnForModel,
    },
    buildCopilotDynamicHeaders: (messages) =>
      buildCopilotDynamicHeaders({ messages, hasImages: hasCopilotVisionInput(messages) }),
    resolveProviderRequestCapabilities: (input) =>
      (getModelProviderRequestRouteFacts(input.model ?? {})?.capabilities ??
        resolveProviderRequestCapabilities(input)) as AiProviderRequestCapabilities,
    resolveProviderRequestHeaders: (input) =>
      resolveProviderRequestPolicyConfig({
        ...input,
        routeFacts: getModelProviderRequestRouteFacts(input.model ?? {}),
        capability: "llm",
        transport: "stream",
      }).headers,
    resolveWebSocketConnectionOptions: (model) => {
      if (getModelProviderLocalService(model)) {
        throw new Error("Responses WebSocket does not support provider local-service routing");
      }
      const policy = resolveProviderRequestPolicyConfig({
        provider: model.provider,
        api: model.api,
        baseUrl: model.baseUrl,
        capability: "llm",
        transport: "websocket",
        request: getModelProviderRequestTransport(model),
        routeFacts: getModelProviderRequestRouteFacts(model),
      });
      if (policy.proxy.configured && policy.proxy.tls.configured) {
        throw new Error("Responses WebSocket cannot faithfully apply configured proxy TLS policy");
      }
      const agent = policy.proxy.configured
        ? policy.proxy.mode === "explicit-proxy"
          ? createNodeProxyAgent({
              mode: "explicit",
              proxyUrl: policy.proxy.proxyUrl,
              protocol: "https",
            })
          : createNodeProxyAgent({
              mode: "env",
              targetUrl: model.baseUrl,
              protocol: "https",
            })
        : createNodeProxyAgent({ mode: "env", targetUrl: model.baseUrl });
      if (policy.proxy.configured && policy.proxy.mode === "env-proxy" && !agent) {
        throw new Error("Responses WebSocket env-proxy mode has no applicable proxy route");
      }
      return {
        ...(agent ? { agent } : {}),
        ...(policy.tls.configured
          ? {
              ...(policy.tls.ca !== undefined ? { ca: policy.tls.ca } : {}),
              ...(policy.tls.cert !== undefined ? { cert: policy.tls.cert } : {}),
              ...(policy.tls.key !== undefined ? { key: policy.tls.key } : {}),
              ...(policy.tls.passphrase !== undefined ? { passphrase: policy.tls.passphrase } : {}),
              ...(policy.tls.serverName !== undefined ? { servername: policy.tls.serverName } : {}),
              ...(policy.tls.rejectUnauthorized !== undefined
                ? { rejectUnauthorized: policy.tls.rejectUnauthorized }
                : {}),
            }
          : {}),
      };
    },
    requiresManagedTransport: (model) => {
      const request = getModelProviderRequestTransport(model);
      return Boolean(request?.proxy || request?.tls || getModelProviderLocalService(model));
    },
    inheritManagedTransport: (source, target) =>
      inheritModelProviderRequestRouteFacts(
        source,
        attachModelProviderLocalService(
          attachModelProviderRequestTransport(target, getModelProviderRequestTransport(source)),
          getModelProviderLocalService(source),
        ),
      ),
    transformTransportMessages,
    registerCustomApi: ensureCustomApiRegistered,
  });
  configured = true;
}

configureAiTransportRuntimeHost();
