import { RestEndpointMethodTypes } from "@octokit/rest";
import { Context } from "./context";

type BaseIssue = RestEndpointMethodTypes["issues"]["get"]["response"]["data"];
export interface Issue extends BaseIssue {
  prDetails?: PullRequestDetails;
}

export type User = RestEndpointMethodTypes["users"]["getByUsername"]["response"]["data"];

export type FetchParams = {
  context: Context;
  issueNum?: number;
  owner?: string;
  repo?: string;
  currentDepth?: number; // Current depth in the tree
  maxDepth?: number; // Maximum depth to traverse
  parentIssueKey?: string; // Parent issue key (Tree structure)
};

type Repository = {
  owner: {
    login: string;
  };
  name: string;
};

type IssueData = {
  number: number;
  url: string;
  body: string;
  repository: Repository;
};

type PullRequestNode = {
  id: string;
  body: string;
  closingIssuesReferences: {
    nodes: IssueData[];
  };
};

type PullRequestReviewCommentNode = {
  id: string;
  body: string;
  pullRequest: PullRequestNode;
};

type IssueCommentNode = {
  id: string;
  body: string;
  issue: IssueData;
};

export type GqlIssueSearchResult = {
  node: IssueData;
};

export type GqlPullRequestSearchResult = {
  node: PullRequestNode;
};

export type GqlPullRequestReviewCommentSearchResult = {
  node: PullRequestReviewCommentNode;
};

export type GqlIssueCommentSearchResult = {
  node: IssueCommentNode;
};

export interface PullRequestDetails {
  diff: string | null;
}

export interface LinkedIssues {
  issueNumber: number;
  repo: string;
  owner: string;
  url: string;
  comments?: SimplifiedComment[] | null | undefined;
  body: string | undefined | null;
  prDetails?: PullRequestDetails;
  readme?: string;
  referenceType?: "closing" | "depends" | "direct";
}

export type SimplifiedComment = {
  user: Partial<User> | null;
  body: string | undefined | null;
  id: string;
  org: string;
  repo: string;
  issueUrl: string;
  referencedCode?: {
    content: string;
    startLine: number;
    endLine: number;
    path: string;
  };
  commentType?: "issue_comment" | "pull_request_review_comment";
};

export type FetchedCodes = {
  body: string | undefined;
  user: Partial<User> | null;
  issueUrl: string;
  id: string;
  org: string;
  repo: string;
  issueNumber: number;
};

export interface SimilarIssue extends LinkedIssues {
  similarity: number;
  text_similarity: number;
  issue_id: string;
}

export interface SimilarComment extends SimplifiedComment {
  similarity: number;
  text_similarity: number;
  comment_id: string;
  comment_issue_id: string;
}

export interface TreeNode {
  issue: LinkedIssues;
  children: string[];
  depth: number;
  parent?: string;
  status: "pending" | "processed" | "error";
  errorReason?: string;
  metadata: {
    processedAt: Date;
    fetchDuration?: number;
    commentCount: number;
    linkedIssuesCount: number;
    hasCodeReferences: boolean;
    similarIssues?: SimilarIssue[];
    similarComments?: SimilarComment[];
  };
}

export interface TreeProcessingQueue {
  key: string;
  depth: number;
  parent?: string;
  priority: number;
}

export interface IssueSearchResult {
  node: {
    id: string;
    number: number;
    body: string;
    repository: Repository;
    title: string;
    url: string;
    author: {
      login: string;
    };
    comments: {
      nodes: Array<{
        id: string;
        body: string;
        author: {
          login: string;
        };
      }>;
    };
  };
}

export interface CommentIssueSearchResult {
  node: {
    id: string;
    body: string;
    author: {
      login: string;
    };
    issue?: {
      id: string;
      number: number;
      title: string;
      url: string;
      repository: {
        name: string;
        owner: {
          login: string;
        };
      };
    };
    pullRequest?: {
      id: string;
      number: number;
      title: string;
      url: string;
      repository: {
        name: string;
        owner: {
          login: string;
        };
      };
    };
  };
}
