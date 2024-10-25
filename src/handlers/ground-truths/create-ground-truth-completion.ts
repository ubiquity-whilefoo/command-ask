import OpenAI from "openai";
import { Context } from "../../types";
import { CompletionsModelHelper, ModelApplications } from "../../types/llm";

export async function createGroundTruthCompletion<TApp extends ModelApplications>(
  context: Context,
  groundTruthSource: string,
  systemMsg: string,
  model: CompletionsModelHelper<TApp>
): Promise<string | null> {
  const {
    env: { OPENAI_API_KEY },
    config: { openAiBaseUrl },
  } = context;

  const openAi = new OpenAI({
    apiKey: OPENAI_API_KEY,
    ...(openAiBaseUrl && { baseURL: openAiBaseUrl }),
  });

  const msgs = [
    {
      role: "system",
      content: systemMsg,
    },
    {
      role: "user",
      content: groundTruthSource,
    },
  ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];

  const res = await openAi.chat.completions.create({
    messages: msgs,
    model: model,
  });

  return res.choices[0].message.content;
}
