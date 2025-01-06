import { Context } from "../types";
import { FetchParams, SimplifiedComment } from "../types/github-types";
import { logger } from "./errors";

interface PullRequestGraphQlResponse {
  repository: {
    pullRequest: {
      body: string;
      closingIssuesReferences: {
        nodes: Array<{
          number: number;
          url: string;
          body: string;
          repository: {
            owner: {
              login: string;
            };
            name: string;
          };
        }>;
      };
      reviews: {
        nodes: Array<{
          comments: {
            nodes: Array<{
              id: string;
              body: string;
              user: {
                login: string;
                type: string;
              };
            }>;
          };
        }>;
      };
      comments: {
        nodes: Array<{
          id: string;
          body: string;
          user: {
            login: string;
            type: string;
          };
        }>;
      };
    };
  };
}

interface PullRequestLinkedIssue {
  number: number;
  owner: string;
  repo: string;
  url: string;
  body: string;
}

/**
 * Fetch both PR review comments and regular PR comments
 */
export async function fetchPullRequestComments(params: FetchParams) {
  const { octokit } = params.context;
  const { owner, repo, issueNum } = params;

  try {
    // Fetch PR data including both types of comments
    const prData = await octokit.graphql<PullRequestGraphQlResponse>(
      `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            body
            closingIssuesReferences(first: 10) {
              nodes {
                number
                url
                body
                repository {
                  owner {
                    login
                  }
                  name
                }
              }
            }
            reviews(first: 100) {
              nodes {
                comments(first: 100) {
                  nodes {
                    id
                    body
                    user {
                      login
                      type
                    }
                  }
                }
              }
            }
            comments(first: 100) {
              nodes {
                id
                body
                user {
                  login
                  type
                }
              }
            }
          }
        }
      }
    `,
      {
        owner,
        repo,
        number: issueNum,
      }
    );

    const allComments: SimplifiedComment[] = [];
    const linkedIssues: PullRequestLinkedIssue[] = [];

    // Process PR comments
    if (prData.repository.pullRequest.comments.nodes) {
      for (const comment of prData.repository.pullRequest.comments.nodes) {
        if (comment.user.type !== "Bot") {
          allComments.push({
            body: comment.body,
            user: {
              login: comment.user.login,
              type: comment.user.type,
            },
            id: comment.id,
            org: owner || "",
            repo: repo || "",
            issueUrl: `https://github.com/${owner}/${repo}/pull/${issueNum}`,
          });
        }
      }
    }

    // Process review comments
    if (prData.repository.pullRequest.reviews.nodes) {
      for (const review of prData.repository.pullRequest.reviews.nodes) {
        for (const comment of review.comments.nodes) {
          if (comment.user.type !== "Bot") {
            allComments.push({
              body: comment.body,
              user: {
                login: comment.user.login,
                type: comment.user.type,
              },
              id: comment.id,
              org: owner || "",
              repo: repo || "",
              issueUrl: `https://github.com/${owner}/${repo}/pull/${issueNum}`,
            });
          }
        }
      }
    }

    // Process linked issues
    if (prData.repository.pullRequest.closingIssuesReferences.nodes) {
      for (const issue of prData.repository.pullRequest.closingIssuesReferences.nodes) {
        linkedIssues.push({
          number: issue.number,
          owner: issue.repository.owner.login,
          repo: issue.repository.name,
          url: issue.url,
          body: issue.body,
        });
      }
    }

    return { comments: allComments, linkedIssues };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Error fetching PR comments", { stack: err.stack });
    return { comments: [], linkedIssues: [] };
  }
}

export async function fetchPullRequestDetails(context: Context, org: string, repo: string, issue: number) {
  try {
    // Fetch diff
    const diffResponse = await context.octokit.rest.pulls.get({
      owner: org,
      repo,
      pull_number: issue,
      mediaType: { format: "diff" },
    });
    const diff = diffResponse.data as unknown as string;

    // Fetch files
    const filesResponse = await context.octokit.rest.pulls.listFiles({
      owner: org,
      repo,
      pull_number: issue,
    });

    const files = await Promise.all(
      filesResponse.data.map(async (file) => {
        let diffContent = file.patch || "";

        if (!diffContent && file.status !== "removed") {
          try {
            const fileResponse = await context.octokit.rest.repos.getContent({
              owner: org,
              repo,
              path: file.filename,
              ref: file.sha,
            });

            if ("content" in fileResponse.data) {
              const content = Buffer.from(fileResponse.data.content, "base64").toString();
              diffContent = content;
            }
          } catch (e) {
            logger.error(`Error fetching file content`, { file: file.filename, err: String(e) });
          }
        }

        return {
          filename: file.filename,
          diffContent,
          status: file.status as "added" | "modified" | "deleted",
        };
      })
    );

    return {
      diff,
      files,
    };
  } catch (e) {
    logger.error(`Error fetching PR details`, { owner: org, repo, issue, err: String(e) });
    return { diff: null };
  }
}
