import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Tab,
  TabList,
} from "@fluentui/react-components";
import { KeyRegular } from "@fluentui/react-icons";
import type { SetupSubmissionMode } from "../session/invite-session.js";

interface RoomAccessFieldsProps {
  initialInviteToken: string | null;
  displayName: string;
  roomName: string;
  joinToken: string;
  setupMode: SetupSubmissionMode;
  recoverySessionId: string;
  recoveryKey: string;
  onDisplayNameChange: (value: string) => void;
  onRoomNameChange: (value: string) => void;
  onJoinTokenChange: (value: string) => void;
  onSetupModeChange: (value: SetupSubmissionMode) => void;
  onRecoverySessionIdChange: (value: string) => void;
  onRecoveryKeyChange: (value: string) => void;
}

export function RoomAccessFields(props: RoomAccessFieldsProps) {
  if (props.initialInviteToken) {
    return (
      <>
        <p className="dialog-intro">你收到了一次性协作邀请，无需登录账号即可申请加入。</p>
        <Field label="房间内显示名称" required>
          <Input value={props.displayName} maxLength={80} autoComplete="name" onChange={(_, data) => props.onDisplayNameChange(data.value)} />
        </Field>
        <MessageBar intent="success"><MessageBarBody>邀请已读取。提交后仍需房主明确批准。</MessageBarBody></MessageBar>
      </>
    );
  }

  return (
    <>
      <p className="dialog-intro">创建房间后会随机生成房主密钥；请保存房间 ID 和密钥，以后可重复恢复房间。</p>
      <TabList selectedValue={props.setupMode} onTabSelect={(_, data) => props.onSetupModeChange(data.value as SetupSubmissionMode)} aria-label="连接房间方式">
        <Tab value="create">创建房间</Tab>
        <Tab value="join">邀请加入</Tab>
        <Tab value="recover">恢复房间</Tab>
      </TabList>
      {props.setupMode === "recover" ? (
        <>
          <MessageBar intent="warning"><MessageBarBody>输入创建房间时保存的房间 ID 和房主密钥，即可重新取得房主权限。</MessageBarBody></MessageBar>
          <Field label="房间 ID" required>
            <Input value={props.recoverySessionId} autoComplete="off" onChange={(_, data) => props.onRecoverySessionIdChange(data.value)} />
          </Field>
          <Field label="房主密钥" required>
            <Input type="password" value={props.recoveryKey} contentBefore={<KeyRegular />} autoComplete="off" placeholder="ccr_..." onChange={(_, data) => props.onRecoveryKeyChange(data.value)} />
          </Field>
        </>
      ) : (
        <>
          <Field label="房间内显示名称" required>
            <Input value={props.displayName} maxLength={80} autoComplete="name" onChange={(_, data) => props.onDisplayNameChange(data.value)} />
          </Field>
          {props.setupMode === "create" ? (
            <Field label="新房间名称" required><Input value={props.roomName} maxLength={120} onChange={(_, data) => props.onRoomNameChange(data.value)} /></Field>
          ) : (
            <Field label="邀请令牌" required><Input value={props.joinToken} contentBefore={<KeyRegular />} placeholder="cci_..." onChange={(_, data) => props.onJoinTokenChange(data.value)} /></Field>
          )}
        </>
      )}
    </>
  );
}

export function RoomSubmitButton(props: Pick<RoomAccessFieldsProps, "initialInviteToken" | "displayName" | "roomName" | "joinToken" | "setupMode" | "recoverySessionId" | "recoveryKey"> & { submitting: boolean }) {
  if (props.initialInviteToken || props.setupMode === "join") {
    return <Button type="submit" appearance="primary" disabled={!props.displayName.trim() || !props.joinToken.trim() || props.submitting}>申请加入</Button>;
  }
  if (props.setupMode === "recover") {
    return <Button type="submit" appearance="primary" disabled={!props.recoverySessionId.trim() || !props.recoveryKey.trim() || props.submitting}>恢复房间</Button>;
  }
  return <Button type="submit" appearance="primary" disabled={!props.displayName.trim() || !props.roomName.trim() || props.submitting}>创建房间</Button>;
}
