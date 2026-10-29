// Markdown files the client imports as text (`import x from "./file.md" with { type: "text" }`; Bun's bundler inlines them).
declare module "*.md" {
  const text: string;
  export default text;
}
