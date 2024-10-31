import { createKey, getAllStreamlinedComments } from "../handlers/comments";
import { Context } from "../types";
import { IssueComments, FetchParams, Issue, LinkedIssues, LinkedPullsToIssue, ReviewComments, SimplifiedComment } from "../types/github-types";
import { StreamlinedComment } from "../types/llm";
import { logger } from "./errors";
import { dedupeStreamlinedComments, fetchCodeLinkedFromIssue, idIssueFromComment, mergeStreamlinedComments, splitKey } from "./issue";
import { handleIssue, handleSpec, handleSpecAndBodyKeys, throttlePromises } from "./issue-handling";

/**
 * Recursively fetches linked issues and processes them, including fetching comments and specifications.
 *
 * @param params - The parameters required to fetch the linked issues, including context and other details.
 * @returns A promise that resolves to an object containing linked issues, specifications, streamlined comments, and seen issue keys.
 */
export async function recursivelyFetchLinkedIssues(params: FetchParams) {
  const { linkedIssues, seen, specAndBodies, streamlinedComments } = await fetchLinkedIssues(params);
  const fetchPromises = linkedIssues.map(async (linkedIssue) => await mergeCommentsAndFetchSpec(params, linkedIssue, streamlinedComments, specAndBodies, seen));
  await throttlePromises(fetchPromises, 10);
  const linkedIssuesKeys = linkedIssues.map((issue) => createKey(`${issue.owner}/${issue.repo}/${issue.issueNumber}`));
  const specAndBodyKeys = Array.from(new Set([...Object.keys(specAndBodies), ...Object.keys(streamlinedComments), ...linkedIssuesKeys]));
  await handleSpecAndBodyKeys(specAndBodyKeys, params, dedupeStreamlinedComments(streamlinedComments), seen);
  return { linkedIssues, specAndBodies, streamlinedComments };
}

/**
 * Fetches linked issues recursively and processes them.
 *
 * @param params - The parameters required to fetch the linked issues, including context and other details.
 * @returns A promise that resolves to an object containing linked issues, specifications, streamlined comments, and seen issue keys.
 */
export async function fetchLinkedIssues(params: FetchParams) {
  const { comments, issue } = await fetchIssueComments(params);
  if (!issue) {
    return { streamlinedComments: {}, linkedIssues: [], specAndBodies: {}, seen: new Set<string>() };
  }

  if (!params.owner || !params.repo) {
    throw logger.error("Owner or repo not found");
  }

  const issueKey = createKey(issue.html_url);
  const [owner, repo, issueNumber] = splitKey(issueKey);
  const linkedIssues: LinkedIssues[] = [{ body: issue.body || "", comments, issueNumber: parseInt(issueNumber), owner, repo, url: issue.html_url }];
  const specAndBodies: Record<string, string> = {};
  const seen = new Set<string>([issueKey]);

  comments.push({
    body: issue.body || "",
    user: issue.user,
    id: issue.id.toString(),
    org: params.owner,
    repo: params.repo,
    issueUrl: issue.html_url,
  });

  for (const comment of comments) {
    const foundIssues = idIssueFromComment(comment.body, params);
    const foundCodes = comment.body ? await fetchCodeLinkedFromIssue(comment.body, params.context, comment.issueUrl) : [];
    if (foundIssues) {
      for (const linkedIssue of foundIssues) {
        const linkedKey = createKey(linkedIssue.url, linkedIssue.issueNumber);
        if (seen.has(linkedKey)) continue;

        seen.add(linkedKey);
        const { comments: fetchedComments, issue: fetchedIssue } = await fetchIssueComments({
          context: params.context,
          issueNum: linkedIssue.issueNumber,
          owner: linkedIssue.owner,
          repo: linkedIssue.repo,
        });

        if (!fetchedIssue || !fetchedIssue.body) {
          continue;
        }

        specAndBodies[linkedKey] = fetchedIssue?.body;
        linkedIssue.body = fetchedIssue?.body;
        linkedIssue.comments = fetchedComments;
        linkedIssues.push(linkedIssue);
      }
    }

    if (foundCodes) {
      for (const code of foundCodes) {
        comments.push({
          body: code.body,
          user: code.user,
          id: code.id,
          org: code.org,
          repo: code.repo,
          issueUrl: code.issueUrl,
        });
      }
    }
  }

  const streamlinedComments = await getAllStreamlinedComments(linkedIssues);
  return { streamlinedComments, linkedIssues, specAndBodies, seen };
}

/**
 * Merges comments and fetches the specification for a linked issue.
 *
 * @param params - The parameters required to fetch the linked issue, including context and other details.
 * @param linkedIssue - The linked issue for which comments and specifications need to be fetched.
 * @param streamlinedComments - A record of streamlined comments associated with issues.
 * @param specOrBodies - A record of specifications or bodies associated with issues.
 * @param seen - A set of issue keys that have already been processed to avoid duplication.
 */
export async function mergeCommentsAndFetchSpec(
  params: FetchParams,
  linkedIssue: LinkedIssues,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  specOrBodies: Record<string, string>,
  seen: Set<string>
) {
  if (linkedIssue.comments) {
    const streamed = await getAllStreamlinedComments([linkedIssue]);
    const merged = mergeStreamlinedComments(streamlinedComments, streamed);
    streamlinedComments = { ...streamlinedComments, ...merged };
  }

  if (linkedIssue.body) {
    await handleSpec(params, linkedIssue.body, specOrBodies, createKey(linkedIssue.url, linkedIssue.issueNumber), seen, streamlinedComments);
  }
}

export async function fetchPullRequestDiff(context: Context, org: string, repo: string, issue: number) {
  const { octokit } = context;

  try {
    const diff = await octokit.pulls.get({
      owner: org,
      repo,
      pull_number: issue,
      mediaType: {
        format: "diff",
      },
    });
    return diff.data as unknown as string;
  } catch (e) {
    return null;
  }
}

/**
 * Fetches an issue from the GitHub API.
 * @param params - Context
 * @returns A promise that resolves to an issue object or null if an error occurs.
 */
export async function fetchIssue(params: FetchParams): Promise<Issue | null> {
  const { octokit, payload, logger } = params.context;
  const { issueNum, owner, repo } = params;
  try {
    const response = await octokit.rest.issues.get({
      owner: owner || payload.repository.owner.login,
      repo: repo || payload.repository.name,
      issue_number: issueNum || payload.issue.number,
    });
    return response.data;
  } catch (error) {
    logger.error(`Error fetching issue`, {
      err: error,
      owner: owner || payload.repository.owner.login,
      repo: repo || payload.repository.name,
      issue_number: issueNum || payload.issue.number,
    });
    return null;
  }
}

/**
 * Fetches the comments for a given issue or pull request.
 *
 * @param params - The parameters required to fetch the issue comments, including context and other details.
 * @returns A promise that resolves to an object containing the issue and its comments.
 */
export async function fetchIssueComments(params: FetchParams) {
  const { octokit, payload, logger } = params.context;
  const { issueNum, owner, repo } = params;
  const issue = await fetchIssue(params);
  let reviewComments: ReviewComments[] = [];
  let issueComments: IssueComments[] = [];
  try {
    if (issue?.pull_request) {
      const response = await octokit.rest.pulls.listReviewComments({
        owner: owner || payload.repository.owner.login,
        repo: repo || payload.repository.name,
        pull_number: issueNum || payload.issue.number,
      });
      reviewComments = response.data;

      const response2 = await octokit.rest.issues.listComments({
        owner: owner || payload.repository.owner.login,
        repo: repo || payload.repository.name,
        issue_number: issueNum || payload.issue.number,
      });

      issueComments = response2.data;
    } else {
      const response = await octokit.rest.issues.listComments({
        owner: owner || payload.repository.owner.login,
        repo: repo || payload.repository.name,
        issue_number: issueNum || payload.issue.number,
      });
      issueComments = response.data;
    }
  } catch (e) {
    logger.error(`Error fetching comments `, {
      e,
      owner: owner || payload.repository.owner.login,
      repo: repo || payload.repository.name,
      issue_number: issueNum || payload.issue.number,
    });
  }
  const comments = [...issueComments, ...reviewComments].filter((comment) => comment.user?.type !== "Bot");
  const simplifiedComments = castCommentsToSimplifiedComments(comments, params);

  return {
    issue,
    comments: simplifiedComments,
  };
}

/**
 * Fetches and handles an issue based on the provided key and parameters.
 *
 * @param key - The unique key representing the issue in the format "owner/repo/issueNumber".
 * @param params - The parameters required to fetch the issue, including context and other details.
 * @param streamlinedComments - A record of streamlined comments associated with issues.
 * @param seen - A set of issue keys that have already been processed to avoid duplication.
 * @returns A promise that resolves to an array of streamlined comments for the specified issue.
 */
export async function fetchAndHandleIssue(
  key: string,
  params: FetchParams,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  seen: Set<string>
): Promise<StreamlinedComment[]> {
  const [owner, repo, issueNumber] = splitKey(key);
  const issueParams = { ...params, owner, repo, issueNum: parseInt(issueNumber) };
  await handleIssue(issueParams, streamlinedComments, seen);
  return streamlinedComments[key] || [];
}

function castCommentsToSimplifiedComments(comments: (IssueComments | ReviewComments)[], params: FetchParams): SimplifiedComment[] {
  if (!comments) {
    return [];
  }

  return comments
    .filter((comment) => comment.body !== undefined)
    .map((comment) => {
      if ("pull_request_review_id" in comment) {
        return {
          body: comment.body,
          user: comment.user,
          id: comment.id.toString(),
          org: params.owner || params.context.payload.repository.owner.login,
          repo: params.repo || params.context.payload.repository.name,
          issueUrl: comment.html_url,
        };
      }

      if ("html_url" in comment) {
        return {
          body: comment.body,
          user: comment.user,
          id: comment.id.toString(),
          org: params.owner || params.context.payload.repository.owner.login,
          repo: params.repo || params.context.payload.repository.name,
          issueUrl: comment.html_url,
        };
      }

      throw logger.error("Comment type not recognized", { comment, params });
    });
}

export async function fetchLinkedPullRequests(owner: string, repo: string, issueNumber: number, context: Context) {
  const query = `
    query($owner: String!, $repo: String!, $issueNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $issueNumber) {
          closedByPullRequestsReferences(first: 100) {
            nodes {
              number
              title
              state
              merged
              url
            }
          }
        }
      }
    }
  `;

  try {
    const { repository } = await context.octokit.graphql<LinkedPullsToIssue>(query, {
      owner,
      repo,
      issueNumber,
    });
    return repository.issue.closedByPullRequestsReferences.nodes;
  } catch (error) {
    context.logger.error(`Error fetching linked PRs from issue`, {
      err: error,
      owner,
      repo,
      issueNumber,
    });
    return null;
  }
}
