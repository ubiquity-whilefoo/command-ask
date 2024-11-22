import { Eval } from "braintrust";
import { Levenshtein, ContextPrecision, ClosedQA } from "autoevals";
import goldResponses from "./data/eval-gold-responses.json";
import OpenAI from "openai";
import { VoyageAIClient } from "voyageai";
import { createClient } from "@supabase/supabase-js";
import { createAdapters } from "../src/adapters";
import { Context } from "../src/types/context";
import { logger } from "../src/helpers/errors";
import { Octokit } from "@octokit/rest";
import issueTemplate from "../tests/__mocks__/issue-template";
import { Partial } from "@sinclair/typebox";
import { fetchContext, formattedHistory, initAdapters } from "./handlers/setup-context";

//Scenario type
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
  supabase: createClient(process.env.SUPABASE_URL || "", process.env.SUPABASE_KEY || ""),
  voyage: new VoyageAIClient({ apiKey: process.env.VOYAGEAI_API_KEY }),
  openai: new OpenAI({
    apiKey: (inputs.settings.openAiBaseUrl && process.env.OPENROUTER_API_KEY) || process.env.OPENAI_API_KEY,
    baseURL: inputs.settings.openAiBaseUrl || undefined,
  }),
};

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
  octokit: new Octokit({ auth: process.env.GITHUB_TOKEN }),
};

// Eval
void Eval<EvalInput, EvalOutput, string, void, void>("Command Ask LLM", {
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
        openAiApiKey: process.env.OPENROUTER_API_KEY || "",
        openAiBaseUrl: inputs.settings.openAiBaseUrl || "",
      }),
    (args) =>
      ClosedQA({
        input: args.input.scenario.issue.question,
        output: args.output.output,
        criteria: (txt: string) => {
          // Check if txt overlaps with the array scenario.mustHave
          const mustHave = args.input.scenario.responseMustInclude || [];
          if (!Array.isArray(mustHave)) {
            return true;
          }
          for (const item of mustHave) {
            if (!txt.includes(item)) {
              return false;
            }
          }
          return true;
        },
        openAiApiKey: process.env.OPENROUTER_API_KEY || "",
        openAiBaseUrl: inputs.settings.openAiBaseUrl || "",
      }),
  ],
});
