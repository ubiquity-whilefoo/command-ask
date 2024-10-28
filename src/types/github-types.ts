import { RestEndpointMethodTypes } from "@octokit/rest";
import { Context } from "./context";

export type Issue = RestEndpointMethodTypes["issues"]["get"]["response"]["data"];
export type IssueComments = RestEndpointMethodTypes["issues"]["listComments"]["response"]["data"][0];
export type ReviewComments = RestEndpointMethodTypes["pulls"]["listReviewComments"]["response"]["data"][0];
export type User = RestEndpointMethodTypes["users"]["getByUsername"]["response"]["data"];

//Modify the Issue add User Type
export type IssueWithUser = Issue & { user: Partial<User> | null };

export type FetchParams = {
  context: Context;
  issueNum?: number;
  owner?: string;
  repo?: string;
};

export type LinkedIssues = {
  issueNumber: number;
  repo: string;
  owner: string;
  url: string;
  comments?: SimplifiedComment[] | null | undefined;
  body: string | undefined;
};

export type SimplifiedComment = {
  user: Partial<User> | null;
  body: string | undefined;
  id: string;
  org: string;
  repo: string;
  issueUrl: string;
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

export type FetchedPulls = {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  url: string;
};

export type LinkedPullsToIssue = {
  repository: {
    issue: {
      closedByPullRequestsReferences: {
        nodes: FetchedPulls[];
      };
    };
  };
};
