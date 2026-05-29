// Text module imports bundled by Wrangler's default Text rule (**/*.html and
// **/*.txt). The viewer page and its script are embedded into the Worker
// exactly like the Go binary embeds them with `//go:embed`.
declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.txt" {
  const content: string;
  export default content;
}
