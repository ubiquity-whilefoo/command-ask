import { postComment } from "@ubiquity-os/plugin-sdk";
import { bubbleUpErrorComment } from "../helpers/errors";
import { Context } from "../types";
import { CallbackResult } from "../types/proxy";
import { askQuestion } from "./ask-llm";

export async function processCommentCallback(context: Context<"issue_comment.created" | "pull_request_review_comment.created">): Promise<CallbackResult> {
  const { logger, command, payload, env } = context;
  let question = "";

  if (payload.comment.user?.type === "Bot") {
    throw logger.error("Comment is from a bot. Skipping.");
  }

  if (command?.name === "ask") {
    question = command.parameters.question;
  } else if (payload.comment.body.trim().startsWith("/ask")) {
    question = payload.comment.body.trim().replace("/ask", "").trim();
  } else if (!question) {
    return { status: 200, reason: logger.info("No question found in comment. Skipping.").logMessage.raw };
  }

  try {
    await postComment(context, logger.ok(`${env.UBIQUITY_OS_APP_NAME} is thinking...`));
    const response = await askQuestion(context, question);
    const { answer, tokenUsage, groundTruths } = response;
    if (!answer) {
      throw logger.error(`No answer from OpenAI`);
    }

    const metadataString = createStructuredMetadata(
      // don't change this header, it's used for tracking
      "ubiquity-os-llm-response",
      logger.info(`Answer: ${answer}`, {
        metadata: {
          groundTruths,
          tokenUsage,
        },
      })
    );
    //Check the type of comment
    if ("pull_request" in payload) {
      // This is a pull request review comment
      await addCommentToIssue(context, answer + metadataString, {
        inReplyTo: {
          commentId: payload.comment.id,
        },
      });
    } else {
      await addCommentToIssue(context, answer + metadataString);
    }
    // const res = logger.info(answer, { groundTruths, tokenUsage });
    // res.metadata = { ...res.metadata, caller: "ubiquity-os-llm-response" };
    // await postComment(context, res, { raw: true });
    return { status: 200, reason: logger.info("Comment posted successfully").logMessage.raw };
  } catch (error) {
    throw await bubbleUpErrorComment(context, error, false);
  }
}
