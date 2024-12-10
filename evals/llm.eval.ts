import { Eval } from "braintrust";
import { Levenshtein, ContextPrecision } from "autoevals";
import goldResponses from "./data/eval-gold-responses.json";
import OpenAI from "openai";
import { VoyageAIClient } from "voyageai";
import { createClient } from "@supabase/supabase-js";
import { createAdapters } from "../src/adapters";
import { Context } from "../src/types/context";
import { logger } from "../src/helpers/errors";
import { customOctokit as Octokit } from "@ubiquity-os/plugin-sdk/octokit";
import issueTemplate from "../tests/__mocks__/issue-template";
import { writeFileSync } from "fs";
import { fetchContext, formattedHistory, initAdapters } from "./handlers/setup-context";

// Required environment variables with type assertion
const requiredEnvVars = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY as string,
  UBIQUITY_OS_APP_NAME: process.env.UBIQUITY_OS_APP_NAME as string,
  VOYAGEAI_API_KEY: process.env.VOYAGEAI_API_KEY as string,
  SUPABASE_URL: process.env.SUPABASE_URL as string,
  SUPABASE_KEY: process.env.SUPABASE_KEY as string,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY as string,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN as string,
};

// Validate all required env vars are present
Object.entries(requiredEnvVars).forEach(([key, value]) => {
  if (!value) {
    throw new Error(`${key} is required`);
  }
});

type Scenario = {
  scenario: string;
  issue: {
    body: string;
    html_url: string;
    number: number;
    question: string;
  };
  responseMustInclude: Array<string>;
  sender: {
    login: string;
    type: string;
  };
  repository: {
    name: string;
    owner: {
      login: string;
      type: string;
    };
  };
  expectedResponse: string;
};

type EvalInput = {
  scenario: Scenario;
};

type EvalOutput = {
  output: string;
  context: string;
  expected: string;
};

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

const clients = {
  supabase: createClient(requiredEnvVars.SUPABASE_URL, requiredEnvVars.SUPABASE_KEY),
  voyage: new VoyageAIClient({ apiKey: requiredEnvVars.VOYAGEAI_API_KEY }),
  openai: new OpenAI({
    apiKey: (inputs.settings.openAiBaseUrl && requiredEnvVars.OPENROUTER_API_KEY) || requiredEnvVars.OPENAI_API_KEY,
    baseURL: inputs.settings.openAiBaseUrl || undefined,
  }),
};

// Create base context
const baseContext: Partial<Context> = {
  config: inputs.config,
  env: requiredEnvVars,
  logger,
  octokit: new Octokit({ auth: requiredEnvVars.GITHUB_TOKEN }),
};

export const main = async () => {
  const result = await Eval<EvalInput, EvalOutput, string, void, void>("Command Ask LLM", {
    data: () => {
      const responses = goldResponses.issueResponses as Scenario[];
      return responses.map((scenario: Scenario) => {
        return {
          input: {
            scenario,
          },
          expected: scenario.expectedResponse,
        };
      });
    },
    task: async (input: EvalInput) => {
      const { scenario } = input;
      let initialContext: Context = {
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

      initialContext = initAdapters(initialContext, clients);
      const chatHistory = await fetchContext(initialContext, scenario.issue.question);
      const formattedContextHistory = formattedHistory(chatHistory);
      const result = await initialContext.adapters.openai.completions.createCompletion(
        scenario.issue.question,
        initialContext.config.model || "gpt-4o",
        chatHistory.rerankedText,
        chatHistory.formattedChat,
        chatHistory.groundTruths,
        initialContext.env.UBIQUITY_OS_APP_NAME,
        initialContext.config.maxTokens
      );

      return {
        output: result.answer,
        context: formattedContextHistory,
        expected: scenario.expectedResponse,
      };
    },
    scores: [
      (args) =>
        Levenshtein({
          output: args.output.output,
          expected: args.expected,
        }),
      (args) =>
        ContextPrecision({
          input: args.input.scenario.issue.question,
          output: args.output.output,
          context: args.output.context,
          expected: args.expected,
          openAiApiKey: requiredEnvVars.OPENROUTER_API_KEY,
          openAiBaseUrl: inputs.settings.openAiBaseUrl,
        }),
    ],
  });

  const scores = result.summary.scores || {};
  const metrics = result.summary.metrics || {};

  // Helper function to format diff with arrow
  const formatDiff = (value: number | undefined, isTime = false) => {
    if (value === undefined) return "-";
    const arrow = value > 0 ? "↑" : "↓";
    const formatted = isTime ? Math.abs(value).toFixed(2) + "s" : Math.abs(value).toFixed(4);
    return `${arrow} ${formatted}`;
  };

  // Helper function to get status emoji
  const getStatus = (regressions: number | undefined) => {
    if (regressions === undefined) return "❓";
    return regressions > 0 ? "⚠️" : "✅";
  };

  // Write results as markdown table
  const markdown = `## Evaluation Results

| Metric | Current | vs Previous | Status |
|--------|---------|-------------|---------|
| Levenshtein | ${scores.Levenshtein?.score.toFixed(4) || "-"} | ${formatDiff(scores.Levenshtein?.diff)} | ${getStatus(scores.Levenshtein?.regressions)} |
| Context Precision | ${scores.ContextPrecision?.score.toFixed(4) || "-"} | ${formatDiff(scores.ContextPrecision?.diff)} | ${getStatus(scores.ContextPrecision?.regressions)} |
| Duration | ${metrics.duration?.metric.toFixed(2) || "-"}s | ${formatDiff(metrics.duration?.diff, true)} | ${getStatus(metrics.duration?.regressions)} |
| Cost | $${metrics.estimated_cost?.metric.toFixed(6) || "-"} | ${formatDiff(metrics.estimated_cost?.diff)} | ${getStatus(metrics.estimated_cost?.regressions)} |`;
  writeFileSync("eval-results.md", markdown);
};

void main();
