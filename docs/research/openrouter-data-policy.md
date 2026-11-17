# What OpenRouter exposes about training and retention

_Checked 2026-10-23, live and without a key unless noted. Context: #83 removed Handyboy's
request-level `data_collection: "deny"` and replaced it with Setup warnings; #85 designs
how those warnings and the run log get real data instead of a heuristic._

## Measured

| Request | Result |
| --- | --- |
| `GET https://openrouter.ai/api/v1/endpoints/zdr` | 200, no auth. 1065 endpoints, 376 model ids, 65 providers. Per endpoint: `model_id`, `provider_name`, `tag`, `status`, pricing. No training or retention field. |
| `GET /api/v1/models/{author}/{slug}/endpoints` | Same per-endpoint shape, `tag` joins exactly with the ZDR list's `tag`. No policy field. |
| `GET /api/v1/models` | No training or retention field at all. |
| `GET /api/v1/providers` | No policy fields. |

Spot checks against the ZDR list:

- `nvidia/nemotron-3-ultra-550b-a55b` (paid): 5 ZDR endpoints (deepinfra, baseten, venice).
- `nvidia/nemotron-3.5-lightning:free`: none.
- `meta/muse-spark-1.3-contributor`: none. Its one endpoint (Meta) trains on prompts; that is
  what made every paid-model request under `deny` end in `404 No endpoints found matching your
  data policy (Paid model training)`.

## From OpenRouter's docs

- ZDR guide (`openrouter.ai/docs/guides/features/zdr`): providers that do not retain data cannot
  train on it, so the ZDR list proves "does not train" per endpoint.
- Router metadata: the `X-OpenRouter-Metadata: enabled` request header adds
  `openrouter_metadata` to responses, including which endpoint was selected and any fallback
  attempts. It does not change routing.
- The account privacy settings decide which endpoints may serve a request once the request
  itself sets no `data_collection`. Handyboy cannot read those settings.

## What follows

- "Does not train" can be proven per endpoint from the ZDR list.
- "Trains" has no machine-readable source for paid OpenRouter models. Red warnings stay limited
  to Kilo's `mayTrainOnYourPrompts`, `:free` OpenRouter ids, and a Kilo twin flagged as training
  (`src/ui/state/models.ts` `trainingRisk`); anything else is amber/unknown.
- The provider that actually served a call is ground truth regardless of account settings, and
  is worth recording in the run log.
