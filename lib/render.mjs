import MarkdownIt from "markdown-it";

// Comment bodies come from people and agents, not trusted files, so raw HTML stays escaped.
const commentMd = new MarkdownIt({ html: false, linkify: true, breaks: true });
commentMd.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

/** A comment's Markdown as HTML, safe to put in the page. */
export function renderCommentBody(text) {
  return commentMd.render(text);
}
