import { VoyageAIClient } from "voyageai";
import { Context } from "../../../types";
import { SimilarIssue, SimilarComment } from "../../../types/github-types";
import { SuperVoyage } from "./voyage";

interface DocumentWithMetadata {
  document: string;
  metadata: {
    type: "issue" | "comment";
    originalData: SimilarIssue | SimilarComment;
  };
}

export class Rerankers extends SuperVoyage {
  protected context: Context;

  constructor(client: VoyageAIClient, context: Context) {
    super(client, context);
    this.context = context;
  }

  async reRankResults(results: string[], query: string, topK: number = 5): Promise<string[]> {
    let response;
    try {
      response = await this.client.rerank({
        query,
        documents: results,
        model: "rerank-2",
        returnDocuments: true,
        topK,
      });
    } catch (e: unknown) {
      this.context.logger.error("Reranking failed!", { e });
      return results;
    }
    const rerankedResults = response.data || [];
    return rerankedResults.map((result) => result.document).filter((document): document is string => document !== undefined);
  }

  async reRankSimilarContent(
    query: string,
    similarIssues: SimilarIssue[],
    similarComments: SimilarComment[],
    topK: number = 5
  ): Promise<{ similarIssues: SimilarIssue[]; similarComments: SimilarComment[] }> {
    try {
      // Prepare documents for reranking
      const issueDocuments: DocumentWithMetadata[] = similarIssues.map((issue) => ({
        document: issue.body || "",
        metadata: { type: "issue", originalData: issue },
      }));

      const commentDocuments: DocumentWithMetadata[] = similarComments.map((comment) => ({
        document: comment.body || "",
        metadata: { type: "comment", originalData: comment },
      }));

      const allDocuments = [...issueDocuments, ...commentDocuments].filter((doc) => doc.document);

      if (allDocuments.length === 0) {
        return { similarIssues, similarComments };
      }

      // Rerank all documents together
      const response = await this.client.rerank({
        query,
        documents: allDocuments.map((doc) => doc.document),
        model: "rerank-2",
        returnDocuments: true,
        topK: Math.min(topK, allDocuments.length),
      });

      const rerankedResults = response.data || [];

      // Separate and reconstruct the reranked issues and comments
      const rerankedIssues: SimilarIssue[] = [];
      const rerankedComments: SimilarComment[] = [];

      rerankedResults.forEach((result, index) => {
        const originalDoc = allDocuments[index];
        if (originalDoc.metadata.type === "issue") {
          rerankedIssues.push(originalDoc.metadata.originalData as SimilarIssue);
        } else {
          rerankedComments.push(originalDoc.metadata.originalData as SimilarComment);
        }
      });

      return {
        similarIssues: rerankedIssues,
        similarComments: rerankedComments,
      };
    } catch (e: unknown) {
      this.context.logger.error("Reranking similar content failed!", { e });
      return { similarIssues, similarComments };
    }
  }
}
