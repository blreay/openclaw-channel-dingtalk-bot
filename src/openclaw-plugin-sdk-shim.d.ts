declare module 'openclaw/plugin-sdk/core' {
  export const DEFAULT_ACCOUNT_ID: string;
  export function emptyPluginConfigSchema(): unknown;
}

declare module 'openclaw/plugin-sdk/channel-message' {
  export function createReplyPrefixContext(params: unknown): {
    responsePrefix?: string;
    responsePrefixContextProvider?: unknown;
  };
}

declare module 'openclaw/plugin-sdk/webhook-ingress' {
  export function registerPluginHttpRoute(params: unknown): () => void;
}

declare module 'openclaw/dist/plugin-sdk/index.js' {
  export type OpenClawPluginApi = any;
  export type PluginRuntime = any;
  export type ChannelMeta = any;
  export type ChannelPlugin = any;
  export type OpenClawConfig = any;
  export type ReplyPayload = any;
}
