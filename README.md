# AI Gateway

This project is a Zuplo AI Gateway. It exposes the canonical AI Gateway
operations (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, and
`/v1/embeddings`) through `aiGatewayHandlerV2` under `/{app_id}/*`. Only paths
whose suffix is a supported `/v1/...` operation succeed; other paths under
`/{app_id}` return 404.

Each route invokes `ai-gateway-configuration-loader-v2-inbound`, which loads the
application's configuration from the `app_id` path segment, then
`ai-gateway-configuration-executor-v2-inbound`, which runs its
`inboundPolicyChain`. Applications may select only from the policies
pre-declared in `config/policies.json`. To require application API keys for a
specific app, add `ai-gateway-auth-v2-inbound` to that application's
`inboundPolicyChain`. Adding it on the route before the loader requires a key
for every application on the route.

## Customizing the gateway

- Declare additional selectable policies (including custom code policies) in
  `config/policies.json`.
- Pushes to your default branch deploy the gateway to production.
