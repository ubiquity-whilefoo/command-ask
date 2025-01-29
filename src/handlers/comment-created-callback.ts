import { postComment } from "@ubiquity-os/plugin-sdk";
import { bubbleUpErrorComment } from "../helpers/errors";
import { Context } from "../types";
import { CallbackResult } from "../types/proxy";
import { askQuestion } from "./ask-llm";

export async function issueCommentCreatedCallback(context: Context<"issue_comment.created">): Promise<CallbackResult> {
  const { logger, command, payload, env } = context;
  let question = "";

  if (payload.comment.user?.type === "Bot") {
    throw logger.error("Comment is from a bot. Skipping.");
  }

  if (command?.name === "ask") {
    question = command.parameters.question;
  } else if (payload.comment.body.trim().startsWith("/ask")) {
    question = payload.comment.body.trim().replace("/ask", "").trim();
  }
  if (!question) {
    throw logger.error("No question provided");
  }

  try {
    await postComment(context, logger.ok(`${env.UBIQUITY_OS_APP_NAME} is thinking...`));
    const response = await askQuestion(context, question);
    const { answer, tokenUsage, groundTruths } = response;
    if (!answer) {
      throw logger.error(`No answer from OpenAI`);
    }

    const res = logger.info(answer, { groundTruths, tokenUsage });
    res.metadata = { ...res.metadata, caller: "ubiquity-os-llm-response" };
    await postComment(context, res, { raw: true });
    return { status: 200, reason: logger.info("Comment posted successfully").logMessage.raw };
  } catch (error) {
    throw await bubbleUpErrorComment(context, error, false);
  }
}
