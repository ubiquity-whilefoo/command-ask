import { Context } from "../../types";
import { logger } from "../../helpers/errors";

export async function fetchRepoDependencies(context: Context) {
  const {
    octokit,
    payload: {
      repository: {
        owner: { login: owner },
        name: repo,
      },
    },
  } = context;

  const { data: packageJson } = await octokit.repos.getContent({
    owner,
    repo,
    path: "package.json",
  });

  if ("content" in packageJson) {
    return extractDependencies(JSON.parse(Buffer.from(packageJson.content, "base64").toString()));
  } else {
    throw logger.error(`No package.json found in ${owner}/${repo}`);
  }
}

export function extractDependencies(packageJson: Record<string, Record<string, string>>) {
  const { dependencies, devDependencies } = packageJson;

  return {
    dependencies,
    devDependencies,
  };
}

export async function fetchRepoLanguageStats(context: Context) {
  const {
    octokit,
    payload: {
      repository: {
        owner: { login: owner },
        name: repo,
      },
    },
  } = context;

  const { data: languages } = await octokit.repos.listLanguages({
    owner,
    repo,
  });

  const totalBytes = Object.values(languages).reduce((acc, bytes) => acc + bytes, 0);

  const stats = Object.entries(languages).reduce(
    (acc, [language, bytes]) => {
      acc[language] = bytes / totalBytes;
      return acc;
    },
    {} as Record<string, number>
  );

  return Array.from(Object.entries(stats)).sort((a, b) => b[1] - a[1]);
}
