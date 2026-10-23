export const unwrap = <T,>(
  reply: { ok: true; value: T } | { ok: false; code: string } | undefined,
): T => {
  if (!reply?.ok)
    throw new Error(reply && !reply.ok ? reply.code : 'host_unavailable');
  return reply.value;
};
export function AbilityHostStatus({
  available,
  reason,
  busy,
  onReconnect,
}: {
  available: boolean;
  reason?: string;
  busy: boolean;
  onReconnect(): Promise<unknown>;
}) {
  if (available) return null;
  const unsupported = reason === 'unsupported_platform';
  return (
    <div className="ability-host-status">
      <p role="status">
        {unsupported
          ? 'Abilities require macOS on Apple Silicon.'
          : 'Ability host disconnected.'}
      </p>
      {!unsupported && (
        <button type="button" disabled={busy} onClick={onReconnect}>
          Reconnect
        </button>
      )}
    </div>
  );
}
