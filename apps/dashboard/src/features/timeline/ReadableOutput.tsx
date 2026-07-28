import type { MouseEvent, ReactNode } from "react";
import { getDashboardRuntime } from "../../shared/runtime/index.js";
import { classifyReadableSource, parseReadableBlocks } from "./readable-output.js";

function openExternal(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  event.preventDefault();
  void getDashboardRuntime().shell.openExternal(url).catch(() => undefined);
}

function renderInlineText(text: string): ReactNode[] {
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  return text.split(pattern).filter(Boolean).map((part, index) => {
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) {
      return (
        <a
          href={link[2]}
          key={`${index}-${part}`}
          onClick={(event) => openExternal(event, link[2])}
          rel="noreferrer"
          target="_blank"
        >
          {link[1]}
        </a>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${index}-${part}`}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${index}-${part}`}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export function ReadableOutput({ text }: { text: string }) {
  const blocks = parseReadableBlocks(text);
  return (
    <div className="readable-output">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "heading") {
          return block.level === 3 ? (
            <h4 key={key}>{renderInlineText(block.text)}</h4>
          ) : (
            <h3 className={`level-${block.level}`} key={key}>
              {renderInlineText(block.text)}
            </h3>
          );
        }
        if (block.kind === "unordered-list") {
          return (
            <ul key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item}`}>{renderInlineText(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "ordered-list") {
          return (
            <ol key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item}`}>{renderInlineText(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.kind === "quote") {
          return <blockquote key={key}>{renderInlineText(block.text)}</blockquote>;
        }
        if (block.kind === "code") {
          return (
            <div className="readable-code" key={key}>
              {block.language ? <span>{block.language}</span> : null}
              <pre>{block.text}</pre>
            </div>
          );
        }
        return <p key={key}>{renderInlineText(block.text)}</p>;
      })}
    </div>
  );
}

export function ReadableSource({ text }: { text: string }) {
  if (classifyReadableSource(text) === "code") {
    return (
      <div className="readable-code">
        <span>代码</span>
        <pre>{text}</pre>
      </div>
    );
  }
  return <ReadableOutput text={text} />;
}
