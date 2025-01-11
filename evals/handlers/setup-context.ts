import { SupabaseClient } from "@supabase/supabase-js";
import { createAdapters } from "../../src/adapters";
import { CommentSimilaritySearchResult } from "../../src/adapters/supabase/helpers/comment";
import { IssueSimilaritySearchResult } from "../../src/adapters/supabase/helpers/issues";
import { fetchRepoLanguageStats, fetchRepoDependencies } from "../../src/handlers/ground-truths/chat-bot";
import { findGroundTruths } from "../../src/handlers/ground-truths/find-ground-truths";
import { logger } from "../../src/helpers/errors";
import { formatChatHistory } from "../../src/helpers/format-chat-history";
import { recursivelyFetchLinkedIssues } from "../../src/helpers/issue-fetching";
import { Context } from "../../src/types";
import { VoyageAIClient } from "voyageai";
import OpenAI from "openai";

const SEPERATOR = "######################################################\n";

export interface FetchContext {
  rerankedText: string[];
  formattedChat: string[];
  groundTruths: string[];
}

export interface EvalClients {
  supabase: SupabaseClient;
  voyage: VoyageAIClient;
  openai: OpenAI;
}

export const initAdapters = (context: Context, clients: EvalClients): Context => {
  const adapters = createAdapters(clients.supabase, clients.voyage, clients.openai, context);
  context.adapters = adapters;

  // Update adapter contexts
  Object.values(adapters).forEach((adapterGroup) => {
    Object.values(adapterGroup).forEach((adapter) => {
      if (adapter && typeof adapter === "object" && "context" in adapter) {
        adapter.context = context;
      }
    });
  });
  return context;
};

export async function fetchContext(context: Context, question: string): Promise<FetchContext> {
  const {
    config: { similarityThreshold },
    adapters: {
      supabase: { comment, issue },
      voyage: { reranker },
    },
  } = context;
  const { specAndBodies, streamlinedComments } = await recursivelyFetchLinkedIssues({
    context,
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
  });
  let formattedChat = await formatChatHistory(context, streamlinedComments, specAndBodies);
  logger.info(`${formattedChat.join("")}`);
  // using db functions to find similar comments and issues
  const [similarComments, similarIssues] = await Promise.all([
    comment.findSimilarComments(question, 1 - similarityThreshold, ""),
    issue.findSimilarIssues(question, 1 - similarityThreshold, ""),
  ]);
  // combine the similar comments and issues into a single array
  const similarText = [
    ...(similarComments?.map((comment: CommentSimilaritySearchResult) => comment.comment_plaintext) || []),
    ...(similarIssues?.map((issue: IssueSimilaritySearchResult) => issue.issue_plaintext) || []),
  ];
  // filter out any empty strings
  formattedChat = formattedChat.filter((text) => text);
  // rerank the similar text using voyageai
  const rerankedText = similarText.length > 0 ? await reranker.reRankResults(similarText, question) : [];
  // gather structural data about the payload repository
  const [languages, { dependencies, devDependencies }] = await Promise.all([fetchRepoLanguageStats(context), fetchRepoDependencies(context)]);
  let groundTruths: string[] = [];
  if (!languages.length) {
    groundTruths.push("No languages found in the repository");
  }
  if (!Reflect.ownKeys(dependencies).length) {
    groundTruths.push("No dependencies found in the repository");
  }
  if (!Reflect.ownKeys(devDependencies).length) {
    groundTruths.push("No devDependencies found in the repository");
  }
  if (groundTruths.length > 3) {
    groundTruths = await findGroundTruths(context, "chat-bot", { languages, dependencies, devDependencies });
  }
  return {
    rerankedText,
    formattedChat,
    groundTruths,
  };
}

export function formattedHistory(fetchContext: FetchContext): string {
  //Iterate through the formatted chat history and add it to the final formatted chat
  let formattedChat = "#################### Chat History ####################\n";
  fetchContext.formattedChat.forEach((chat) => {
    formattedChat += chat;
  });
  formattedChat += SEPERATOR;
  //Iterate through the reranked text and add it to the final formatted chat
  formattedChat += "#################### Reranked Text ####################\n";
  fetchContext.rerankedText.forEach((reranked) => {
    formattedChat += reranked;
  });
  formattedChat += SEPERATOR;
  //Iterate through the ground truths and add it to the final formatted chat
  formattedChat += "#################### Ground Truths ####################\n";
  fetchContext.groundTruths.forEach((truth) => {
    formattedChat += truth;
  });
  formattedChat += SEPERATOR;
  return formattedChat;
}
