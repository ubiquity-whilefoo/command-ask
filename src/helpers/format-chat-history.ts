import { Context } from "../types";
import { StreamlinedComment, StreamlinedComments } from "../types/llm";
import { createKey, streamlineComments } from "../handlers/comments";
import { fetchPullRequestDiff, fetchIssue, fetchIssueComments } from "./issue-fetching";
import { pullReadmeFromRepoForIssue, splitKey } from "./issue";

export async function formatChatHistory(
  context: Context,
  streamlined: Record<string, StreamlinedComment[]>,
  specAndBodies: Record<string, string>
): Promise<string[]> {
  const keys = new Set([...Object.keys(streamlined), ...Object.keys(specAndBodies), createKey(context.payload.issue.html_url)]);
  let runningTokenCount = 0;

  const chatHistory = await Promise.all(
    Array.from(keys).map(async (key) => {
      const [currentTokenCount, result] = await createContextBlockSection({
        context,
        key,
        streamlined,
        specAndBodies,
        isCurrentIssue: key === createKey(context.payload.issue.html_url),
        currentContextTokenCount: runningTokenCount,
      });
      runningTokenCount += currentTokenCount;
      return result;
    })
  );

  return Array.from(new Set(chatHistory));
}

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
  currentContextTokenCount,
}: {
  context: Context;
  key: string;
  streamlined: Record<string, StreamlinedComment[]>;
  specAndBodies: Record<string, string>;
  isCurrentIssue: boolean;
  currentContextTokenCount: number;
}): Promise<[number, string]> {
  let comments = streamlined[key];
  if (!comments || comments.length === 0) {
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

  const prDiff = await fetchPullRequestDiff(context, org, repo, issueNumber);

  let specOrBody = specAndBodies[key];
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

  const specHeader = getCorrectHeaderString(prDiff, isCurrentIssue, false);
  const blockHeader = getCorrectHeaderString(prDiff, isCurrentIssue, true);

  const specBlock = [createHeader(specHeader, key), createSpecOrBody(specOrBody), createFooter(specHeader, key)];
  const commentSection = createComment({ issueNumber, repo, org, comments }, specOrBody);

  let block;
  if (commentSection) {
    block = [specBlock.join("\n"), createHeader(blockHeader, key), commentSection, createFooter(blockHeader, key)];
  } else {
    // in this scenario we have no task/PR conversation, just the spec
    block = [specBlock.join("\n")];
  }

  // only inject the README if this is the current issue as that's likely most relevant
  if (isCurrentIssue) {
    const readme = await pullReadmeFromRepoForIssue({ context, owner: org, repo });
    if (readme) {
      const readmeBlock = readme ? [createHeader("README", key), createSpecOrBody(readme), createFooter("README", key)] : [];
      block = block.concat(readmeBlock);
    }
  }

  if (!prDiff) {
    currentContextTokenCount += await context.adapters.openai.completions.findTokenLength(block.join(""));
    return [currentContextTokenCount, block.join("\n")];
  }

  const blockWithDiff = [block.join("\n"), createHeader(`Pull Request Diff`, key), prDiff, createFooter(`Pull Request Diff`, key)];
  currentContextTokenCount += await context.adapters.openai.completions.findTokenLength(blockWithDiff.join(""));
  return [currentContextTokenCount, blockWithDiff.join("\n")];
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
    return "";
  }

  const seen = new Set<number>();
  comment.comments = comment.comments.filter((c) => {
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
