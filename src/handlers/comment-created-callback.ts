import { Context, SupportedEvents } from "../types";
import { addCommentToIssue } from "./add-comment";
import { askQuestion } from "./ask-llm";
import { CallbackResult } from "../types/proxy";
import { bubbleUpErrorComment } from "../helpers/errors";

export async function issueCommentCreatedCallback(
  context: Context<"issue_comment.created", SupportedEvents["issue_comment.created"]>
): Promise<CallbackResult> {
  const {
    logger,
    env: { UBIQUITY_OS_APP_NAME },
  } = context;
  const question = context.payload.comment.body.trim();
  if (!question || question.length === 0) {
    return { status: 204, reason: logger.info("Comment is empty. Skipping.").logMessage.raw };
  }
  const slugRegex = new RegExp(`@${UBIQUITY_OS_APP_NAME} `, "gi");
  if (!question.match(slugRegex)) {
    return { status: 204, reason: logger.info("Comment does not mention the app. Skipping.").logMessage.raw };
  }
  if (context.payload.comment.user?.type === "Bot") {
    return { status: 204, reason: logger.info("Comment is from a bot. Skipping.").logMessage.raw };
  }
  if (question.replace(slugRegex, "").trim().length === 0) {
    return { status: 204, reason: logger.info("Comment is empty. Skipping.").logMessage.raw };
  }
  logger.info(`Asking question: ${question}`);

  try {
    const response = await askQuestion(context, question);
    const { answer, tokenUsage } = response;
    if (!answer) {
      throw logger.error(`No answer from OpenAI`);
    }
    logger.info(`Answer: ${answer}`, { tokenUsage });
    const tokens = `\n\n<!--\n${JSON.stringify(tokenUsage, null, 2)}\n--!>`;
    const commentToPost = answer + tokens;
    await addCommentToIssue(context, commentToPost);
    return { status: 200, reason: logger.info("Comment posted successfully").logMessage.raw };
  } catch (error) {
    throw await bubbleUpErrorComment(context, error, false);
  }
}
