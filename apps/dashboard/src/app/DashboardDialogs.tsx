import type { DashboardViewModel } from "./dashboard-view-model.js";
import { AccountDialog } from "../features/dialogs/AccountDialog.js";
import { InviteDialog } from "../features/dialogs/InviteDialog.js";
import { OwnerRecoveryDialog } from "../features/dialogs/OwnerRecoveryDialog.js";
import { SetupDialog } from "../features/dialogs/SetupDialog.js";
import { WorkspaceConnectionDialog } from "../features/dialogs/WorkspaceConnectionDialog.js";

export function DashboardDialogs({ model }: { model: DashboardViewModel }) {
  const {
    account,
    credentialNotice,
    initialInviteToken,
    invite,
    member,
    ownerRecovery,
    session,
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
        profile={account.profile}
        credentialNotice={credentialNotice}
        accountError={account.error}
        accountChecking={account.checking}
        supportsPasskeys={account.supportsPasskeys}
        initialInviteToken={initialInviteToken}
        accountDisplayName={account.displayName}
        displayName={submission.displayName}
        roomName={submission.roomName}
        joinToken={submission.joinToken}
        setupMode={submission.setupMode}
        recoverySessionId={submission.recoverySessionId}
        recoveryKey={submission.recoveryKey}
        currentSessionId={session?.id ?? null}
        restoringRoomId={account.restoringRoomId}
        accountSubmitting={account.submitting}
        submitting={submission.submitting}
        onCredentialNoticeChange={setCredentialNotice}
        onAccountDisplayNameChange={account.setDisplayName}
        onDisplayNameChange={submission.setDisplayName}
        onRoomNameChange={submission.setRoomName}
        onJoinTokenChange={submission.setJoinToken}
        onSetupModeChange={submission.setSetupMode}
        onRecoverySessionIdChange={submission.setRecoverySessionId}
        onRecoveryKeyChange={submission.setRecoveryKey}
        onAuthenticate={(mode) => void account.authenticate(mode)}
        onActivateRoom={(room) => void account.activateRoom(room)}
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
      <AccountDialog
        open={account.dialogOpen}
        profile={account.profile}
        error={account.error}
        supportsPasskeys={account.supportsPasskeys}
        accountDisplayName={account.displayName}
        currentSessionId={session?.id ?? null}
        restoringRoomId={account.restoringRoomId}
        submitting={account.submitting}
        onOpenChange={account.setDialogOpen}
        onAccountDisplayNameChange={account.setDisplayName}
        onActivateRoom={(room) => void account.activateRoom(room)}
        onAuthenticate={(mode) => void account.authenticate(mode)}
        onSignOut={() => void account.signOut()}
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
