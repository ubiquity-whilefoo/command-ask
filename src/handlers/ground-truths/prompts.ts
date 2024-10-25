import { GroundTruthsSystemMessageTemplate, ModelApplications } from "../../types/llm";

const CODE_REVIEW_GROUND_TRUTHS_SYSTEM_MESSAGE = {
  example: [
    `Using the input provided, your goal is to produce an array of strings that represent "Ground Truths."
        These ground truths are high-level abstractions that encapsulate the key aspects of the task.
        They serve to guide and inform our code review model's interpretation of the task by providing clear, concise, and explicit insights.
        
        Each ground truth should:
        - Be succinct and easy to understand.
        - Directly pertain to the task at hand.
        - Focus on essential requirements, behaviors, or assumptions involved in the task.
    
        Example:
        Task: Implement a function that adds two numbers.
        Ground Truths:
        - The function should accept two numerical inputs.
        - The function should return the sum of the two inputs.
        - Inputs must be validated to ensure they are numbers.
        
        Based on the given task, generate similar ground truths adhering to a maximum of 10.
        
        Return a JSON parsable array of strings representing the ground truths, without comment or directive.`,
  ],
  truthRules: [],
  conditions: [],
};

const CHAT_BOT_GROUND_TRUTHS_SYSTEM_MESSAGE = {
  truthRules: [
    "Be succinct and easy to understand.",
    "Use only the information provided in the input.",
    "Focus on essential requirements, behaviors, or assumptions involved in the repository.",
  ],
  example: [
    "Languages: { TypeScript: 60%, JavaScript: 15%, HTML: 10%, CSS: 5%, ... }",
    "Dependencies: Esbuild, Wrangler, React, Tailwind CSS, ms, React-carousel, React-icons, ...",
    "Dev Dependencies: @types/node, @types/jest, @mswjs, @testing-library/react, @testing-library/jest-dom, @Cypress ...",
    "Ground Truths:",
    "- The repo predominantly uses TypeScript, with JavaScript, HTML, and CSS also present.",
    "- The repo is a React project that uses Tailwind CSS.",
    "- The project is built with Esbuild and deployed with Wrangler, indicating a Cloudflare Workers project.",
    "- The repo tests use Jest, Cypress, mswjs, and React Testing Library.",
  ],
  conditions: [
    "Assume your output builds the foundation for a chatbot to understand the repository when asked an arbitrary query.",
    "Do not list every language or dependency, focus on the most prevalent ones.",
    "Focus on what is essential to understand the repository at a high level.",
    "Brevity is key. Use zero formatting. Do not wrap in quotes, backticks, or other characters.",
    `response === ["some", "array", "of", "strings"]`,
  ],
};

export const GROUND_TRUTHS_SYSTEM_MESSAGES: Record<ModelApplications, GroundTruthsSystemMessageTemplate> = {
  "code-review": CODE_REVIEW_GROUND_TRUTHS_SYSTEM_MESSAGE,
  "chat-bot": CHAT_BOT_GROUND_TRUTHS_SYSTEM_MESSAGE,
} as const;
