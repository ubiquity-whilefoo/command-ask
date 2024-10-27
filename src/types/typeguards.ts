import { AppParamsHelper } from "./llm";

export function chatBotPayloadTypeguard(payload: unknown): payload is AppParamsHelper<"chat-bot"> {
  return typeof payload === "object" && payload !== null && "languages" in payload && "dependencies" in payload;
}

export function codeReviewPayloadTypeguard(payload: unknown): payload is AppParamsHelper<"code-review"> {
  return typeof payload === "object" && payload !== null && "taskSpecification" in payload && "codeReviewModelPrompt" in payload;
}
