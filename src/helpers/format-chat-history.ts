import { Context } from "../types";
import { StreamlinedComment, TokenLimits } from "../types/llm";
import { fetchIssueComments } from "./issue-fetching";
import { splitKey } from "./issue";
import { logger } from "./errors";
import { Issue } from "../types/github-types";
import { updateTokenCount, createDefaultTokenLimits } from "./token-utils";

import { SimilarIssue, SimilarComment } from "../types/github-types";

interface TreeNode {
  key: string;
  issue: Issue;
  children: TreeNode[];
  parent?: TreeNode;
  depth: number;
  comments?: StreamlinedComment[];
  body?: string;
  similarIssues?: SimilarIssue[];
  similarComments?: SimilarComment[];
  codeSnippets?: { body: string; path: string }[];
  readmeSection?: string;
}

function validateGitHubKey(key: string): boolean {
  const parts = key.split("/");

  if (parts.length !== 3) return false;

  const [owner, repo, number] = parts;

  if (!owner || owner === "issues" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/i.test(owner)) {
    return false;
  }

  if (!repo || !/^[a-zA-Z0-9-_]+$/i.test(repo)) {
    return false;
  }

  return /^\d+$/.test(number);
}

function extractGitHubInfo(url: string): { owner: string; repo: string; number: string } | null {
  try {
    const urlMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)\/(issues|pull)\/(\d+)/);
    if (urlMatch) {
      return {
        owner: urlMatch[1],
        repo: urlMatch[2],
        number: urlMatch[4],
      };
    }

    const repoMatch = url.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/);
    if (repoMatch) {
      return {
        owner: repoMatch[1],
        repo: repoMatch[2],
        number: repoMatch[3],
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function extractReferencedIssuesAndPrs(body: string, owner: string, repo: string): Promise<string[]> {
  const links = new Set<string>();
  const processedRefs = new Set<string>();

  function addValidReference(key: string) {
    key = key.replace(/[[]]/g, "");

    if (!validateGitHubKey(key)) {
      return;
    }
    if (!processedRefs.has(key)) {
      processedRefs.add(key);
      links.add(key);
    }
  }

  const numberRefs = body.match(/(?:^|\s)#(\d+)(?:\s|$)/g) || [];
  for (const ref of numberRefs) {
    const number = ref.trim().substring(1);
    if (/^\d+$/.test(number)) {
      const key = `${owner}/${repo}/${number}`;
      addValidReference(key);
    }
  }

  const resolveRefs = body.match(/(?:Resolves|Closes|Fixes)\s+#(\d+)/gi) || [];
  for (const ref of resolveRefs) {
    const number = ref.split("#")[1];
    if (/^\d+$/.test(number)) {
      const key = `${owner}/${repo}/${number}`;
      addValidReference(key);
    }
  }

  const urlMatches = body.match(/https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)(?:#[^/\s]*)?/g) || [];
  for (const url of urlMatches) {
    const info = extractGitHubInfo(url);
    if (info) {
      const key = `${info.owner}/${info.repo}/${info.number}`;
      addValidReference(key);
    }
  }

  const crossRepoMatches = body.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/g) || [];
  for (const ref of crossRepoMatches) {
    const parts = ref.match(/([^/\s]+)\/([^/\s#]+)#(\d+)/);
    if (parts) {
      const key = `${parts[1]}/${parts[2]}/${parts[3]}`;
      if (validateGitHubKey(key)) {
        addValidReference(key);
      }
    }
  }

  return Array.from(links);
}

// Builds a tree by recursively fetching linked issues and PRs up to a certain depth
async function buildTree(
  context: Context,
  specAndBodies: Record<string, string>,
  maxDepth: number = 2,
  tokenLimit: TokenLimits
): Promise<{ tree: TreeNode | null }> {
  const processedNodes = new Map<string, TreeNode>();
  // Extract issue/PR number based on payload type
  let issueNumber;
  if ("issue" in context.payload) {
    issueNumber = context.payload.issue.number;
  } else if ("pull_request" in context.payload) {
    issueNumber = context.payload.pull_request.number;
  } else {
    issueNumber = undefined;
  }
  if (!issueNumber) {
    logger.error("Could not determine issue/PR number from payload", { payload: context.payload });
    return { tree: null };
  }

  const mainIssueKey = `${context.payload.repository.owner.login}/${context.payload.repository.name}/${issueNumber}`;
  const linkedIssueKeys = new Set<string>();
  const failedFetches = new Set<string>();
  const processingStack = new Set<string>();

  if (!validateGitHubKey(mainIssueKey)) {
    logger.error(`Invalid main issue key: ${mainIssueKey}`);
    return { tree: null };
  }

  async function createNode(key: string, depth: number = 0): Promise<TreeNode | null> {
    // Early return checks to prevent unnecessary processing
    if (depth > maxDepth || processingStack.has(key)) {
      // Processing stack is used to prevent infinite loops
      logger.debug(`Skip ${key} - max depth/already processing`);
      return processedNodes.get(key) || null;
    }

    if (processedNodes.has(key)) {
      logger.debug(`Return cached node: ${key}`);
      return processedNodes.get(key) || null;
    }

    if (linkedIssueKeys.has(key)) {
      logger.debug(`Skip ${key} - already linked`);
      return null;
    }

    if (failedFetches.has(key)) {
      logger.debug(`Skip ${key} - previous fetch failed`);
      return null;
    }

    processingStack.add(key);

    try {
      const [owner, repo, issueNum] = splitKey(key);
      const response = await fetchIssueComments({ context, owner, repo, issueNum: parseInt(issueNum) }, tokenLimit);
      const issue = response.issue;

      if (!issue) {
        failedFetches.add(key);
        return null;
      }

      const node: TreeNode = {
        key,
        issue,
        children: [],
        depth,
        comments: response.comments.map((comment) => ({
          ...comment,
          user: comment.user?.login || undefined,
          body: comment.body || undefined,
        })),
        body: specAndBodies[key] || issue.body || undefined,
      };

      processedNodes.set(key, node);
      linkedIssueKeys.add(key);

      const references = new Set<string>();

      // Helper function to validate and add references
      const validateAndAddReferences = async (text: string) => {
        const refs = await extractReferencedIssuesAndPrs(text, owner, repo);
        refs.forEach((ref) => {
          if (validateGitHubKey(ref) && !linkedIssueKeys.has(ref) && !processedNodes.has(ref) && !processingStack.has(ref)) {
            references.add(ref);
          }
        });
      };

      // Process body references
      if (node.body) {
        await validateAndAddReferences(node.body);
      }

      // Process comment references
      if (node.comments) {
        for (const comment of node.comments) {
          if (comment.body) {
            await validateAndAddReferences(comment.body);
          }
        }
      }

      // Process valid references
      for (const ref of references) {
        //Uses references found so far to create child nodes
        const childNode = await createNode(ref, depth + 1); // Recursively create child nodes until max depth is reached
        logger.debug(`Created child node for ${ref}`);
        if (childNode) {
          childNode.parent = node;
          node.children.push(childNode);
        }
      }
      return node;
    } catch (error) {
      failedFetches.add(key);
      logger.error(`Error creating node for ${key}: ${error}`);
      return null;
    } finally {
      processingStack.delete(key);
    }
  }

  try {
    const tree = await createNode(mainIssueKey);
    console.log(`Map size: ${JSON.stringify(Array.from(processedNodes.keys()))}`);
    return { tree };
  } catch (error) {
    logger.error("Error building tree", { error: error as Error });
    return { tree: null };
  }
}

async function processTreeNode(node: TreeNode, prefix: string, output: string[], tokenLimits: TokenLimits): Promise<void> {
  // Create header
  const typeStr = node.issue.pull_request ? "PR" : "Issue";
  const headerLine = `${prefix}${node.parent ? "└── " : ""}${typeStr} #${node.issue.number} (${node.issue.html_url})`;

  if (!updateTokenCount(headerLine, tokenLimits)) {
    return;
  }
  output.push(headerLine);

  const childPrefix = prefix + (node.parent ? "    " : "");
  const contentPrefix = childPrefix + "    ";

  // Process body and similar content for root node
  if (!node.parent) {
    // Process body if exists
    if (node.body?.trim()) {
      const bodyContent = formatContent("Body", node.body, childPrefix, contentPrefix, tokenLimits);
      if (bodyContent.length > 0) {
        output.push(...bodyContent);
        output.push("");
      }
    }

    // Process similar issues
    if (node.similarIssues?.length) {
      output.push(`${childPrefix}Similar Issues:`);
      for (const issue of node.similarIssues) {
        const line = `${contentPrefix}- Issue #${issue.issueNumber} (${issue.url}) - Similarity: ${(issue.similarity * 100).toFixed(2)}%`;
        if (!updateTokenCount(line, tokenLimits)) break;
        output.push(line);

        if (issue.body) {
          const bodyLine = `${contentPrefix}  ${issue.body.split("\n")[0]}...`;
          if (!updateTokenCount(bodyLine, tokenLimits)) break;
          output.push(bodyLine);
        }
      }
      output.push("");
    }

    // Process similar comments
    if (node.similarComments?.length) {
      output.push(`${childPrefix}Similar Comments:`);
      for (const comment of node.similarComments) {
        const line = `${contentPrefix}- Comment by ${comment.user?.login} - Similarity: ${(comment.similarity * 100).toFixed(2)}%`;
        if (!updateTokenCount(line, tokenLimits)) break;
        output.push(line);

        if (comment.body) {
          const bodyLine = `${contentPrefix}  ${comment.body.split("\n")[0]}...`;
          if (!updateTokenCount(bodyLine, tokenLimits)) break;
          output.push(bodyLine);
        }
      }
      output.push("");
    }
  } else if (node.body?.trim()) {
    // Process body for non-root nodes
    const bodyContent = formatContent("Body", node.body, childPrefix, contentPrefix, tokenLimits);
    if (bodyContent.length > 0) {
      output.push(...bodyContent);
      output.push("");
    }
  }

  // Process PR details if available
  if (node.issue.prDetails) {
    const { diff } = node.issue.prDetails;

    // Add diff information
    if (diff) {
      const diffContent = formatContent("Diff", diff, childPrefix, contentPrefix, tokenLimits);
      if (diffContent.length > 0) {
        output.push(...diffContent);
        output.push("");
      }
    }
  }

  // Process comments if any
  if (node.comments?.length) {
    const commentsHeader = `${childPrefix}Comments: ${node.comments.length}`;
    if (updateTokenCount(commentsHeader, tokenLimits)) {
      output.push(commentsHeader);

      for (let i = 0; i < node.comments.length; i++) {
        const comment = node.comments[i];
        if (!comment.body?.trim()) continue;

        const commentPrefix = i === node.comments.length - 1 ? "└── " : "├── ";
        let commentLine = `${childPrefix}${commentPrefix}${comment.commentType || "issuecomment"}-${comment.id}: ${comment.user}: ${comment.body.trim()}`;

        // Add referenced code for PR review comments if available
        if (comment.commentType === "pull_request_review_comment" && comment.referencedCode) {
          const lineNumbers = `Lines ${comment.referencedCode.startLine}-${comment.referencedCode.endLine}:`;
          const codePath = `Referenced code in ${comment.referencedCode.path}:`;
          const content = comment.referencedCode.content.split("\n");
          const indentedContent = content.map((line) => childPrefix + "    " + line).join("\n");
          const codeLines = [childPrefix + "    " + codePath, childPrefix + "    " + lineNumbers, childPrefix + "    " + indentedContent];

          if (!updateTokenCount(codeLines.join("\n"), tokenLimits)) {
            break;
          }
          commentLine = `${commentLine}\n${codeLines.join("\n")}`;
        }

        if (!updateTokenCount(commentLine, tokenLimits)) {
          break;
        }
        output.push(commentLine);
      }
      output.push("");
    }
  }

  // Process children
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLast = i === node.children.length - 1;
    const nextPrefix = childPrefix + (isLast ? "    " : "│   ");
    await processTreeNode(child, nextPrefix, output, tokenLimits);
  }
}

function formatContent(type: string, content: string, prefix: string, contentPrefix: string, tokenLimits: TokenLimits): string[] {
  const output: string[] = [];
  const header = `${prefix}${type}:`;

  if (!updateTokenCount(header, tokenLimits)) {
    return output;
  }
  output.push(header);

  const lines = content.trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;

    const formattedLine = `${contentPrefix}${line.trim()}`;
    if (!updateTokenCount(formattedLine, tokenLimits)) {
      break;
    }
    output.push(formattedLine);
  }

  return output;
}

export async function buildChatHistoryTree(context: Context, maxDepth: number = 2): Promise<{ tree: TreeNode | null; tokenLimits: TokenLimits }> {
  const specAndBodies: Record<string, string> = {};
  const tokenLimits = createDefaultTokenLimits(context);
  const { tree } = await buildTree(context, specAndBodies, maxDepth, tokenLimits);

  if (tree && "pull_request" in context.payload) {
    const { diff_hunk, position, original_position, path, body } = context.payload.comment || {};
    if (diff_hunk) {
      tree.body += `\nPrimary Context: ${body || ""}\nDiff: ${diff_hunk}\nPath: ${path || ""}\nLines: ${position || ""}-${original_position || ""}`;
      tree.comments = tree.comments?.filter((comment) => comment.id !== context.payload.comment?.id);
    }
  }

  return { tree, tokenLimits };
}

export async function formatChatHistory(
  context: Context,
  maxDepth: number = 2,
  availableTokens?: number,
  similarIssues?: SimilarIssue[],
  similarComments?: SimilarComment[]
): Promise<string[]> {
  const { tree, tokenLimits } = await buildChatHistoryTree(context, maxDepth);

  if (!tree) {
    return ["No main issue found."];
  }

  // If availableTokens is provided, override the default tokensRemaining
  if (availableTokens !== undefined) {
    tokenLimits.tokensRemaining = availableTokens;
  }

  // Add similar issues and comments to the tree
  if (similarIssues?.length) {
    tree.similarIssues = similarIssues;
  }
  if (similarComments?.length) {
    tree.similarComments = similarComments;
  }

  const treeOutput: string[] = [];
  const headerLine = "Issue Tree Structure:";
  treeOutput.push(headerLine, "");

  await processTreeNode(tree, "", treeOutput, tokenLimits);
  logger.debug(`Final tokens: ${tokenLimits.runningTokenCount}/${tokenLimits.tokensRemaining}`);
  return treeOutput;
}
