import { FetchParams, Issue, LinkedIssues, SimplifiedComment } from "../types/github-types";
import { TokenLimits } from "../types/llm";
import { logger } from "./errors";
import { idIssueFromComment } from "./issue";
import { fetchPullRequestComments, fetchPullRequestDetails } from "./pull-request-fetching";
import { createDefaultTokenLimits } from "./token-utils";

/**
 * Create a unique key for an issue based on its URL and optional issue number
 * @param issueUrl - The URL of the issue
 * @param issue - The optional issue number
 * @returns The unique key for the issue
 */
export function createKey(issueUrl: string, issue?: number) {
  const urlParts = issueUrl.split("/");

  let key;

  // Handle PR review comment URLs which have 'pull' and 'comments' in the path
  if (urlParts.includes("pull") && urlParts.includes("comments")) {
    // Extract the PR number from the URL
    const prIndex = urlParts.indexOf("pull");
    if (prIndex >= 0 && prIndex + 1 < urlParts.length) {
      const prNumber = urlParts[prIndex + 1];
      const [, , , issueOrg, issueRepo] = urlParts;
      key = `${issueOrg}/${issueRepo}/${prNumber}`;
    }
  } else if (urlParts.length === 7) {
    const [, , , issueOrg, issueRepo, , issueNumber] = urlParts;
    key = `${issueOrg}/${issueRepo}/${issueNumber}`;
  } else if (urlParts.length === 5) {
    const [, , issueOrg, issueRepo] = urlParts;
    key = `${issueOrg}/${issueRepo}/${issue}`;
  } else if (urlParts.length === 8) {
    const [, , , issueOrg, issueRepo, , , issueNumber] = urlParts;
    key = `${issueOrg}/${issueRepo}/${issueNumber || issue}`;
  } else if (urlParts.length === 3) {
    const [issueOrg, issueRepo, issueNumber] = urlParts;
    key = `${issueOrg}/${issueRepo}/${issueNumber || issue}`;
  }

  if (!key) {
    throw logger.error("Invalid issue URL", {
      issueUrl,
      issueNumber: issue,
    });
  }

  if (key.includes("#")) {
    key = key.split("#")[0];
  }

  return key;
}

export async function fetchIssue(params: FetchParams, tokenLimits?: TokenLimits): Promise<Issue | null> {
  const { octokit, payload, logger } = params.context;
  const { issueNum, owner, repo } = params;

  // Ensure we always have valid owner and repo
  const targetOwner = owner || payload.repository.owner.login;
  const targetRepo = repo || payload.repository.name;
  const targetIssueNum = issueNum || payload.issue.number;

  try {
    const response = await octokit.rest.issues.get({
      owner: targetOwner,
      repo: targetRepo,
      issue_number: targetIssueNum,
    });

    const issue: Issue = response.data;

    // If this is a PR, fetch additional details
    if (issue.pull_request) {
      tokenLimits = tokenLimits || createDefaultTokenLimits(params.context);
      issue.prDetails = await fetchPullRequestDetails(params.context, targetOwner, targetRepo, targetIssueNum, tokenLimits);
    }

    return issue;
  } catch (error) {
    logger.error(`Error fetching issue`, {
      err: error,
      owner: targetOwner,
      repo: targetRepo,
      issue_number: targetIssueNum,
    });
    return null;
  }
}

export async function fetchIssueComments(params: FetchParams, tokenLimits?: TokenLimits) {
  const { octokit, payload, logger } = params.context;
  const { issueNum, owner, repo } = params;

  const targetOwner = owner || payload.repository.owner.login;
  const targetRepo = repo || payload.repository.name;
  const targetIssueNum = issueNum || payload.issue.number;
  const currentTokenLimits = tokenLimits || createDefaultTokenLimits(params.context);

  const issue = await fetchIssue(
    {
      ...params,
      owner: targetOwner,
      repo: targetRepo,
      issueNum: targetIssueNum,
    },
    currentTokenLimits
  );
  logger.debug(`Fetched issue #${targetIssueNum}`);

  if (!issue) {
    return { issue: null, comments: null, linkedIssues: null };
  }

  let comments: SimplifiedComment[] = [];
  const linkedIssues: LinkedIssues[] = [];

  if (issue.pull_request) {
    // For PRs, get both types of comments and linked issues
    const prData = await fetchPullRequestComments({
      ...params,
      owner: targetOwner,
      repo: targetRepo,
      issueNum: targetIssueNum,
    });

    comments = prData.comments;

    // Process linked issues from PR with their full content
    for (const linked of prData.linkedIssues) {
      // First fetch the issue/PR to determine its type
      const linkedIssue = await fetchIssue({
        ...params,
        owner: linked.owner,
        repo: linked.repo,
        issueNum: linked.number,
      });

      if (linkedIssue) {
        const linkedComments = await fetchIssueComments(
          {
            ...params,
            owner: linked.owner,
            repo: linked.repo,
            issueNum: linked.number,
            currentDepth: (params.currentDepth || 0) + 1,
          },
          currentTokenLimits
        );

        linkedIssues.push({
          issueNumber: linked.number,
          owner: linked.owner,
          repo: linked.repo,
          url: linkedIssue.html_url,
          body: linkedIssue.body,
          comments: linkedComments.comments,
          prDetails: linkedIssue.pull_request
            ? await fetchPullRequestDetails(params.context, linked.owner, linked.repo, linked.number, currentTokenLimits)
            : undefined,
        });
      }
    }
  } else {
    // For regular issues, get issue comments
    try {
      const response = await octokit.rest.issues.listComments({
        owner: targetOwner,
        repo: targetRepo,
        issue_number: targetIssueNum,
      });

      logger.debug(`Fetched comments for issue #${targetIssueNum}`);

      comments = response.data
        .filter((comment): comment is typeof comment & { body: string } => comment.user?.type !== "Bot" && typeof comment.body === "string")
        .map((comment) => ({
          body: comment.body,
          user: comment.user,
          id: comment.id.toString(),
          org: targetOwner,
          repo: targetRepo,
          issueUrl: comment.html_url,
        }));

      // Process any linked issues found in comments
      const linkedIssuesFromComments = comments
        .map((comment) => idIssueFromComment(comment.body, params))
        .filter((issues): issues is LinkedIssues[] => issues !== null)
        .flat();

      for (const linked of linkedIssuesFromComments) {
        // First fetch the issue/PR to determine its type
        const linkedIssue = await fetchIssue({
          ...params,
          owner: linked.owner,
          repo: linked.repo,
          issueNum: linked.issueNumber,
        });

        if (linkedIssue) {
          linkedIssues.push({
            ...linked,
            body: linkedIssue.body,
            prDetails: linkedIssue.pull_request
              ? await fetchPullRequestDetails(params.context, linked.owner, linked.repo, linked.issueNumber, currentTokenLimits)
              : undefined,
          });
        }
      }
    } catch (e) {
      logger.error(`Error fetching issue comments`, {
        e,
        owner: targetOwner,
        repo: targetRepo,
        issue_number: targetIssueNum,
      });
    }
  }
  logger.debug(`Processed ${comments.length} comments and ${linkedIssues.length} linked issues`);
  return { issue, comments, linkedIssues };
}
