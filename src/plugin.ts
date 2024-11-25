import { Context } from "./types";
import { createAdapters } from "./adapters";
import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import OpenAI from "openai";
import { callCallbacks } from "./helpers/callback-proxy";
import { issueCommentCreatedCallback } from "./handlers/comment-created-callback";

export async function plugin(context: Context) {
  const { env, config } = context;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
  const voyageClient = new VoyageAIClient({
    apiKey: env.VOYAGEAI_API_KEY,
  });
  const openAiObject = {
    apiKey: (config.openAiBaseUrl && env.OPENROUTER_API_KEY) || env.OPENAI_API_KEY,
    ...(config.openAiBaseUrl && { baseURL: config.openAiBaseUrl }),
  };
  const openaiClient = new OpenAI(openAiObject);
  context.adapters = createAdapters(supabase, voyageClient, openaiClient, context);

  if (context.command) {
    return await issueCommentCreatedCallback(context);
  }
  return await callCallbacks(context, context.eventName);
}
