import { Children, isValidElement, type ReactNode } from "react";
import { ResizableSplitPane } from "./ResizableSplitPane.js";

export type WorkspacePanelName = "files" | "people" | "chat" | "activity";

interface WorkspacePanelLayoutProps {
  children: ReactNode;
  className: string;
  withFiles: boolean;
  editorExpanded: boolean;
  storageScope: string;
}

function panel(children: ReactNode, name: WorkspacePanelName): ReactNode {
  return Children.toArray(children).find(
    (child) =>
      isValidElement<Record<string, unknown>>(child) &&
      child.props["data-workspace-panel"] === name,
  );
}

export function WorkspacePanelLayout({
  children,
  className,
  withFiles,
  editorExpanded,
  storageScope,
}: WorkspacePanelLayoutProps) {
  const files = panel(children, "files");
  const people = panel(children, "people");
  const chat = panel(children, "chat");
  const activity = panel(children, "activity");

  let content: ReactNode;
  if (withFiles && files && editorExpanded) {
    content = (
      <ResizableSplitPane
        className="workspace-layout-split workspace-layout-split--files-chat"
        primary={files}
        secondary={chat}
        defaultPrimarySize={760}
        minPrimarySize={560}
        maxPrimarySize={1120}
        minSecondarySize={420}
        separatorLabel="调整代码工作区和协作聊天宽度"
        primaryLabel="项目文件与代码编辑器"
        secondaryLabel="协作聊天"
        storageKey={`codex-collab:workspace:files-chat:${storageScope}`}
      />
    );
  } else if (withFiles && files) {
    content = (
      <ResizableSplitPane
        className="workspace-layout-split workspace-layout-split--files-rest"
        primary={files}
        secondary={
          <ResizableSplitPane
            className="workspace-layout-split workspace-layout-split--people-chat"
            primary={people}
            secondary={chat}
            defaultPrimarySize={300}
            minPrimarySize={240}
            maxPrimarySize={420}
            minSecondarySize={420}
            separatorLabel="调整协作成员和聊天宽度"
            primaryLabel="协作成员"
            secondaryLabel="协作聊天"
            storageKey={`codex-collab:workspace:people-chat:${storageScope}`}
          />
        }
        defaultPrimarySize={244}
        minPrimarySize={210}
        maxPrimarySize={380}
        minSecondarySize={680}
        separatorLabel="调整文件目录和协作区域宽度"
        primaryLabel="项目文件"
        secondaryLabel="成员与聊天"
        storageKey={`codex-collab:workspace:files-rest:${storageScope}`}
      />
    );
  } else {
    content = (
      <ResizableSplitPane
        className="workspace-layout-split workspace-layout-split--people-rest"
        primary={people}
        secondary={
          <ResizableSplitPane
            className="workspace-layout-split workspace-layout-split--chat-activity"
            primary={chat}
            secondary={activity}
            defaultPrimarySize={760}
            minPrimarySize={420}
            minSecondarySize={240}
            separatorLabel="调整聊天和任务活动宽度"
            primaryLabel="协作聊天"
            secondaryLabel="任务活动"
            storageKey={`codex-collab:workspace:chat-activity:${storageScope}`}
          />
        }
        defaultPrimarySize={340}
        minPrimarySize={260}
        maxPrimarySize={440}
        minSecondarySize={660}
        separatorLabel="调整协作成员和任务区域宽度"
        primaryLabel="协作成员"
        secondaryLabel="聊天与任务活动"
        storageKey={`codex-collab:workspace:people-rest:${storageScope}`}
      />
    );
  }

  return <div className={className}>{content}</div>;
}
