import {
  AIGatewayDlpInboundPolicy,
  ZuploContext,
  ZuploRequest,
} from "@zuplo/runtime";

export default async function smartDlp(
  request: ZuploRequest,
  context: ZuploContext,
  options: any,
  policyName: string,
): Promise<ZuploRequest | Response> {
  const url = request.url.toLowerCase();

  // If this is an embeddings request, skip DLP inspection to prevent guardrail_uninspectable 400 errors
  if (url.includes("/embeddings")) {
    context.log.info("[DLP Policy] Skipping DLP inspection for embeddings request.");
    return request;
  }

  // For chat completions and other LLM requests, execute the standard AI Gateway DLP policy
  return await AIGatewayDlpInboundPolicy(request, context, options, policyName);
}
