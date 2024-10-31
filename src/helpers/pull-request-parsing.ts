import { encode } from "gpt-tokenizer";
import { TokenLimits } from "../types/llm";
import { logger } from "./errors";
import { EncodeOptions } from "gpt-tokenizer/esm/GptEncoding";

export async function processPullRequestDiff(diff: string, tokenLimits: TokenLimits) {
  const { runningTokenCount, tokensRemaining } = tokenLimits;

  const perFileDiffs = parsePerFileDiffs(diff);

  const essentialFileDiffs = perFileDiffs.filter(({ filename }) => {
    return isEssentialFile(filename);
  });

  const estimatedFileDiffStats = essentialFileDiffs.map(({ filename, diffContent }) => {
    const estimatedTokenCount = Math.ceil(diffContent.length / 3.5);
    return { filename, estimatedTokenCount, diffContent };
  });

  estimatedFileDiffStats.sort((a, b) => a.estimatedTokenCount - b.estimatedTokenCount); // Smallest first

  let currentTokenCount = runningTokenCount;
  const includedFileDiffs = [];

  for (const file of estimatedFileDiffStats) {
    if (currentTokenCount + file.estimatedTokenCount > tokensRemaining) {
      logger.info(`Skipping ${file.filename} to stay within token limits.`);
      continue;
    }
    includedFileDiffs.push(file);
    currentTokenCount += file.estimatedTokenCount;
  }

  if (includedFileDiffs.length === 0) {
    logger.error(`Cannot include any files from diff without exceeding token limits.`);
    return { diff: null };
  }

  const accurateFileDiffStats = await Promise.all(
    includedFileDiffs.map(async (file) => {
      const tokenCountArray = await encodeAsync(file.diffContent, { disallowedSpecial: new Set() });
      const tokenCount = tokenCountArray.length;
      return { ...file, tokenCount };
    })
  );

  currentTokenCount = accurateFileDiffStats.reduce((sum, file) => sum + file.tokenCount, runningTokenCount);

  while (currentTokenCount > tokensRemaining && accurateFileDiffStats.length > 0) {
    const removedFile = accurateFileDiffStats.pop();
    currentTokenCount -= removedFile?.tokenCount || 0;
    logger.info(`Excluded ${removedFile?.filename || "Unknown filename"} after accurate token count exceeded limits.`);
  }

  if (accurateFileDiffStats.length === 0) {
    logger.error(`Cannot include any files from diff after accurate token count calculation.`);
    return { diff: null };
  }

  const currentDiff = accurateFileDiffStats.map((file) => file.diffContent).join("\n");

  return { diff: currentDiff };
}

export async function encodeAsync(text: string, options: EncodeOptions): Promise<number[]> {
  return new Promise((resolve) => {
    const result = encode(text, options);
    resolve(result);
  });
}

export function parsePerFileDiffs(diff: string): { filename: string; diffContent: string }[] {
  const diffPattern = /^diff --git a\/(.*?) b\/.*$/gm;
  let match: RegExpExecArray | null;
  const perFileDiffs = [];
  let lastIndex = 0;

  while ((match = diffPattern.exec(diff)) !== null) {
    const filename = match[1];
    const startIndex = match.index;

    if (perFileDiffs.length > 0) {
      perFileDiffs[perFileDiffs.length - 1].diffContent = diff.substring(lastIndex, startIndex).trim();
    }
    perFileDiffs.push({ filename, diffContent: "" });
    lastIndex = startIndex;
  }
  if (perFileDiffs.length > 0 && lastIndex < diff.length) {
    perFileDiffs[perFileDiffs.length - 1].diffContent = diff.substring(lastIndex).trim();
  }

  return perFileDiffs;
}

function isEssentialFile(filename: string): boolean {
  const nonEssentialExtensions = [
    // Image files
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".tiff",
    ".svg",
    ".ico",
    ".psd",
    ".ai",
    ".eps",

    // Video files
    ".mp4",
    ".avi",
    ".mov",
    ".wmv",
    ".flv",
    ".mkv",
    ".webm",
    ".mpeg",
    ".mpg",
    ".m4v",

    // Audio files
    ".mp3",
    ".wav",
    ".flac",
    ".aac",
    ".ogg",
    ".wma",
    ".m4a",
    ".aiff",
    ".ape",

    // Document files
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".odt",
    ".ods",
    ".odp",

    // Archive files
    ".zip",
    ".rar",
    ".7z",
    ".tar",
    ".gz",
    ".bz2",
    ".xz",
    ".lz",
    ".z",

    // Executable and binary files
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
    ".class",
    ".jar",
    ".war",
    ".ear",
    ".msi",
    ".apk",
    ".ipa",

    // Compiled object files
    ".o",
    ".obj",
    ".pyc",
    ".pyo",
    ".pyd",
    ".lib",
    ".a",
    ".dSYM",

    // System and temporary files
    ".sys",
    ".tmp",
    ".bak",
    ".old",
    ".swp",
    ".swo",
    ".lock",
    ".cfg",
    ".ini",

    // Database files
    ".db",
    ".sqlite",
    ".sqlite3",
    ".mdb",
    ".accdb",
    ".dbf",
    ".frm",
    ".myd",
    ".myi",

    // Font files
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".eot",

    // Backup and miscellaneous files
    ".log",
    ".bak",
    ".orig",
    ".sav",
    ".save",
    ".dump",

    // Other non-essential files
    ".crt",
    ".pem",
    ".key",
    ".csr",
    ".der", // Certificate files
    ".plist",
    ".mobileprovision", // iOS specific files
    ".icns", // macOS icon files
    ".ds_store",
    "thumbs.db",
    "desktop.ini", // System files

    // Generated files
    ".map",
    ".min.js",
    ".d.ts",
    ".map.js",
    ".map.css",
    ".bundle.js",
    ".bundle.css",
    ".bundle.js.map",
    ".bundle.css.map",
    ".bundle.min.js",
  ];

  return !nonEssentialExtensions.some((ext) => filename.toLowerCase().endsWith(ext));
}