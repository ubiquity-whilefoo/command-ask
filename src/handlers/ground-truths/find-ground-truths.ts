import { Context } from "../../types";
import { AppParamsHelper, ModelApplications } from "../../types/llm";
import { GROUND_TRUTHS_SYSTEM_MESSAGES } from "./prompts";
import { chatBotPayloadTypeguard, codeReviewPayloadTypeguard } from "../../types/typeguards";
import { validateGroundTruths } from "./validate";
import { logger } from "../../helpers/errors";
import { createGroundTruthCompletion } from "./create-ground-truth-completion";
import { createGroundTruthSysMsg } from "./create-system-message";

export async function findGroundTruths<TApp extends ModelApplications = ModelApplications>(
  context: Context,
  application: TApp,
  params: AppParamsHelper<TApp>
): Promise<string[]> {
  const systemMsgObj = GROUND_TRUTHS_SYSTEM_MESSAGES[application];
  const systemMsg = createGroundTruthSysMsg(systemMsgObj);

  if (chatBotPayloadTypeguard(params)) {
    const { dependencies, devDependencies, languages } = params;
    return findChatBotTruths(context, { dependencies, devDependencies, languages }, systemMsg);
  } else if (codeReviewPayloadTypeguard(params)) {
    const { taskSpecification } = params;
    return findCodeReviewTruths(context, { taskSpecification }, systemMsg);
  } else {
    throw logger.error("Invalid payload type for ground truths");
  }
}

async function findChatBotTruths(context: Context, params: AppParamsHelper<"chat-bot">, systemMsg: string): Promise<string[]> {
  const truths = await createGroundTruthCompletion<"chat-bot">(context, JSON.stringify(params), systemMsg, "o1-mini");
  return validateGroundTruths(truths);
}

async function findCodeReviewTruths(context: Context, params: AppParamsHelper<"code-review">, systemMsg: string): Promise<string[]> {
  const { taskSpecification } = params;
  const truths = await createGroundTruthCompletion<"code-review">(context, taskSpecification, systemMsg, "gpt-4o");
  return validateGroundTruths(truths);
}
