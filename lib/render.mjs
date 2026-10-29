import MarkdownIt from "markdown-it";
import { extractBlocks } from "./blocks.mjs";

// Comment bodies and descriptions come from people and agents, not trusted files, so raw HTML stays escaped.
const commentMd = new MarkdownIt({ html: false, linkify: true, breaks: true });
const descriptionMd = new MarkdownIt({ html: false, linkify: true });

for (const md of [commentMd, descriptionMd]) {
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
    return self.renderToken(tokens, idx, options);
  };
}

/** A comment's Markdown as HTML, safe to put in the page. */
export function renderCommentBody(text) {
  return commentMd.render(text);
}

/**
 * A description's commentable blocks (lib/blocks.mjs), indexed like the
 * data-block tags renderDescription puts in its HTML.
 */
export function parseBlocks(src) {
  return extractBlocks(descriptionMd.parse(src, {}));
}

/** A description's first paragraph as inline HTML, for a branch's line in its stack's overview; or null. */
export function summarizeDescription(src) {
  const first = parseBlocks(src).find((b) => b.kind === "paragraph");
  return first ? descriptionMd.renderInline(first.text) : null;
}

/** A description's Markdown as HTML, safe to put in the page, with each block's element tagged data-block="<index>". */
export function renderDescription(src) {
  const tokens = descriptionMd.parse(src, {});
  extractBlocks(tokens);
  return descriptionMd.renderer.render(tokens, descriptionMd.options, {});
}
