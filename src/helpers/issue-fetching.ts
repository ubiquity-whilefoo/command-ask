import { Context } from "../types";
import { FetchParams, Issue, LinkedIssues, SimplifiedComment, PullRequestDetails, TreeNode } from "../types/github-types";
import { StreamlinedComment, TokenLimits } from "../types/llm";
import { fetchCodeLinkedFromIssue, idIssueFromComment, mergeStreamlinedComments } from "./issue";
import { handleSpec } from "./issue-handling";
import { getAllStreamlinedComments } from "../handlers/comments";
import { fetchPullRequestComments, fetchPullRequestDetails } from "./pull-request-fetching";

interface EnhancedLinkedIssues extends Omit<LinkedIssues, "prDetails"> {
  prDetails?: PullRequestDetails;
}

function createDefaultTokenLimits(context: Context): TokenLimits {
  return {
    modelMaxTokenLimit: context.adapters.openai.completions.getModelMaxTokenLimit(context.config.model),
    maxCompletionTokens: context.config.maxTokens || context.adapters.openai.completions.getModelMaxOutputLimit(context.config.model),
    runningTokenCount: 0,
    tokensRemaining: 0,
  };
}

export async function fetchIssue(params: FetchParams, tokenLimits?: TokenLimits): Promise<Issue | null> {
  const { octokit, payload, logger } = params.context;
  const { issueNum, owner, repo } = params;

  // Ensure we have valid owner and repo
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
      const currentTokenLimits = tokenLimits || createDefaultTokenLimits(params.context);
      logger.info(`Fetching PR details for ${targetOwner}/${targetRepo}#${targetIssueNum} with token limits: ${JSON.stringify(currentTokenLimits)}`);
      issue.prDetails = await fetchPullRequestDetails(params.context, targetOwner, targetRepo, targetIssueNum);
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

  if (!issue) {
    return { issue: null, comments: [], linkedIssues: [] };
  }

  let comments: SimplifiedComment[] = [];
  let linkedIssues: LinkedIssues[] = [];

  if (issue.pull_request) {
    // For PRs, get both types of comments and linked issues
    const prData = await fetchPullRequestComments({
      ...params,
      owner: targetOwner,
      repo: targetRepo,
      issueNum: targetIssueNum,
    });

    comments = prData.comments;

    // Convert PR linked issues to LinkedIssues format
    linkedIssues = prData.linkedIssues.map((linked: { number: number; owner: string; repo: string; url: string; body: string }) => ({
      issueNumber: linked.number,
      owner: linked.owner,
      repo: linked.repo,
      url: linked.url,
      body: linked.body,
      comments: [],
    }));
  } else {
    // For regular issues, get issue comments
    try {
      const response = await octokit.rest.issues.listComments({
        owner: targetOwner,
        repo: targetRepo,
        issue_number: targetIssueNum,
      });

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
    } catch (e) {
      logger.error(`Error fetching issue comments`, {
        e,
        owner: targetOwner,
        repo: targetRepo,
        issue_number: targetIssueNum,
      });
    }
  }

  return { issue, comments, linkedIssues };
}

export interface RecursiveIssueSearchResult {
  linkedIssues: LinkedIssues[];
  specAndBodies: Record<string, string>;
  streamlinedComments: Record<string, StreamlinedComment[]>;
  issueTree: Record<
    string,
    {
      issue: EnhancedLinkedIssues;
      children: string[];
      depth: number;
      parent?: string;
    }
  >;
}

function createTreeNode(issue: Issue, params: FetchParams, depth: number): TreeNode {
  return {
    issue: {
      body: issue.body || "",
      owner: params.owner || params.context.payload.repository.owner.login,
      repo: params.repo || params.context.payload.repository.name,
      issueNumber: params.issueNum || params.context.payload.issue.number,
      url: issue.html_url,
      comments: [],
      prDetails: issue.prDetails,
    },
    children: [],
    depth,
    status: "pending",
    metadata: {
      processedAt: new Date(),
      commentCount: 0,
      linkedIssuesCount: 0,
      hasCodeReferences: false,
    },
  };
}

export async function recursivelyFetchLinkedIssues(params: FetchParams): Promise<RecursiveIssueSearchResult> {
  const maxDepth = params.maxDepth || 15;

  const issueTree: Record<string, TreeNode> = {};
  const seen = new Set<string>();
  const linkedIssues: LinkedIssues[] = [];
  const specAndBodies: Record<string, string> = {};
  const streamlinedComments: Record<string, StreamlinedComment[]> = {};

  // Initialize with main issue
  const mainIssue = await fetchIssue(params);
  if (!mainIssue) {
    return { linkedIssues: [], specAndBodies: {}, streamlinedComments: {}, issueTree };
  }

  const mainIssueKey = `${params.owner || params.context.payload.repository.owner.login}/${
    params.repo || params.context.payload.repository.name
  }/${params.issueNum || params.context.payload.issue.number}`;

  // Initialize root node
  issueTree[mainIssueKey] = createTreeNode(mainIssue, params, 0);
  seen.add(mainIssueKey);
  linkedIssues.push(issueTree[mainIssueKey].issue);

  // Get initial comments and linked issues
  const { comments, linkedIssues: initialLinkedIssues } = await fetchIssueComments(params);
  if (comments) {
    issueTree[mainIssueKey].issue.comments = comments;
  }

  // Add initial linked issues from PR if any
  if (initialLinkedIssues && initialLinkedIssues.length > 0) {
    for (const linkedIssue of initialLinkedIssues) {
      const linkedKey = `${linkedIssue.owner}/${linkedIssue.repo}/${linkedIssue.issueNumber}`;
      if (!seen.has(linkedKey)) {
        seen.add(linkedKey);
        linkedIssues.push(linkedIssue);
        issueTree[mainIssueKey].children.push(linkedKey);
        issueTree[linkedKey] = {
          issue: linkedIssue,
          children: [],
          depth: 1,
          parent: mainIssueKey,
          status: "pending",
          metadata: {
            processedAt: new Date(),
            commentCount: linkedIssue.comments?.length || 0,
            linkedIssuesCount: 0,
            hasCodeReferences: false,
          },
        };
      }
    }
  }

  // Queue for breadth-first exploration of the tree
  const queue: Array<{
    key: string;
    depth: number;
    parent: string | undefined;
  }> = [
    {
      key: mainIssueKey,
      depth: 0,
      parent: undefined,
    },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) continue;

    const node = issueTree[current.key];
    if (!node) continue;

    // Process comments in the current node
    for (const comment of node.issue.comments || []) {
      if (!comment.body) continue;
      const foundIssues = idIssueFromComment(comment.body, params);
      if (foundIssues) {
        for (const foundIssue of foundIssues) {
          const foundKey = `${foundIssue.owner}/${foundIssue.repo}/${foundIssue.issueNumber}`;
          if (seen.has(foundKey)) continue;

          seen.add(foundKey);

          // Fetch the found issue and its comments
          const { issue: fetchedIssue, comments: fetchedComments } = await fetchIssueComments({
            ...params,
            owner: foundIssue.owner,
            repo: foundIssue.repo,
            issueNum: foundIssue.issueNumber,
            currentDepth: current.depth + 1,
            maxDepth,
          });

          if (!fetchedIssue || !fetchedIssue.body) continue;

          issueTree[foundKey] = {
            issue: {
              body: fetchedIssue.body,
              owner: foundIssue.owner,
              repo: foundIssue.repo,
              issueNumber: foundIssue.issueNumber,
              url: foundIssue.url,
              comments: fetchedComments,
              prDetails: fetchedIssue.pull_request ? fetchedIssue.prDetails : undefined,
            },
            children: [],
            depth: current.depth + 1,
            parent: current.key,
            status: "pending",
            metadata: {
              processedAt: new Date(),
              commentCount: fetchedComments?.length || 0,
              linkedIssuesCount: 0,
              hasCodeReferences: false,
            },
          };
          issueTree[current.key].children.push(foundKey);

          // Add to linked issues and queue for exploration
          linkedIssues.push(issueTree[foundKey].issue);
          specAndBodies[foundKey] = fetchedIssue.body;
          queue.push({
            key: foundKey,
            depth: current.depth + 1,
            parent: current.key,
          });
        }
      }

      // Process code references
      const foundCodes = await fetchCodeLinkedFromIssue(comment.body, params.context, comment.issueUrl);
      if (foundCodes) {
        for (const code of foundCodes) {
          const codeComment = {
            body: code.body,
            user: code.user,
            id: code.id,
            org: code.org,
            repo: code.repo,
            issueUrl: code.issueUrl,
          };
          if (!node.issue.comments?.some((c) => c.id === codeComment.id)) {
            node.issue.comments = [...(node.issue.comments || []), codeComment];
          }
        }
      }
    }

    // Process specs and bodies
    if (node.issue.body) {
      await handleSpec(
        {
          ...params,
          currentDepth: current.depth,
          maxDepth,
          parentIssueKey: current.parent,
        },
        node.issue.body,
        specAndBodies,
        current.key,
        seen,
        streamlinedComments
      );
    }
  }

  // Process all issues for streamlined comments
  for (const issue of linkedIssues) {
    if (issue.comments) {
      const streamed = await getAllStreamlinedComments([issue]);
      streamlinedComments[`${issue.owner}/${issue.repo}/${issue.issueNumber}`] = streamed[`${issue.owner}/${issue.repo}/${issue.issueNumber}`] || [];
    }
  }

  return { linkedIssues, specAndBodies, streamlinedComments, issueTree };
}

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
    await handleSpec(params, linkedIssue.body, specOrBodies, `${linkedIssue.owner}/${linkedIssue.repo}/${linkedIssue.issueNumber}`, seen, streamlinedComments);
  }
}
