import { createKey } from "../handlers/comments";
import { FetchParams } from "../types/github-types";
import { StreamlinedComment } from "../types/llm";
import { idIssueFromComment, mergeStreamlinedComments, splitKey } from "./issue";
import { fetchLinkedIssues, fetchIssue, fetchAndHandleIssue, mergeCommentsAndFetchSpec } from "./issue-fetching";

export async function handleIssue(params: FetchParams, streamlinedComments: Record<string, StreamlinedComment[]>, alreadySeen: Set<string>) {
  if (alreadySeen.has(createKey(`${params.owner}/${params.repo}/${params.issueNum}`))) {
    return;
  }
  const { linkedIssues, seen, specAndBodies, streamlinedComments: streamlined } = await fetchLinkedIssues(params);
  const fetchPromises = linkedIssues.map(async (linkedIssue) => await mergeCommentsAndFetchSpec(params, linkedIssue, streamlinedComments, specAndBodies, seen));
  await throttlePromises(fetchPromises, 10);
  return mergeStreamlinedComments(streamlinedComments, streamlined);
}

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

export async function handleSpecAndBodyKeys(keys: string[], params: FetchParams, streamlinedComments: Record<string, StreamlinedComment[]>, seen: Set<string>) {
  // Make one last sweep just to be sure we have everything
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
