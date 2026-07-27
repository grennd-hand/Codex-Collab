import {
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";

export interface ErrorBannerProps {
  message: string | null;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  if (!message) return null;

  return (
    <div className="error-region" role="alert">
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>需要处理</MessageBarTitle>
          {message}
        </MessageBarBody>
        <Button
          appearance="transparent"
          icon={<DismissRegular />}
          aria-label="关闭错误"
          onClick={onDismiss}
        />
      </MessageBar>
    </div>
  );
}
