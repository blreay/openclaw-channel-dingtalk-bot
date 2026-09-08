# openclaw-channel-dingtalk-bot unusable on openclaw 2026.9.2 — 5 packaging/runtime defects

> Filed-ready draft. Reproduced on upgrade from openclaw 2026.9.x; the plugin worked under the older release. All fixes below are **local workarounds** editing installed files under `<plugin>/node_modules/openclaw-channel-dingtalk-bot/` — the underlying package itself should be fixed so the workarounds aren't needed. The 5 defects are stacked: #1–#3 are pure packaging/manifest bugs (channelConfigs missing, `"type":"module"` vs CJS code, bare `require("openclaw/plugin-sdk")`) that block the gateway from turning ready and the plugin from loading at all; #4–#5 are channel-runtime contract bugs (startAccount keepalive, inbound auth-vs-DingTalk-protocol) that only manifest once #1–#3 are worked around and the plugin starts to run.

## Environment
- openclaw: **2026.9.2** (`3928bad`)
- plugin: **openclaw-channel-dingtalk-bot@1.1.2** (also reproduces on 1.0.5)
- node: v24.20.0 (LTS)
- OS: Ubuntu 24.04 (container, no systemd user bus)
- state dir via `OPENCLAW_HOME=/opt/openclaw` (real config at `/opt/openclaw/.openclaw/openclaw.json`)

## Symptom (before workarounds)
After upgrading openclaw to 2026.9.2, restarting the gateway with the DingTalk channel enabled fails in a non-converging loop. `openclaw channels status` shows `DingTalk default: enabled, configured, not-running`. The gateway reaches neither `ready` nor a working channel. Once the convergence/load layers (#1–#3) are worked around so the plugin loads, the channel still won't stay running (#4) and real DingTalk callbacks are rejected at the plugin auth gate (#5).

## Five stacked root causes (each blocks the next)

### 1. Convergence loop: `plugin migration inputs changed during startup convergence`
**Gating code:** `dist/doctor-config-preflight-DU2dux1D.js`, `resolveMigrationCheckpointIdentity` + `migrationCheckpointIdentitiesMatch`; refusal thrown by `dist/doctor-startup-migration-refusal-Cc83Kqtn.js` (`throwStartupMigrationIdentityChanged`).

The startup preflight reads a migration checkpoint identity **before** plugin convergence, runs convergence (`runPostCorePluginConvergence`), then re-reads and compares. If the `pluginMigrationFingerprint` (derived from `pluginMetadataSnapshot.configFingerprint`, `dist/doctor-config-preflight-plugin-index-BxWAbSDh.js:42`) differs, readiness is refused and the operator is told to restart — forever, because the input keeps changing.

Why it keeps changing: `collectConfiguredPluginIdsWithMissingChannelConfigDescriptors` (`dist/missing-configured-plugin-install-B3eZm5tD.js:422`) collects plugins whose manifest produces the diagnostic `channel plugin manifest declares dingtalk without channelConfigs metadata`. The DingTalk plugin's `openclaw.plugin.json` declares `"channels": ["dingtalk"]` but has **no `channelConfigs`**. That makes DingTalk a `stale-channel-config-descriptor` repair target every startup (`missingRecordedPluginIds`, line 882/892-899), so convergence always "repairs" (reinstall ≠ fixes the manifest) and the inventory fingerprint always changes.

**Workaround applied:** added a `channelConfigs.dingtalk` block to `openclaw.plugin.json` (modeled on `a2a`'s shape: `{ label, description, schema }`).

**Suggested package fix:** ship `channelConfigs` in the plugin's `openclaw.plugin.json` (or package.json `openclaw` field), OR make the convergence planner **not** flag a `stale-channel-config-descriptor` plugin as a state-mutating repair target when the package payload is already present (the manifest staleness is metadata-only, not a reinstall-able condition).

### 2. ESM/CJS load error: `ReferenceError: exports is not defined in ES module scope`
`package.json` has `"type": "module"`, but `dist/index.js` / `dist/channel.js` are compiled **CommonJS** (`"use strict"; var __createBinding = …; require(...)`). Node 24 strictly treats `.js` as ESM under `"type":"module"`, so loading the CJS file throws `exports is not defined`.

Also, `package.json` `"main": "src/index.ts"` points at the TypeScript source (not a runnable entry), and `openclaw.extensions: ["./src/index.ts"]` likewise. The gateway loader resolves the real artifact (`dist/index.js`) by other means, but the manifest is still wrong.

**Workaround applied:** removed the `"type": "module"` line from `package.json` (code is CJS; Node defaults to commonjs without the key).

**Suggested package fix:** either (a) compile to ESM and set `"type":"module"` + proper ESM `import`/`export` in `dist/`, or (b) build CJS and drop `"type":"module"`. Also set `"main"`/`openclaw.extensions` to the compiled `dist/index.js`.

### 3. Unresolvable SDK import: `Cannot find module 'openclaw/plugin-sdk'`
The compiled files do `require("openclaw/plugin-sdk")` — the **bare** SDK path. The openclaw main package `exports` map exposes only `./plugin-sdk/<subpath>` (330 subpaths) and **no bare `./plugin-sdk`** entry. The gateway's SDK alias map (`dist/sdk-alias-BMTmaiMP.js`, `PLUGIN_SDK_PACKAGE_NAMES`) also only maps `openclaw/plugin-sdk/<subpath>` (note the trailing-slash form, line 874/882); a bare `openclaw/plugin-sdk` is neither exported nor aliased, and DingTalk doesn't declare `openclaw` as a dependency/peerDependency (deps are only `axios`, `zod`), so `node_modules` has nothing to resolve it to.

**Workaround applied:** rewrote the bare requires to the aliased subpaths that actually export the used symbols:
- `dist/index.js`: `require("openclaw/plugin-sdk/core")` (uses `emptyPluginConfigSchema`)
- `dist/channel.js`: `Object.assign({}, require("openclaw/plugin-sdk/core"), require("openclaw/plugin-sdk/channel-message"), require("openclaw/plugin-sdk/webhook-ingress"))` (uses `DEFAULT_ACCOUNT_ID` from core, `createReplyPrefixContext` from channel-message, `registerPluginHttpRoute` from webhook-ingress)

**Suggested package fix:** import the specific SDK subpaths the plugin actually uses (e.g. `import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core"`), OR have the plugin build resolve `openclaw/plugin-sdk` to a barrel that re-exports the needed subpaths. Optionally: add a bare `./plugin-sdk` export to the openclaw `exports` map as a convenience barrel so existing plugin code keeps working.

### 4. Channel lifecycle mismatch: `channel exited without an error` → endless auto-restart
`gateway.startAccount` registers its inbound HTTP route via `plugin_sdk_1.registerPluginHttpRoute(...)` and then **returns**. The gateway channel runner (`dist/server-channels-D39cmOPC.js`, `createAccountContext` provides `ctx.abortSignal` at line 337-341; gate at ~line 713) awaits `startAccount`; when the promise resolves without error, it logs `channel exited without an error`, sets `lastError`, and schedules an auto-restart (1/10, 2/10 …) → DingTalk is perpetually `not-running`. This is a webhook channel model: the route handler is the active surface, so `startAccount` has no long-lived work to do — but the gateway's liveness model treats a resolved `startAccount` as "exited".

**Workaround applied:** after registering the route, return a promise that stays pending until the gateway aborts the account:
```js
const abortSignal = ctx.abortSignal;
if (abortSignal && abortSignal.aborted) return;
return new Promise((resolve) => {
    if (!abortSignal) return resolve();
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
});
```

**Suggested package fix:** webhook-style channels should keep `startAccount` pending on `ctx.abortSignal` (documented contract), OR the gateway should treat a channel whose `startAccount` registered an HTTP route and resolved as "ready" rather than "exited".

### 5. Inbound auth incompatible with DingTalk's real callback protocol → every real callback returns 401
This one only shows once #1–#4 are worked around and the channel is actually running. `createWebhookHandler` (`dist/channel.js`, the plugin's inbound handler) authenticates exclusively with an HTTP **header**:

```js
const token = readTokenHeader(req);
if (!token || params.account.secretKey !== token) {
    respondJson(res, 401, { errcode: 1, errmsg: '[dingtalk] invalid token' });
    return;
}
```

i.e. it requires `req.headers.token === secretKey`. The plugin's own `sign.js` (`dingtalkSign`) implements the standard DingTalk custom-robot HMAC-SHA256 sign scheme — but it's used **only for outbound**. The inbound handler never reads the standard `timestamp`+`sign` from the request URL query.

A standard DingTalk custom-robot callback does **not** send a `token` HTTP header; it signs the request with `?timestamp=<ms>&sign=urlencode(base64(HmacSHA256(timestamp+"\n"+secretKey, secretKey)))` per the official DingTalk custom-robot security mechanism. So every real DingTalk message is rejected with HTTP 401 `[dingtalk] invalid token` — **the plugin cannot receive a single real DingTalk message as shipped.** The only way it "works" today is if something in front of the gateway injects a `token: <secretKey>` header (not part of the DingTalk protocol).

Proven by a 4-case matrix (with #1–#4 already worked around, channel running, listening on `0.0.0.0:18789`):

| Request form | Result |
|---|---|
| bare callback, no auth | 401 `[dingtalk] invalid token` |
| correct DingTalk `timestamp`+`sign` query (sign generated by the plugin's own `dingtalkSign`, **no** `token` header) | 401 `[dingtalk] invalid token` ← the bug |
| `token: <secretKey>` header (the plugin's custom scheme) | 200 |

**Workaround applied:** added `verifyDingtalkSign(req, secretKey)` to `dist/channel.js` and made `createWebhookHandler` accept **either** a verified DingTalk standard sign **or** the `token` header (backward-compatible for proxies that inject it):

```js
function verifyDingtalkSign(req, secretKey, maxAgeMs = 60 * 60 * 1000) {
    if (!secretKey) return false;
    let query = '';
    try { query = new URL(req.url, 'http://localhost').search || ''; }
    catch { query = (req.url || '').split('?')[1] || ''; }
    const params = new URLSearchParams(query);
    const timestamp = params.get('timestamp');
    const sign = params.get('sign');
    if (!timestamp || !sign) return false;
    const tsNum = Number(timestamp);
    if (!Number.isFinite(tsNum)) return false;
    if (Math.abs(Date.now() - tsNum) > maxAgeMs) return false; // replay guard
    try {
        const crypto = require('crypto');
        const expected = crypto.createHmac('sha256', secretKey)
            .update(`${timestamp}\n${secretKey}`).digest('base64');
        const received = decodeURIComponent(sign); // URLSearchParams already percent-decoded
        return expected.length === received.length && expected === received;
    } catch { return false; }
}
```

Two non-obvious implementation notes (both cost time and are easy to get wrong):
- `URLSearchParams.get('sign')` percent-decodes `%3D` within the base64 signature to `=`, so the comparison must be `decodeURIComponent(sign) === base64digest`, NOT `encodeURIComponent(base64digest) === sign` (the latter never matches a `=`-ending base64 sig).
- `req.url` (not `req.rawPath`/`req.path`) carries the query string on the raw Node http request object the gateway passes to plugin routes; `req.rawPath`/`req.path`/`req.originalUrl` are `undefined` here.

After the fix, the matrix becomes: sign (no token header) → 200 + agent triggered end-to-end (GLM-5 200 ~710ms, outbound to sessionWebhook); token header → 200; bad/missing/expired sign → 401. End-to-end confirmed: a real DingTalk group `@bot` message flowed callback → sign verify → agent → outbound-to-sessionWebhook → reply delivered to DingTalk.

**Suggested package fix:** authenticate inbound with the standard DingTalk `timestamp`+`sign` query (the plugin already has `sign.js` / `dingtalkSign`; the inverse verify is trivial), and drop or make the `token` header secondary. Optionally wire verification through the gateway's `applyBasicWebhookRequestGuards`/`withResolvedWebhookRequestPipeline` SDK surface (`plugin-sdk/webhook-ingress`) instead of hand-rolling. The README currently states `secretKey === token` as the auth rule without noting DingTalk callbacks don't send a `token` header — this misleads operators into expecting it to work out of the box.

## Enhancement: immediate DingTalk ack on inbound

Once #1–#5 are fixed and real DingTalk callbacks come through, a DingTalk user sending a message otherwise sees nothing until the agent replies (which may take seconds), leaving them unsure whether the message arrived or the bot is just slow. This fork replies **immediately** with `💪收到，处理中…` via the inbound `sessionWebhook`, then the normal reply follows.

Implementation: `handleInboundMessage` in `src/channel.ts`, after the group/non-mention ignore check passes and before agent routing (`resolveAgentRoute`), calls `sendMarkdownBySessionWebhook({ sessionWebhook: payload.sessionWebhook, secretKey: account.secretKey, text: '💪收到，处理中…' })`. The ack is fire-and-forget — any failure (no `sessionWebhook`, send error) is logged (`immediate ack failed`) and never blocks the real agent reply. The same signed-`sessionWebhook` path used by the real reply is reused, so no new outbound capability or extra credential is needed.

End-to-end confirmed: a DingTalk `@bot` message produces the ack within milliseconds, then the agent reply a few seconds later.

## Reproduction
1. Install openclaw 2026.9.2 + `openclaw-channel-dingtalk-bot@1.1.2`.
2. Configure `channels.dingtalk.secretKey` (enable the channel).
3. `openclaw gateway run` (or restart). Observe, in order: convergence-refusal loop (#1); after working around #1, `exports is not defined in ES module scope` (#2); after #2, `Cannot find module 'openclaw/plugin-sdk'` (#3); after #3, `channel exited without an error` + endless auto-restart, `not-running` (#4).
4. After working around #4 the channel shows `running`, but a standard DingTalk callback (no `token` header) returns HTTP 401 `[dingtalk] invalid token` (#5).
5. After all five workarounds: `openclaw channels status` → `DingTalk default: enabled, configured, running`; a real DingTalk group `@bot` message flows callback → sign verify → agent → outbound-to-sessionWebhook → reply delivered to the DingTalk group.

## Notes
- The DingTalk outbound model requires an inbound `sessionWebhook` (cached per conversation from the inbound payload). There is no unsolicited-push path in this plugin, consistent with the DingTalk enterprise-bot webhook model — not a bug, but worth noting in docs.
- `openclaw message send --channel dingtalk` is rejected because DingTalk isn't in the command's hardcoded channel allow-list; if introspected/plugin channels were supported there, end-to-end outbound testing would be easier.
- Deployment note (not a plugin bug): when the gateway sits behind a visible reverse proxy, the gateway must bind `0.0.0.0` and `gateway.trustedProxies` must list the proxy's egress CIDR (the gateway gates forwarded-header trust via `isTrustedProxyAddress`/`isIpInCidr` in `dist/net-DbNPs6Xm.js`); `trustedProxies: []` rejects proxy-shaped traffic with `proxy_attribution_required` (HTTP 403), and `["*"]` trusts forged `X-Forwarded-*` from anyone — a narrow CIDR is the correct setting. Repeated SIGKILL of the gateway also trips a `restart-loop breaker` (3 unclean boots in 300s) that suppresses channel auto-start; recover with `openclaw gateway call channels.start --params '{"channel":"dingtalk"}'`.
