import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Publisher documentation: formatted text, without HTML or remote embeds. */
export function AbilityMarkdown({ children }: { children: string }) {
  return (
    <div className="ability-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : undefined)}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
