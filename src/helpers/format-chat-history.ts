import { Context } from "../types";
import { StreamlinedComment, StreamlinedComments, TokenLimits } from "../types/llm";
import { createKey, streamlineComments } from "../handlers/comments";
import { fetchPullRequestDiff, fetchIssue, fetchIssueComments } from "./issue-fetching";
import { pullReadmeFromRepoForIssue, splitKey } from "./issue";
import { logger } from "./errors";

export async function formatChatHistory(
  context: Context,
  streamlined: Record<string, StreamlinedComment[]>,
  specAndBodies: Record<string, string>
): Promise<string[]> {
  // At this point really we should have all the context we can obtain but we try again just in case
  const keys = new Set([...Object.keys(streamlined), ...Object.keys(specAndBodies), createKey(context.payload.issue.html_url)]);
  const tokenLimits: TokenLimits = {
    modelMaxTokenLimit: context.adapters.openai.completions.getModelMaxTokenLimit(context.config.model),
    maxCompletionTokens: context.config.maxTokens || context.adapters.openai.completions.getModelMaxOutputLimit(context.config.model),
    runningTokenCount: 0,
    tokensRemaining: 0,
  };

  // what we start out with
  tokenLimits.tokensRemaining = tokenLimits.modelMaxTokenLimit - tokenLimits.maxCompletionTokens;

  // careful adding any more API calls here as it's likely to hit the secondary rate limit
  const chatHistory = await Promise.all(
    // keys are owner/repo/issueNum; so for each issue, we want to create a block
    Array.from(keys).map(async (key, i) => {
      // if we run out of tokens, we should stop
      if (tokenLimits.tokensRemaining < 0) {
        logger.error(`Ran out of tokens at block ${i}`);
        return "";
      }
      try {
        const [currentTokenCount, result] = await createContextBlockSection({
          context,
          key,
          streamlined,
          specAndBodies,
          isCurrentIssue: key === createKey(context.payload.issue.html_url),
          tokenLimits,
        });
        // update the token count
        tokenLimits.runningTokenCount = currentTokenCount;
        tokenLimits.tokensRemaining = tokenLimits.modelMaxTokenLimit - tokenLimits.maxCompletionTokens - currentTokenCount;
        return result;
      } catch (error) {
        logger.error(`Error creating context block for ${key}: ${error}`);
      }
    })
  );

  return Array.from(new Set(chatHistory)).filter((x): x is string => !!x);
}

// These give structure and provide the distinction between the different sections of the chat history
function getCorrectHeaderString(prDiff: string | null, isCurrentIssue: boolean, isConvo: boolean) {
  const strings = {
    convo: {
      pull: {
        linked: `Linked Pull Request Conversation`,
        current: `Current Pull Request Conversation`,
      },
      issue: {
        linked: `Linked Task Conversation`,
        current: `Current Task Conversation`,
      },
    },
    spec: {
      pull: {
        linked: `Linked Pull Request Specification`,
        current: `Current Pull Request Specification`,
      },
      issue: {
        linked: `Linked Task Specification`,
        current: `Current Task Specification`,
      },
    },
  };

  const category = isConvo ? "convo" : "spec";
  const issueType = prDiff ? "pull" : "issue";
  const issueStatus = isCurrentIssue ? "current" : "linked";
  return strings[category][issueType][issueStatus];
}

async function createContextBlockSection({
  context,
  key,
  streamlined,
  specAndBodies,
  isCurrentIssue,
  tokenLimits,
}: {
  context: Context;
  key: string;
  streamlined: Record<string, StreamlinedComment[]>;
  specAndBodies: Record<string, string>;
  isCurrentIssue: boolean;
  tokenLimits: TokenLimits;
}): Promise<[number, string]> {
  let comments = streamlined[key];
  // just in case we try again but we should already have the comments
  if (!comments || !comments.length) {
    const [owner, repo, number] = splitKey(key);
    const { comments: fetchedComments } = await fetchIssueComments({
      context,
      owner,
      repo,
      issueNum: parseInt(number),
    });
    comments = streamlineComments(fetchedComments)[key];
  }

  const [org, repo, issueNum] = key.split("/");
  const issueNumber = parseInt(issueNum);
  if (!issueNumber || isNaN(issueNumber)) {
    throw context.logger.error("Issue number is not valid");
  }

  // Fetch our diff if we have one; this excludes the largest of files to keep within token limits
  const { diff } = await fetchPullRequestDiff(context, org, repo, issueNumber, tokenLimits);
  // specification or pull request body
  let specOrBody = specAndBodies[key];
  // we should have it already but just in case
  if (!specOrBody) {
    specOrBody =
      (
        await fetchIssue({
          context,
          owner: org,
          repo,
          issueNum: issueNumber,
        })
      )?.body || "No specification or body available";
  }

  const specHeader = getCorrectHeaderString(diff, isCurrentIssue, false); //E.g:  === Current Task Specification ===
  const blockHeader = getCorrectHeaderString(diff, isCurrentIssue, true); //E.g:  === Linked Task Conversation ===

  // contains the actual spec or body
  const specBlock = [createHeader(specHeader, key), createSpecOrBody(specOrBody), createFooter(specHeader, key)];
  // contains the conversation
  const commentSection = createComment({ issueNumber, repo, org, comments }, specOrBody);

  let block;
  // if we have a conversation, we should include it
  if (commentSection) {
    block = [specBlock.join("\n"), createHeader(blockHeader, key), commentSection, createFooter(blockHeader, key)];
  } else {
    // No need for empty sections in the chat history
    block = [specBlock.join("\n")];
  }

  // only inject the README if this is the current issue as that's likely most relevant
  if (isCurrentIssue) {
    const readme = await pullReadmeFromRepoForIssue({ context, owner: org, repo });
    // give the readme it's own clear section
    if (readme) {
      const readmeBlock = readme ? [createHeader("README", key), createSpecOrBody(readme), createFooter("README", key)] : [];
      block = block.concat(readmeBlock);
    }
  }

  if (!diff) {
    // the diff was already encoded etc but we have added more to the block so we need to re-encode
    return [await context.adapters.openai.completions.findTokenLength(block.join("")), block.join("\n")];
  }

  // Build the block with the diff in it's own section
  const blockWithDiff = [block.join("\n"), createHeader(`Pull Request Diff`, key), diff, createFooter(`Pull Request Diff`, key)];
  return [await context.adapters.openai.completions.findTokenLength(blockWithDiff.join("")), blockWithDiff.join("\n")];
}

function createHeader(content: string, repoString: string) {
  return `=== ${content} === ${repoString} ===\n`;
}

function createFooter(content: string, repoString: string) {
  return `=== End ${content} === ${repoString} ===\n`;
}

function createSpecOrBody(specOrBody: string) {
  return `${specOrBody}\n`;
}

function createComment(comment: StreamlinedComments, specOrBody: string) {
  if (!comment.comments) {
    return null;
  }

  const seen = new Set<number>();
  comment.comments = comment.comments.filter((c) => {
    // Do not include the same comment twice or the spec/body
    if (seen.has(c.id) || c.body === specOrBody) {
      return false;
    }
    seen.add(c.id);
    return true;
  });

  const formattedComments = comment.comments.map((c) => `${c.id} ${c.user}: ${c.body}\n`);

  if (formattedComments.length === 0) {
    return;
  }
  return formattedComments.join("");
}
