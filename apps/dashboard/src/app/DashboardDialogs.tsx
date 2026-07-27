import type { DashboardViewModel } from "./dashboard-view-model.js";
import { InviteDialog } from "../features/dialogs/InviteDialog.js";
import { OwnerRecoveryDialog } from "../features/dialogs/OwnerRecoveryDialog.js";
import { SetupDialog } from "../features/dialogs/SetupDialog.js";
import { WorkspaceConnectionDialog } from "../features/dialogs/WorkspaceConnectionDialog.js";

export function DashboardDialogs({ model }: { model: DashboardViewModel }) {
  const {
    credentialNotice,
    initialInviteToken,
    invite,
    member,
    ownerRecovery,
    setCredentialNotice,
    setupOpen,
    submission,
    workspaceConnection,
    workspaceHistory,
  } = model;
  return (
    <>
      <WorkspaceConnectionDialog
        open={workspaceConnection.open}
        memberRole={member?.role ?? null}
        loading={workspaceConnection.loading}
        hasSummary={Boolean(workspaceHistory.summary)}
        pairingToken={workspaceConnection.pairingToken}
        pairingExpiresAt={workspaceConnection.pairingExpiresAt}
        pairingCopied={workspaceConnection.pairingCopied}
        pairingTokenRef={workspaceConnection.pairingTokenRef}
        onOpenChange={workspaceConnection.setOpen}
        onCreatePairing={() => void workspaceConnection.createPairing()}
        onCopyPairing={() => void workspaceConnection.copyPairing()}
      />
      <SetupDialog
        open={setupOpen}
        credentialNotice={credentialNotice}
        initialInviteToken={initialInviteToken}
        displayName={submission.displayName}
        roomName={submission.roomName}
        joinToken={submission.joinToken}
        setupMode={submission.setupMode}
        recoverySessionId={submission.recoverySessionId}
        recoveryKey={submission.recoveryKey}
        submitting={submission.submitting}
        onCredentialNoticeChange={setCredentialNotice}
        onDisplayNameChange={submission.setDisplayName}
        onRoomNameChange={submission.setRoomName}
        onJoinTokenChange={submission.setJoinToken}
        onSetupModeChange={submission.setSetupMode}
        onRecoverySessionIdChange={submission.setRecoverySessionId}
        onRecoveryKeyChange={submission.setRecoveryKey}
        onSubmit={submission.submitSetup}
      />
      <OwnerRecoveryDialog
        sessionId={ownerRecovery.credential?.sessionId ?? ""}
        recoveryKey={ownerRecovery.credential?.recoveryKey ?? ""}
        copied={ownerRecovery.copied}
        bundleRef={ownerRecovery.bundleRef}
        onCopy={() => void ownerRecovery.copy()}
        onSaved={ownerRecovery.confirmSaved}
      />
      <InviteDialog
        open={invite.open}
        inviteLink={invite.link}
        copied={invite.copied}
        copyFailed={invite.copyFailed}
        inviteLinkRef={invite.linkRef}
        onOpenChange={invite.setOpen}
        onCopy={() => void invite.copy()}
      />
    </>
  );
}
