import { Eval } from "braintrust";
import { Levenshtein } from "autoevals";
import goldResponses from "./data/eval-gold-responses.json";
import OpenAI from "openai";
import { VoyageAIClient } from "voyageai";
import { createClient } from "@supabase/supabase-js";
import { createAdapters } from "../src/adapters";
import { Context } from "../src/types";
import { logger } from "../src/helpers/errors";
import { Octokit } from "@octokit/rest";
import { askQuestion } from "../src/handlers/ask-llm";
import issueTemplate from "../tests/__mocks__/issue-template";
const inputs = {
  config: {
    model: "gpt-4o",
    similarityThreshold: 0.8,
    maxTokens: 1000,
  },
  settings: {
    openAiBaseUrl: "https://openrouter.ai/api/v1",
  },
};

const openAiObject = {
  apiKey: (inputs.settings.openAiBaseUrl && process.env.OPENROUTER_API_KEY) || process.env.OPENAI_API_KEY,
  ...(inputs.settings.openAiBaseUrl && { baseURL: inputs.settings.openAiBaseUrl }),
};

// Initialize clients
const openai = new OpenAI(openAiObject);

const voyageClient = new VoyageAIClient({
  apiKey: process.env.VOYAGEAI_API_KEY,
});

const supabase = createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_KEY || "");

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// Create base context
const baseContext: Partial<Context> = {
  config: inputs.config,
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    UBIQUITY_OS_APP_NAME: process.env.UBIQUITY_OS_APP_NAME || "",
    VOYAGEAI_API_KEY: process.env.VOYAGEAI_API_KEY || "",
    SUPABASE_URL: process.env.SUPABASE_URL || "",
    SUPABASE_KEY: process.env.SUPABASE_KEY || "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  },
  logger,
  octokit,
};

void (async () => {
  await Eval("Command Ask LLM", {
    data: () =>
      goldResponses.issueResponses.map((scenario) => ({
        input: scenario,
        expected: scenario.expectedResponse,
      })),
    task: async (scenario) => {
      // Create initial context with temporary adapters placeholder
      const context: Context = {
        ...baseContext,
        adapters: {} as ReturnType<typeof createAdapters>,
        payload: {
          issue: {
            ...issueTemplate,
            body: scenario.issue.body,
            html_url: scenario.issue.html_url,
            number: scenario.issue.number,
          } as unknown as Context["payload"]["issue"],
          sender: scenario.sender,
          repository: {
            name: scenario.repository.name,
            owner: {
              login: scenario.repository.owner.login,
            },
          },
          comment: {
            body: scenario.issue.question,
            user: scenario.sender,
          } as unknown as Context["payload"]["comment"],
          action: "created" as string,
          installation: { id: 1 } as unknown as Context["payload"]["installation"],
          organization: { login: "ubiquity" } as unknown as Context["payload"]["organization"],
        },
        eventName: "issue_comment.created",
      } as Context;

      // Create adapters with the initial context
      const adapters = createAdapters(supabase, voyageClient, openai, context);

      // Create a new context with the proper adapters
      const finalContext: Context = {
        ...context,
        adapters,
      };

      // Update the adapters' context reference
      Object.values(adapters).forEach((adapterGroup) => {
        Object.values(adapterGroup).forEach((adapter) => {
          if (adapter && typeof adapter === "object" && "context" in adapter) {
            adapter.context = finalContext;
          }
        });
      });

      const result = await askQuestion(finalContext, scenario.issue.question);
      return result.answer;
    },
    scores: [Levenshtein],
  });
})();
