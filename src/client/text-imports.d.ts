// Markdown files the client imports as text (`import x from "./file.md" with { type: "text" }`; Bun's bundler inlines them).
declare module "*.md" {
  const text: string;
  export default text;
}
// Binary assets the client imports as files (`import url from "./file.glb" with { type: "file" }`): Bun's bundler copies
// them into dist/ under a content-hashed name and gives their path.
declare module "*.glb" {
  const path: string;
  export default path;
}
