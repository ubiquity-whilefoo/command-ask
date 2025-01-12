import { createKey } from "../handlers/comments";
import { FetchParams, User, LinkedIssues } from "../types/github-types";
import { StreamlinedComment, TokenLimits } from "../types/llm";
import {
  idIssueFromComment,
  mergeStreamlinedComments,
  splitKey,
  fetchSimilarIssues,
  fetchCodeLinkedFromIssue,
  pullReadmeFromRepoForIssue,
  fetchLinkedIssuesFromComment,
} from "./issue";
import { recursivelyFetchLinkedIssues, mergeCommentsAndFetchSpec, fetchIssueComments } from "./issue-fetching";
import { encode } from "gpt-tokenizer";

const UNKNOWN_ERROR = "An unknown error occurred during promise throttling";

function createStreamlinedComment(params: {
  id: string | number;
  body: string;
  user: Partial<User> | null | string;
  org: string;
  repo: string;
  issueUrl: string;
}): StreamlinedComment {
  return {
    id: params.id,
    user: typeof params.user === "string" ? params.user : params.user?.login,
    body: params.body,
    org: params.org,
    repo: params.repo,
    issueUrl: params.issueUrl,
  };
}

function updateTokenCount(text: string, tokenLimits: TokenLimits): void {
  const tokenCount = encode(text, { disallowedSpecial: new Set() }).length;
  tokenLimits.runningTokenCount += tokenCount;
  tokenLimits.tokensRemaining = tokenLimits.modelMaxTokenLimit - tokenLimits.maxCompletionTokens - tokenLimits.runningTokenCount;
}

function createDefaultTokenLimits(params: FetchParams): TokenLimits {
  return {
    modelMaxTokenLimit: params.context.adapters.openai.completions.getModelMaxTokenLimit(params.context.config.model),
    maxCompletionTokens: params.context.config.maxTokens,
    runningTokenCount: 0,
    tokensRemaining: 0,
  };
}

interface CodeSnippet {
  id: string;
  body?: string;
  org: string;
  repo: string;
  issueUrl: string;
}

async function throttlePromises(promises: Promise<void>[], limit: number): Promise<void> {
  const executing = new Set<Promise<void>>();
  const allPromises: Promise<void>[] = [];

  try {
    for (const promise of promises) {
      const wrappedPromise = Promise.resolve(promise).finally(() => {
        executing.delete(wrappedPromise);
      });

      // Add to our sets
      executing.add(wrappedPromise);
      allPromises.push(wrappedPromise);

      // If we're at the limit, wait for one to finish
      if (executing.size >= limit) {
        await Promise.race(Array.from(executing));
      }
    }

    // Wait for all promises to complete
    await Promise.all(allPromises);
  } catch (error) {
    throw error instanceof Error ? error : new Error("An unknown error occurred during promise throttling");
  }
}

export async function handleIssue(
  params: FetchParams,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  alreadySeen: Set<string>,
  parentKey?: string,
  tokenLimits?: TokenLimits
): Promise<Record<string, StreamlinedComment[]> | void> {
  const currentKey = `${params.owner}/${params.repo}/${params.issueNum}`;
  if (alreadySeen.has(currentKey)) {
    return;
  }

  try {
    // Mark this issue as seen
    alreadySeen.add(currentKey);

    const currentTokenLimits = tokenLimits || createDefaultTokenLimits(params);

    const {
      linkedIssues = [] as LinkedIssues[],
      specAndBodies,
      streamlinedComments: fetchedComments = Object.create(null) as Record<string, StreamlinedComment[]>,
      issueTree,
    } = await recursivelyFetchLinkedIssues({
      ...params,
      parentIssueKey: parentKey,
    });

    // Get seen keys from issueTree
    const seen = new Set(Object.keys(issueTree || {}));

    // Only fetch similar issues and README for the main issue (no parent key)
    if (!parentKey) {
      const issueBody = params.context.payload.issue?.body || "";
      const similarIssues = await fetchSimilarIssues(params.context, issueBody);
      const readmeSection = await pullReadmeFromRepoForIssue(params);

      params.context.logger.info(`Fetched ${similarIssues.length} similar issues and README section for ${currentKey}`);

      // Fetch Similar Comments
      const similarIssuesFromComment = await fetchLinkedIssuesFromComment(params.context, issueBody, params);

      // Add similar issues at the 0th level
      linkedIssues.push(...similarIssues, ...similarIssuesFromComment);

      // Add README content as a top-level comment if relevant
      if (readmeSection) {
        updateTokenCount(readmeSection, currentTokenLimits);

        if (!fetchedComments[currentKey]) {
          fetchedComments[currentKey] = [];
        }

        fetchedComments[currentKey].push(
          createStreamlinedComment({
            id: "readme-section",
            body: `Relevant README section:\n${readmeSection}`,
            user: params.context.payload.sender,
            org: params.owner || "",
            repo: params.repo || "",
            issueUrl: params.context.payload.issue?.html_url || "",
          })
        );
      }
    }

    // Merge seen keys to maintain global reference tracking
    seen.forEach((seenKey) => alreadySeen.add(seenKey));

    // Process each linked issue while maintaining the relationship to the current issue
    const fetchPromises = linkedIssues.map(async (linkedIssue: LinkedIssues) => {
      const linkedKey = createKey(linkedIssue.url, linkedIssue.issueNumber);
      if (alreadySeen.has(linkedKey)) {
        return;
      }
      return await mergeCommentsAndFetchSpec(
        {
          ...params,
          parentIssueKey: currentKey,
        },
        linkedIssue,
        fetchedComments,
        specAndBodies,
        alreadySeen
      );
    });

    await throttlePromises(fetchPromises, 10);
    return mergeStreamlinedComments(streamlinedComments, fetchedComments);
  } catch (error) {
    params.context.logger.error(`Error handling issue ${currentKey}: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`);
    throw error;
  }
}

export async function handleSpec(
  params: FetchParams,
  specOrBody: string,
  specAndBodies: Record<string, string>,
  key: string,
  seen: Set<string>,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  tokenLimits?: TokenLimits
): Promise<Record<string, string>> {
  if (seen.has(key)) {
    return specAndBodies;
  }

  try {
    const currentTokenLimits = tokenLimits || createDefaultTokenLimits(params);
    updateTokenCount(specOrBody, currentTokenLimits);

    specAndBodies[key] = specOrBody;
    const otherReferences = idIssueFromComment(specOrBody, params);

    if (otherReferences) {
      for (const ref of otherReferences) {
        const anotherKey = `${ref.owner}/${ref.repo}/${ref.issueNumber}`;
        if (seen.has(anotherKey)) {
          continue;
        }

        try {
          seen.add(anotherKey);
          // Fetch full issue content including comments and PR details
          const {
            issue: fetchedIssue,
            comments,
            linkedIssues: fetchedLinkedIssues,
          } = await fetchIssueComments(
            {
              ...params,
              owner: ref.owner,
              repo: ref.repo,
              issueNum: ref.issueNumber,
              currentDepth: (params.currentDepth || 0) + 1,
            },
            currentTokenLimits
          );

          if (!fetchedIssue?.body) {
            params.context.logger.error(`No body found for issue ${anotherKey}`);
            continue;
          }

          updateTokenCount(fetchedIssue.body, currentTokenLimits);
          specAndBodies[anotherKey] = fetchedIssue.body;

          // Convert and store comments in streamlinedComments
          if (comments && comments.length > 0) {
            if (!streamlinedComments[anotherKey]) {
              streamlinedComments[anotherKey] = [];
            }
            const convertedComments = comments.map((comment) =>
              createStreamlinedComment({
                id: comment.id,
                body: comment.body || "",
                user: comment.user,
                org: comment.org,
                repo: comment.repo,
                issueUrl: comment.issueUrl,
              })
            );
            streamlinedComments[anotherKey].push(...convertedComments);
          }

          // Process any linked issues found in the fetched issue
          if (fetchedLinkedIssues && fetchedLinkedIssues.length > 0) {
            for (const linkedIssue of fetchedLinkedIssues) {
              const linkedKey = `${linkedIssue.owner}/${linkedIssue.repo}/${linkedIssue.issueNumber}`;
              if (!seen.has(linkedKey)) {
                seen.add(linkedKey);
                await handleIssue(
                  {
                    ...params,
                    owner: linkedIssue.owner,
                    repo: linkedIssue.repo,
                    issueNum: linkedIssue.issueNumber,
                    currentDepth: (params.currentDepth || 0) + 2,
                  },
                  streamlinedComments,
                  seen,
                  anotherKey,
                  currentTokenLimits
                );
              }
            }
          }
        } catch (error) {
          params.context.logger.error(`Error fetching issue ${anotherKey}: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`);
        }
      }
    }
    return specAndBodies;
  } catch (error) {
    params.context.logger.error(`Error handling spec for ${key}: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`);
    throw error;
  }
}

export async function handleComment(
  params: FetchParams,
  comment: StreamlinedComment,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  seen: Set<string>,
  parentKey: string,
  tokenLimits?: TokenLimits
): Promise<void> {
  try {
    const commentBody = comment.body || "";
    const currentTokenLimits = tokenLimits || createDefaultTokenLimits(params);

    updateTokenCount(commentBody, currentTokenLimits);

    const otherReferences = idIssueFromComment(commentBody, params);

    // Only fetch code snippets for comments (no similar issues)
    let codeSnippets: CodeSnippet[] = [];
    try {
      codeSnippets = await fetchCodeLinkedFromIssue(commentBody, params.context, comment.issueUrl);
    } catch (error) {
      params.context.logger.error(`Failed to fetch code snippets: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`);
    }

    // Add code snippets as comments if found
    if (codeSnippets.length > 0) {
      const commentKey = `${params.owner}/${params.repo}/${params.issueNum}`;
      if (!streamlinedComments[commentKey]) {
        streamlinedComments[commentKey] = [];
      }

      codeSnippets.forEach((snippet) => {
        if (snippet.body) {
          updateTokenCount(snippet.body, currentTokenLimits);
        }

        streamlinedComments[commentKey].push(
          createStreamlinedComment({
            id: `code-${snippet.id}`,
            body: `Code from ${snippet.id}:\n\`\`\`\n${snippet.body || ""}\n\`\`\``,
            user: params.context.payload.sender,
            org: snippet.org,
            repo: snippet.repo,
            issueUrl: snippet.issueUrl,
          })
        );
      });
    }

    if (otherReferences) {
      for (const ref of otherReferences) {
        const key = `${ref.owner}/${ref.repo}/${ref.issueNumber}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        if (!streamlinedComments[key]) {
          await handleIssue(
            { ...params, owner: ref.owner, repo: ref.repo, issueNum: ref.issueNumber },
            streamlinedComments,
            seen,
            parentKey,
            currentTokenLimits
          );
        }
      }
    }
  } catch (error) {
    params.context.logger.error(`Error handling comment: ${error instanceof Error ? error.message : UNKNOWN_ERROR}`);
    throw error;
  }
}

export async function handleSpecAndBodyKeys(
  keys: string[],
  params: FetchParams,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  seen: Set<string>,
  tokenLimits?: TokenLimits
): Promise<void> {
  const currentTokenLimits = tokenLimits || createDefaultTokenLimits(params);

  const commentProcessingPromises = keys.map(async (key) => {
    if (seen.has(key)) {
      return;
    }

    const [owner, repo, issueNum] = splitKey(key);
    let comments = streamlinedComments[key];
    if (!comments || comments.length === 0) {
      await handleIssue({ ...params, owner, repo, issueNum: parseInt(issueNum) }, streamlinedComments, seen, key, currentTokenLimits);
      comments = streamlinedComments[key] || [];
    }

    for (const comment of comments) {
      await handleComment(params, comment, streamlinedComments, seen, key, currentTokenLimits);
    }
  });

  await throttlePromises(commentProcessingPromises, 10);
}
