import { Context } from "../types";
import { StreamlinedComment, TokenLimits } from "../types/llm";
import { fetchIssueComments } from "./issue-fetching";
import { splitKey } from "./issue";
import { logger } from "./errors";
import { Issue } from "../types/github-types";
import { updateTokenCount, createDefaultTokenLimits } from "./token-utils";

interface TreeNode {
  key: string;
  issue: Issue;
  children: TreeNode[];
  parent?: TreeNode;
  depth: number;
  comments?: StreamlinedComment[];
  body?: string;
  similarIssues?: Issue[];
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

  // Split content into lines and identify code blocks
  const lines = body.split("\n");
  let isInsideCodeBlock = false;
  let isInsideQuote = false;

  function addValidReference(key: string, context: { isInsideCodeBlock: boolean; isInsideQuote: boolean }) {
    // Skip references from code blocks and quoted text
    if (context.isInsideCodeBlock || context.isInsideQuote) {
      return;
    }

    key = key.replace(/[[]]/g, "");
    if (!validateGitHubKey(key)) {
      return;
    }
    if (!processedRefs.has(key)) {
      processedRefs.add(key);
      links.add(key);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code blocks
    if (line.trim().startsWith("```")) {
      isInsideCodeBlock = !isInsideCodeBlock;
      continue;
    }

    // Track quoted text
    if (line.trim().startsWith(">")) {
      isInsideQuote = true;
    } else if (line.trim() === "") {
      isInsideQuote = false;
    }

    const context = { isInsideCodeBlock, isInsideQuote };

    // Only process lines that aren't in code blocks or quotes
    if (!isInsideCodeBlock && !isInsideQuote) {
      // Match standalone issue numbers (not in URLs or cross-repo references)
      const numberRefs = line.match(/(?:^|\s)#(\d+)(?=[\s,.!?]|$)/g) || [];
      for (const ref of numberRefs) {
        const number = ref.trim().substring(1);
        if (/^\d+$/.test(number)) {
          const key = `${owner}/${repo}/${number}`;
          addValidReference(key, context);
        }
      }

      // Match closing keywords only at start of lines or after common punctuation
      const resolveRefs = line.match(/(?:^|\.|,|\s)(?:Resolves|Closes|Fixes)\s+#(\d+)(?=[\s,.!?]|$)/gi) || [];
      for (const ref of resolveRefs) {
        const number = ref.split("#")[1];
        if (/^\d+$/.test(number)) {
          const key = `${owner}/${repo}/${number}`;
          addValidReference(key, context);
        }
      }

      // Match full GitHub URLs with stricter boundaries
      const urlMatches = line.match(/(?:^|\s)https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(issues|pull)\/(\d+)(?:#[^/\s]*)?(?=[\s,.!?]|$)/g) || [];
      for (const url of urlMatches) {
        const info = extractGitHubInfo(url.trim());
        if (info) {
          const key = `${info.owner}/${info.repo}/${info.number}`;
          addValidReference(key, context);
        }
      }

      // Match cross-repo references with stricter boundaries
      const crossRepoMatches = line.match(/(?:^|\s)([^/\s]+)\/([^/\s#]+)#(\d+)(?=[\s,.!?]|$)/g) || [];
      for (const ref of crossRepoMatches) {
        const parts = ref.trim().match(/([^/\s]+)\/([^/\s#]+)#(\d+)/);
        if (parts) {
          const key = `${parts[1]}/${parts[2]}/${parts[3]}`;
          if (validateGitHubKey(key)) {
            addValidReference(key, context);
          }
        }
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
  const mainIssueKey = `${context.payload.repository.owner.login}/${context.payload.repository.name}/${context.payload.issue.number}`;
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
      logger.info(`Skip ${key} - max depth/already processing`);
      return processedNodes.get(key) || null;
    }

    if (processedNodes.has(key)) {
      logger.info(`Return cached node: ${key}`);
      return processedNodes.get(key) || null;
    }

    if (linkedIssueKeys.has(key)) {
      logger.info(`Skip ${key} - already linked`);
      return null;
    }

    if (failedFetches.has(key)) {
      logger.info(`Skip ${key} - previous fetch failed`);
      return null;
    }

    processingStack.add(key);

    try {
      const [owner, repo, issueNum] = splitKey(key);
      const response = await fetchIssueComments({ context, owner, repo, issueNum: parseInt(issueNum) }, tokenLimit);
      logger.info(`Tokens: ${tokenLimit.runningTokenCount}/${tokenLimit.tokensRemaining}`);
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
        const childNode = await createNode(ref, depth + 1); // Recursively create child nodes untill max depth is reached
        logger.info(`Created child node for ${ref}`);
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

  // Process body if exists and within token limits
  if (node.body?.trim()) {
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
        const commentLine = `${childPrefix}${commentPrefix}issuecomment-${comment.id}: ${comment.user}: ${comment.body.trim()}`;

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

export async function formatChatHistory(context: Context, maxDepth: number = 2): Promise<string[]> {
  const specAndBodies: Record<string, string> = {};
  const tokenLimits = createDefaultTokenLimits(context);

  const { tree } = await buildTree(context, specAndBodies, maxDepth, tokenLimits);
  if (!tree) {
    return ["No main issue found."];
  }

  const treeOutput: string[] = [];
  const headerLine = "Issue Tree Structure:";
  treeOutput.push(headerLine, "");

  await processTreeNode(tree, "", treeOutput, tokenLimits);
  logger.info(`Final tokens: ${tokenLimits.runningTokenCount}/${tokenLimits.tokensRemaining}`);

  return treeOutput;
}
