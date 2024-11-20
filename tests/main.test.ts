import { db } from "./__mocks__/db";
import { server } from "./__mocks__/node";
import usersGet from "./__mocks__/users-get.json";
import { expect, describe, beforeAll, beforeEach, afterAll, afterEach, it, jest } from "@jest/globals";
import { Context, SupportedEvents } from "../src/types";
import { drop } from "@mswjs/data";
import issueTemplate from "./__mocks__/issue-template";
import repoTemplate from "./__mocks__/repo-template";
import { TransformDecodeCheckError, Value } from "@sinclair/typebox/value";
import { envSchema } from "../src/types/env";
import { CompletionsType } from "../src/adapters/openai/helpers/completions";
import { logger } from "../src/helpers/errors";
import { Octokit } from "@octokit/rest";

const TEST_QUESTION = "what is pi?";
const LOG_CALLER = "_Logs.<anonymous>";
const ISSUE_ID_2_CONTENT = "More context here #2";
const ISSUE_ID_3_CONTENT = "More context here #3";
const MOCK_ANSWER = "This is a mock answer for the chat";

type Comment = {
  id: number;
  user: {
    login: string;
    type: string;
  };
  body: string;
  url: string;
  html_url: string;
  owner: string;
  repo: string;
  issue_number: number;
  issue_url?: string;
  pull_request_url?: string;
};

// extractDependencies

jest.unstable_mockModule("../src/handlers/ground-truths/chat-bot", () => {
  return {
    fetchRepoDependencies: jest.fn().mockReturnValue({
      dependencies: {},
      devDependencies: {},
    }),
    extractDependencies: jest.fn(),
    // [string, number][]
    fetchRepoLanguageStats: jest.fn().mockReturnValue([
      ["JavaScript", 100],
      ["TypeScript", 200],
    ]),
  };
});

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  drop(db);
  server.resetHandlers();
});
afterAll(() => server.close());

// TESTS

describe("Ask plugin tests", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await setupTests();
  });

  it("should ask GPT a question", async () => {
    const ctx = createContext(TEST_QUESTION);
    createComments([transformCommentTemplate(1, 1, TEST_QUESTION, "ubiquity", "test-repo", true)]);
    const askQuestion = (await import("../src/handlers/ask-llm")).askQuestion;
    const res = await askQuestion(ctx, TEST_QUESTION);

    expect(res).toBeDefined();

    expect(res?.answer).toBe(MOCK_ANSWER);
  });

  it("Should throw if OPENAI_API_KEY is not defined", () => {
    const settings = {};
    expect(() => Value.Decode(envSchema, settings)).toThrow(TransformDecodeCheckError);
  });

  it("should construct the chat history correctly", async () => {
    const ctx = createContext(TEST_QUESTION);
    const infoSpy = jest.spyOn(ctx.logger, "info");
    createComments([
      transformCommentTemplate(1, 1, ISSUE_ID_2_CONTENT, "ubiquity", "test-repo", true, "2"),
      transformCommentTemplate(2, 1, TEST_QUESTION, "ubiquity", "test-repo", true, "1"),
      transformCommentTemplate(3, 2, ISSUE_ID_3_CONTENT, "ubiquity", "test-repo", true, "3"),
      transformCommentTemplate(4, 3, "Just a comment", "ubiquity", "test-repo", true, "1"),
    ]);

    const issueCommentCreatedCallback = (await import("../src/handlers/comment-created-callback")).issueCommentCreatedCallback;
    await issueCommentCreatedCallback(ctx);
    const prompt = `=== Current Task Specification === ubiquity/test-repo/1 ===

    This is a demo spec for a demo task just perfect for testing.

    === End Current Task Specification === ubiquity/test-repo/1 ===

    === Current Task Conversation === ubiquity/test-repo/1 ===

    1 ubiquity: ${ISSUE_ID_2_CONTENT} [#2](https://www.github.com/ubiquity/test-repo/issues/2)
    2 ubiquity: ${TEST_QUESTION} [#1](https://www.github.com/ubiquity/test-repo/issues/1)
    === End Current Task Conversation === ubiquity/test-repo/1 ===

    === README === ubiquity/test-repo/1 === 
    
    {"content":"This is a mock README file"} 

    === End README === ubiquity/test-repo/1 ===

    === Linked Task Specification === ubiquity/test-repo/2 ===

    Related to issue #3
    === End Linked Task Specification === ubiquity/test-repo/2 ===

    === Linked Task Conversation === ubiquity/test-repo/2 ===

    3 ubiquity: ${ISSUE_ID_3_CONTENT} [#3](https://www.github.com/ubiquity/test-repo/issues/3)
    === End Linked Task Conversation === ubiquity/test-repo/2 ===

   === Linked Task Specification === ubiquity/test-repo/3 ===

    Just another issue
    === End Linked Task Specification === ubiquity/test-repo/3 ===

    === Linked Task Conversation === ubiquity/test-repo/3 ===

    4 ubiquity: Just a comment [#1](https://www.github.com/ubiquity/test-repo/issues/1)
    === End Linked Task Conversation === ubiquity/test-repo/3 ===`;

    const normalizedExpected = normalizeString(prompt);
    const normalizedReceived = normalizeString(infoSpy.mock.calls[0][0] as string);

    expect(normalizedReceived).toEqual(normalizedExpected);
    expect(infoSpy).toHaveBeenNthCalledWith(2, "Answer: This is a mock answer for the chat", {
      caller: LOG_CALLER,
      metadata: {
        tokenUsage: {
          input: 1000,
          output: 150,
          total: 1150,
        },
        groundTruths: ["This is a mock answer for the chat"],
      },
    });
  });
});

// HELPERS

function normalizeString(str: string) {
  return str.replace(/\s+/g, " ").trim();
}

function transformCommentTemplate(commentId: number, issueNumber: number, body: string, owner: string, repo: string, isIssue = true, linkTo: string = "1") {
  const COMMENT_TEMPLATE = {
    id: 1,
    user: {
      login: "ubiquity",
      type: "User",
    },
    body: body,
    url: "https://api.github.com/repos/ubiquity/test-repo/issues/comments/1",
    html_url: "https://www.github.com/ubiquity/test-repo/issues/1",
    owner: "ubiquity",
    repo: "test-repo",
    issue_number: 1,
  };

  const comment: Comment = {
    id: commentId,
    user: {
      login: COMMENT_TEMPLATE.user.login,
      type: "User",
    },
    body: body + ` [#${linkTo}](${COMMENT_TEMPLATE.html_url.replace("1", linkTo.toString())})`,
    url: COMMENT_TEMPLATE.url.replace("1", issueNumber.toString()),
    html_url: COMMENT_TEMPLATE.html_url.replace("1", issueNumber.toString()),
    owner: owner,
    repo: repo,
    issue_number: issueNumber,
  };

  if (isIssue) {
    comment.issue_url = COMMENT_TEMPLATE.html_url.replace("1", issueNumber.toString());
  } else {
    comment.pull_request_url = COMMENT_TEMPLATE.html_url.replace("1", issueNumber.toString());
  }

  return comment;
}

async function setupTests() {
  for (const item of usersGet) {
    db.users.create(item);
  }

  db.repo.create({
    ...repoTemplate,
  });

  db.issue.create({
    ...issueTemplate,
  });

  db.issue.create({
    ...issueTemplate,
    id: 2,
    number: 2,
    body: "Related to issue #3",
  });

  db.issue.create({
    ...issueTemplate,
    id: 3,
    number: 3,
    body: "Just another issue",
  });
}

function createComments(comments: Comment[]) {
  for (const comment of comments) {
    db.comments.create({
      ...comment,
    });
  }
}

function createContext(body = TEST_QUESTION) {
  const user = db.users.findFirst({ where: { id: { equals: 1 } } });
  return {
    payload: {
      issue: db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context["payload"]["issue"],
      sender: user,
      repository: db.repo.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context["payload"]["repository"],
      comment: { body, user: user } as unknown as Context["payload"]["comment"],
      action: "created" as string,
      installation: { id: 1 } as unknown as Context["payload"]["installation"],
      organization: { login: "ubiquity" } as unknown as Context["payload"]["organization"],
    },
    command: {
      name: "ask",
      parameters: {
        question: body,
      },
    },
    owner: "ubiquity",
    repo: "test-repo",
    logger: logger,
    config: {},
    env: {
      UBIQUITY_OS_APP_NAME: "UbiquityOS",
      OPENAI_API_KEY: "test",
      VOYAGEAI_API_KEY: "test",
      SUPABASE_URL: "test",
      SUPABASE_KEY: "test",
    },
    adapters: {
      supabase: {
        issue: {
          getIssue: async () => {
            return [
              {
                id: "1",
                markdown: "This is a demo spec for a demo task just perfect for testing.",
                plaintext: "This is a demo spec for a demo task just perfect for testing.",
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
            ];
          },
          findSimilarIssues: async () => {
            return [
              {
                issue_id: "2",
                issue_plaintext: "Related to issue #3",
                similarity: 0.5,
              },
              {
                issue_id: "3",
                issue_plaintext: "Some other issue",
                similarity: 0.3,
              },
            ];
          },
        },
        comment: {
          getComments: async () => {
            return [
              {
                id: "1",
                plaintext: TEST_QUESTION,
                markdown: TEST_QUESTION,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
              {
                id: "2",
                plaintext: ISSUE_ID_2_CONTENT,
                markdown: ISSUE_ID_2_CONTENT,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
              {
                id: "3",
                plaintext: ISSUE_ID_3_CONTENT,
                markdown: ISSUE_ID_3_CONTENT,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
              {
                id: "4",
                plaintext: "Something new",
                markdown: "Something new",
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
            ];
          },
          findSimilarComments: async () => {
            return [
              {
                id: "2",
                plaintext: ISSUE_ID_2_CONTENT,
                markdown: ISSUE_ID_2_CONTENT,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
              {
                id: "3",
                plaintext: ISSUE_ID_3_CONTENT,
                markdown: ISSUE_ID_3_CONTENT,
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
              {
                id: "4",
                plaintext: "New Comment",
                markdown: "New Comment",
                author_id: 1,
                created_at: new Date().toISOString(),
                modified_at: new Date().toISOString(),
                embedding: [1, 2, 3],
              },
            ];
          },
        },
      },
      voyage: {
        embedding: {
          createEmbedding: async () => {
            return new Array(1024).fill(0);
          },
        },
        reranker: {
          reRankResults: async (similarText: string[]) => {
            return similarText;
          },
        },
      },
      openai: {
        completions: {
          getModelMaxTokenLimit: () => {
            return 50000;
          },
          getModelMaxOutputLimit: () => {
            return 50000;
          },
          createCompletion: async (): Promise<CompletionsType> => {
            return {
              answer: MOCK_ANSWER,
              groundTruths: [MOCK_ANSWER],
              tokenUsage: {
                input: 1000,
                output: 150,
                total: 1150,
              },
            };
          },
          findTokenLength: async () => {
            return 1000;
          },
          createGroundTruthCompletion: async (): Promise<string> => {
            return `["${MOCK_ANSWER}"]`;
          },
        },
      },
    },
    octokit: new Octokit(),
    eventName: "issue_comment.created" as SupportedEvents,
  } as unknown as Context;
}
