# Zuplo AI Gateway - Multi-Account & Multi-Provider Pooling

This Zuplo AI Gateway pools multiple Cloudflare accounts (and Jina AI accounts) to achieve virtually unlimited free AI inference by automatically round-robining requests across accounts and transparently failing over to healthy backup accounts when Cloudflare's **10,000-neuron daily free limit** (or rate limits) is hit.

---

## Architecture & How It Works

```
                     +---------------------------------------+
                     |          ResumeAssistant.Api          |
                     |      (or any OpenAI SDK Client)       |
                     +---------------------------------------+
                                         |
                                         | POST /v1/chat/completions
                                         v
                     +---------------------------------------+
                     |           Zuplo AI Gateway            |
                     |                                       |
                     |   1. Auth & DLP Guardrails            |
                     |   2. round-robin-cloudflare Policy    |
                     |   3. Dynamic Model Routing            |
                     |   4. Auto-Fallback Engine             |
                     +---------------------------------------+
                                     /       \
                        (Primary: 1st)       (Backup: 2nd)
                                   /           \
                 +----------------------+ +----------------------+
                 | Cloudflare Account 1 | | Cloudflare Account 2 |
                 |  (10,000 Neurons/Day)| |  (10,000 Neurons/Day)|
                 +----------------------+ +----------------------+
                                     |
                                     v
                       (Fails over if 429 limit hit)
```

---

## 1. Setting Up Cloudflare Accounts in Zuplo

In the Zuplo Portal dashboard for your project:

1. Navigate to **Settings** > **AI Gateway** > **Providers**.
2. Click **Add Provider** and add your Cloudflare accounts as separate providers:
   - **Provider 1**:
     - Name: `cloudflare` (or `cloudflare-1`)
     - Provider Type: `Cloudflare`
     - Account ID: `<Your-First-Cloudflare-Account-ID>`
     - API Token: `<Your-First-Cloudflare-API-Token>`
     - Enable Models: `@cf/google/gemma-4-26b-a4b-it`, `@cf/meta/llama-3.3-70b-instruct`, etc.
   - **Provider 2**:
     - Name: `cloudflare-2`
     - Provider Type: `Cloudflare`
     - Account ID: `<Your-Second-Cloudflare-Account-ID>`
     - API Token: `<Your-Second-Cloudflare-API-Token>`
     - Enable Models: `@cf/google/gemma-4-26b-a4b-it`, `@cf/meta/llama-3.3-70b-instruct`, etc.
   - **Provider 3** (and more):
     - Name: `cloudflare-3`, etc.

---

## 2. Policy Configuration (`config/policies.json`)

The policy `round-robin-cloudflare` is registered in [`config/policies.json`](./config/policies.json):

```json
{
  "name": "round-robin-cloudflare",
  "policyType": "custom-code-inbound",
  "handler": {
    "export": "default",
    "module": "$import(./modules/round-robin-cloudflare)",
    "options": {
      "providers": [
        "cloudflare",
        "cloudflare-2",
        "cloudflare-3"
      ],
      "targetModel": "@cf/google/gemma-4-26b-a4b-it",
      "capability": "completions",
      "strategy": "round-robin",
      "enableFallback": true,
      "fallbackTimeoutSeconds": 15
    }
  }
}
```

### Policy Options Reference
| Option | Type | Default | Description |
|---|---|---|---|
| `providers` | `string[]` | All active `cloudflare*` | List of provider names to balance across. |
| `targetModel` | `string` | Dynamic (from request body) | Specific model to match, or dynamically auto-detected from request payload. |
| `capability` | `"completions" \| "embeddings"` | `"completions"` | Target capability in Zuplo catalog. |
| `strategy` | `"round-robin" \| "random"` | `"round-robin"` | Load balancing distribution strategy. |
| `enableFallback` | `boolean` | `true` | When `true`, automatically assigns the next account as `backup` in `AIGatewayModelRouting`. |
| `fallbackTimeoutSeconds` | `number` | `15` | Timeout before switching to the backup provider. |

---

## 3. Routes Configuration (`config/routes.oas.json`)

- `POST /v1/chat/completions`: Executes `round-robin-cloudflare` before dispatching through the AI Gateway runtime executor.
- `POST /v1/embeddings`: Executes `round-robin-embeddings` for balancing Jina AI embeddings across multiple API keys.

---

## 4. Connecting `ResumeAssistant.Api`

In `appsettings.json` (or `appsettings.Production.json`), point the LLM Cloud Base URL to your Zuplo Gateway:

```json
"LLM": {
  "Mode": "Cloud",
  "Cloud": {
    "BaseUrl": "https://<your-project>-<env>.zuplo.app/v1",
    "ApiToken": "<your-zuplo-api-key>",
    "Model": "@cf/google/gemma-4-26b-a4b-it"
  }
}
```
