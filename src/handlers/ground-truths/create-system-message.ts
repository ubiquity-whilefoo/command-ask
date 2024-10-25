export function createGroundTruthSysMsg({ truthRules, example, conditions }: { truthRules: string[]; example: string[]; conditions?: string[] }) {
  return `
Using the input provided, your goal is to produce an array of strings that represent "Ground Truths."
These ground truths are high-level abstractions that encapsulate the tech stack and dependencies of the repository.
  
Each ground truth should:
- ${truthRules.join("\n- ")}
  
Example:
${example.join("\n")}
  
${conditions ? `Conditions:\n${conditions.join("\n")}` : ""}
  
Generate similar ground truths adhering to a maximum of 10.
  
Return a JSON parsable array of strings representing the ground truths, without comment or directive.`;
}
