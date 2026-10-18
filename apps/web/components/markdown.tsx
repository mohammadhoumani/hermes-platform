"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/**
 * Renders Markdown written by an agent (the BRD). It is treated as untrusted:
 *  - raw HTML is dropped (skipHtml) and the result is sanitised again (rehype-sanitize, GitHub-style allow list)
 *  - only http, https and mailto links survive; links open in a new tab with rel="noopener noreferrer"
 *  - images are never loaded: the img element is replaced by its alt text (see components.img)
 */
const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "input"),
};

const SAFE_PROTOCOLS = /^(https?:|mailto:|#)/i;

export function safeMarkdownUrl(url: string): string {
  const u = url.trim();
  return SAFE_PROTOCOLS.test(u) ? u : "";
}

const components: Components = {
  a({ href, children }) {
    const safe = href ? safeMarkdownUrl(href) : "";
    if (!safe) return <span>{children}</span>;
    const external = !safe.startsWith("#");
    return (
      <a href={safe} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {children}
        {external ? <span className="sr-only"> (opens in a new tab)</span> : null}
      </a>
    );
  },
  img({ alt }) {
    return alt ? <span>[{alt}]</span> : null;
  },
};

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  return (
    <div className={`prose-brd ${className}`}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        urlTransform={safeMarkdownUrl}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
