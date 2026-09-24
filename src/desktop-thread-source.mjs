// Desktop roots may be created by the owner or by another task on their behalf.
// This host label describes creation provenance, not the current turn's author.
// Sender identity, active turn and effective permissions are verified separately.
export function isDesktopRootThreadSource(source) {
  return source === 'user' || source === 'agent_created_thread';
}
