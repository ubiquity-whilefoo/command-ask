import { postComment } from "@ubiquity-os/plugin-sdk";
import { LogReturn, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { Context } from "../types";

export const logger = new Logs("debug");

export async function bubbleUpErrorComment(context: Context, err: unknown, post = true): Promise<LogReturn> {
  const errorMessage = context.logger.error("An error occurred", { err });

  if (post) {
    await postComment(context, errorMessage);
  }

  return errorMessage;
}
