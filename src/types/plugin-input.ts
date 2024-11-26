import { StaticDecode, Type as T } from "@sinclair/typebox";

/**
 * This should contain the properties of the bot config
 * that are required for the plugin to function.
 *
 * The kernel will extract those and pass them to the plugin,
 * which are built into the context object from setup().
 */

export const pluginSettingsSchema = T.Object({
  model: T.String({ default: "o1-mini", description: "The LLM model you wish to use" }),
  openAiBaseUrl: T.Optional(T.String({ description: "The base URL for the OpenAI API" })),
  similarityThreshold: T.Number({ default: 0.9, description: "When fetching embeddings context, the similarity threshold to use (1- similarityThreshold)" }),
  maxTokens: T.Number({ default: 10000, description: "The max completion tokens you want to the model to generate" }),
});

export type PluginSettings = StaticDecode<typeof pluginSettingsSchema>;
