import { Button } from "@fluentui/react-components";
import { ChevronDownRegular, CopyRegular } from "@fluentui/react-icons";
import { useEffect, useId, useState } from "react";
import {
  IdeFileChanges,
  navigationTargetForFileChange,
} from "../../ide/IdeFileChanges.js";
import type { IdeNavigationTarget } from "../../ide/types.js";
import { copyText } from "../../shared/clipboard.js";
import { executionOutputNeedsViewport, type ReadableExecution } from "./readable-output.js";
import { ReadableOutput, ReadableSource } from "./ReadableOutput.js";
import { executionStatusLabel, timeLabel } from "./execution-process-presentation.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";

export function ExecutionStepCard({
  record,
  historyKey,
  onOpenFile,
}: {
  record: ReadableExecution;
  historyKey?: string | null;
  onOpenFile?: (target: IdeNavigationTarget) => void;
}) {
  const [expanded, setExpanded] = useState(record.status === "failed");
  const [outputCopied, setOutputCopied] = useState(false);
  const contentId = useId();
  const outputNeedsViewport = executionOutputNeedsViewport(record.output);
  const previewSource =
    record.fileChanges.length > 0
      ? `编辑了 ${record.fileChanges.length} 个文件`
      : record.role === "command"
        ? record.input
        : (record.sourceText ?? record.input);
  const preview =
    previewSource
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/^\$\s*/, "")
      .replace(/^#{1,3}\s+/, "")
      .replaceAll("**", "")
      .replaceAll("`", "") ?? record.summary;

  useEffect(() => {
    if (record.status === "failed") setExpanded(true);
  }, [record.status]);

  useEffect(() => {
    setOutputCopied(false);
  }, [record.output]);

  return (
    <article
      className={`execution-step ${record.role} ${record.status} ${
        expanded ? "expanded" : "collapsed"
      }`}
      data-history-anchor={historyKey ?? undefined}
    >
      <button
        type="button"
        className="execution-step-disclosure"
        aria-controls={contentId}
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "展开"} ${record.title}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="execution-step-marker" aria-hidden="true">
          <ExecutionStatusIcon
            status={record.status}
            fallback={record.role === "command" ? "command" : "reasoning"}
          />
        </span>
        <strong>{record.title}</strong>
        <span className="execution-step-preview" title={preview}>
          {preview}
        </span>
        {record.outputLineCount > 0 ? (
          <span className="execution-step-output-count">
            {record.outputLineCount} 行
          </span>
        ) : null}
        {record.createdAt ? (
          <time dateTime={record.createdAt}>{timeLabel(record.createdAt)}</time>
        ) : null}
        <ChevronDownRegular
          className="execution-step-chevron"
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div className="execution-step-content" id={contentId}>
          <p className="execution-step-summary">{record.summary}</p>
          {(record.role === "reasoning" || record.role === "commentary") &&
          record.input ? (
            <ReadableOutput text={record.input} />
          ) : null}
          {record.role === "reasoning" && record.sourceText ? (
            <details className="execution-details reasoning-source">
              <summary>
                <span>查看 Codex 原始摘要</span>
                <small>内容可能为英文</small>
              </summary>
              <div className="execution-detail-body">
                <div className="reasoning-source-content">
                  <span>原始摘要</span>
                  <ReadableSource text={record.sourceText} />
                </div>
              </div>
            </details>
          ) : null}
          {record.fileChanges.length > 0 ? (
            <IdeFileChanges
              changes={record.fileChanges}
              title={
                record.status === "running"
                  ? "正在编辑文件"
                  : record.status === "failed"
                    ? "文件编辑失败"
                    : `编辑了 ${record.fileChanges.length} 个文件`
              }
              defaultExpanded
              onOpenFile={
                onOpenFile
                  ? (_path, change) =>
                      onOpenFile(navigationTargetForFileChange(change))
                  : undefined
              }
            />
          ) : null}
          {record.role === "command" && (record.input || record.output) ? (
            <div className="execution-detail-body">
              {record.input ? (
                <div className="execution-input">
                  <span>命令</span>
                  <pre>{record.input}</pre>
                </div>
              ) : null}
              {record.output ? (
                <div
                  className={`execution-output-viewer${outputNeedsViewport ? " long" : ""}`}
                >
                  <div className="execution-output-toolbar">
                    <strong>输出</strong>
                    <small>{record.outputLineCount} 行</small>
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<CopyRegular />}
                      aria-label="复制完整命令输出"
                      onClick={() => {
                        void copyText(record.output ?? "").then(setOutputCopied);
                      }}
                    >
                      {outputCopied ? "已复制" : "复制"}
                    </Button>
                  </div>
                  <pre
                    tabIndex={0}
                    aria-label="命令输出，可在框内滚动查看完整内容"
                  >
                    {record.output}
                  </pre>
                  <div className="execution-output-footer">
                    <span className={`execution-output-result ${record.status}`}>
                      {executionStatusLabel(record.status)}
                    </span>
                    <span>
                      {outputNeedsViewport
                        ? "可上下、左右滚动查看完整输出"
                        : "可滚动查看完整输出"}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
