import { Octokit } from "@octokit/rest";
import { PluginInputs } from "./types";
import { Context } from "./types";
import { askQuestion } from "./handlers/ask-llm";
import { addCommentToIssue } from "./handlers/add-comment";
import { LogLevel, LogReturn, Logs } from "@ubiquity-dao/ubiquibot-logger";
import { Env } from "./types/env";
import { createAdapters } from "./adapters";
import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import OpenAI from "openai";

export async function plugin(inputs: PluginInputs, env: Env) {
  const octokit = new Octokit({ auth: inputs.authToken });
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
  const voyageClient = new VoyageAIClient({
    apiKey: env.VOYAGEAI_API_KEY,
  });
  const openAiObject = {
    apiKey: (inputs.settings.openAiBaseUrl && env.OPENROUTER_API_KEY) || env.OPENAI_API_KEY,
    ...(inputs.settings.openAiBaseUrl && { baseURL: inputs.settings.openAiBaseUrl }),
  };
  const openaiClient = new OpenAI(openAiObject);
  const context: Context = {
    eventName: inputs.eventName,
    payload: inputs.eventPayload,
    config: inputs.settings,
    octokit,
    env,
    logger: new Logs("info" as LogLevel),
    adapters: {} as ReturnType<typeof createAdapters>,
  };
  context.adapters = createAdapters(supabase, voyageClient, openaiClient, context);
  return runPlugin(context);
}

export async function runPlugin(context: Context) {
  const {
    logger,
    env: { UBIQUITY_OS_APP_NAME },
  } = context;
  const question = context.payload.comment.body;
  const slugRegex = new RegExp(`@${UBIQUITY_OS_APP_NAME} `, "gi");
  if (!question.match(slugRegex)) {
    logger.info("Comment does not mention the app. Skipping.");
    return;
  }
  if (context.payload.comment.user?.type === "Bot") {
    logger.info("Comment is from a bot. Skipping.");
    return;
  }
  if (question.replace(slugRegex, "").trim().length === 0) {
    logger.info("Comment is empty. Skipping.");
    return;
  }
  logger.info(`Asking question: ${question}`);
  let commentToPost;
  try {
    const response = await askQuestion(context, question);
    const { answer, tokenUsage } = response;
    if (!answer) {
      throw logger.error(`No answer from OpenAI`);
    }
    logger.info(`Answer: ${answer}`, { tokenUsage });
    const tokens = `\n\n<!--\n${JSON.stringify(tokenUsage, null, 2)}\n--!>`;
    commentToPost = answer + tokens;
  } catch (err) {
    let errorMessage;
    if (err instanceof LogReturn) {
      errorMessage = err;
    } else if (err instanceof Error) {
      errorMessage = context.logger.error(err.message, { error: err, stack: err.stack });
    } else {
      errorMessage = context.logger.error("An error occurred", { err });
    }
    commentToPost = `${errorMessage?.logMessage.diff}\n<!--\n${sanitizeMetadata(errorMessage?.metadata)}\n-->`;
  }
  await addCommentToIssue(context, commentToPost);
}

function sanitizeMetadata(obj: LogReturn["metadata"]): string {
  return JSON.stringify(obj, null, 2).replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/--/g, "&#45;&#45;");
}
