import { createKey } from "../handlers/comments";
import { FetchParams } from "../types/github-types";
import { StreamlinedComment } from "../types/llm";
import { idIssueFromComment, mergeStreamlinedComments, splitKey } from "./issue";
import { fetchLinkedIssues, fetchIssue, fetchAndHandleIssue, mergeCommentsAndFetchSpec } from "./issue-fetching";

/**
 * Handles the processing of an issue.
 *
 * @param params - The parameters required to fetch and handle issues.
 * @param streamlinedComments - A record of streamlined comments indexed by keys.
 * @param alreadySeen - A set of keys that have already been processed to avoid duplication.
 * @returns A promise that resolves when the issue has been handled.
 */
export async function handleIssue(params: FetchParams, streamlinedComments: Record<string, StreamlinedComment[]>, alreadySeen: Set<string>) {
  if (alreadySeen.has(createKey(`${params.owner}/${params.repo}/${params.issueNum}`))) {
    return;
  }
  const { linkedIssues, seen, specAndBodies, streamlinedComments: streamlined } = await fetchLinkedIssues(params);
  const fetchPromises = linkedIssues.map(async (linkedIssue) => await mergeCommentsAndFetchSpec(params, linkedIssue, streamlinedComments, specAndBodies, seen));
  await throttlePromises(fetchPromises, 10);
  return mergeStreamlinedComments(streamlinedComments, streamlined);
}

/**
 * Handles the processing of a specification or body text.
 *
 * @param params - The parameters required to fetch and handle issues.
 * @param specOrBody - The specification or body text to be processed.
 * @param specAndBodies - A record of specifications and bodies indexed by keys.
 * @param key - The key associated with the current specification or body.
 * @param seen - A set of keys that have already been processed to avoid duplication.
 * @param streamlinedComments - A record of streamlined comments indexed by keys.
 * @returns A promise that resolves to the updated record of specifications and bodies.
 */
export async function handleSpec(
  params: FetchParams,
  specOrBody: string,
  specAndBodies: Record<string, string>,
  key: string,
  seen: Set<string>,
  streamlinedComments: Record<string, StreamlinedComment[]>
) {
  specAndBodies[key] = specOrBody;
  const otherReferences = idIssueFromComment(specOrBody, params);
  if (otherReferences) {
    for (const ref of otherReferences) {
      const anotherKey = createKey(ref.url, ref.issueNumber);
      if (seen.has(anotherKey)) {
        return;
      }
      seen.add(anotherKey);
      const issue = await fetchIssue({
        ...params,
        owner: ref.owner,
        repo: ref.repo,
        issueNum: ref.issueNumber,
      });
      if (!issue?.body) {
        return;
      }

      if (issue?.body) {
        specAndBodies[anotherKey] = issue.body;
      }
      const [owner, repo, issueNum] = splitKey(anotherKey);
      if (!streamlinedComments[anotherKey]) {
        await handleIssue({ ...params, owner, repo, issueNum: parseInt(issueNum) }, streamlinedComments, seen);
        await handleSpec({ ...params, owner, repo, issueNum: parseInt(issueNum) }, issue?.body, specAndBodies, anotherKey, seen, streamlinedComments);
      }
    }
  }
  return specAndBodies;
}

/**
 * Handles the processing of a comment.
 *
 * @param params - The parameters required to fetch and handle issues.
 * @param comment - The comment to be processed.
 * @param streamlinedComments - A record of streamlined comments indexed by keys.
 * @param seen - A set of keys that have already been processed to avoid duplication.
 */
export async function handleComment(
  params: FetchParams,
  comment: StreamlinedComment,
  streamlinedComments: Record<string, StreamlinedComment[]>,
  seen: Set<string>
) {
  const otherReferences = idIssueFromComment(comment.body, params);
  if (otherReferences) {
    for (const ref of otherReferences) {
      const key = createKey(ref.url);
      const [refOwner, refRepo, refIssueNumber] = splitKey(key);

      if (!streamlinedComments[key]) {
        await handleIssue({ ...params, owner: refOwner, repo: refRepo, issueNum: parseInt(refIssueNumber) }, streamlinedComments, seen);
      }
    }
  }
}

/**
 * Handles the processing of specification and body keys.
 *
 * @param keys - An array of keys representing issues or comments to be processed.
 * @param params - The parameters required to fetch and handle issues.
 * @param streamlinedComments - A record of streamlined comments indexed by keys.
 * @param seen - A set of keys that have already been processed to avoid duplication.
 */
export async function handleSpecAndBodyKeys(keys: string[], params: FetchParams, streamlinedComments: Record<string, StreamlinedComment[]>, seen: Set<string>) {
  const commentProcessingPromises = keys.map(async (key) => {
    let comments = streamlinedComments[key];
    if (!comments || comments.length === 0) {
      comments = await fetchAndHandleIssue(key, params, streamlinedComments, seen);
    }

    for (const comment of comments) {
      await handleComment(params, comment, streamlinedComments, seen);
    }
  });
  await throttlePromises(commentProcessingPromises, 10);
}

/**
 * Throttles the execution of promises to ensure that no more than the specified limit are running concurrently.
 *
 * @param promises - An array of promises to be executed.
 * @param limit - The maximum number of promises to run concurrently.
 */
export async function throttlePromises(promises: Promise<void>[], limit: number) {
  const executing: Promise<void>[] = [];
  for (const promise of promises) {
    const p = promise.then(() => {
      void executing.splice(executing.indexOf(p), 1);
    });
    executing.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
