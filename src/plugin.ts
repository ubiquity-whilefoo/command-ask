import { Octokit } from "@octokit/rest";
import { PluginInputs } from "./types";
import { Context } from "./types";
import { LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { Env } from "./types/env";
import { createAdapters } from "./adapters";
import { createClient } from "@supabase/supabase-js";
import { VoyageAIClient } from "voyageai";
import OpenAI from "openai";
import { proxyCallbacks } from "./helpers/callback-proxy";

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
  return proxyCallbacks(context)[context.eventName];
}
