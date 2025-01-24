import { Context } from "../types";
import { TokenLimits } from "../types/llm";
import { encode } from "gpt-tokenizer";

export function createDefaultTokenLimits(context: Context): TokenLimits {
  const modelMaxTokenLimit = context.adapters.openai.completions.getModelMaxTokenLimit(context.config.model);
  const maxCompletionTokens = context.adapters.openai.completions.getModelMaxOutputLimit(context.config.model);
  return {
    modelMaxTokenLimit,
    maxCompletionTokens,
    runningTokenCount: 0,
    context,
    tokensRemaining: modelMaxTokenLimit - maxCompletionTokens,
  };
}

export function updateTokenCount(text: string, tokenLimits: TokenLimits): boolean {
  const tokenCount = encode(text, { disallowedSpecial: new Set() }).length;
  if (tokenLimits.runningTokenCount + tokenCount > tokenLimits.tokensRemaining) {
    tokenLimits.context.logger.debug(`Skipping ${text} to stay within token limits.`);
    return false;
  }
  tokenLimits.context.logger.debug(`Added ${tokenCount} tokens. Running total: ${tokenLimits.runningTokenCount}. Remaining: ${tokenLimits.tokensRemaining}`);
  tokenLimits.runningTokenCount += tokenCount;
  tokenLimits.tokensRemaining -= tokenCount;
  return true;
}
