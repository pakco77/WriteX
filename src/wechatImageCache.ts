export function wechatImageCacheKey(relayUrl: string, accountId: string, sourceSha256: string): string {
  return `${relayUrl.replace(/\/$/, "")}\u0000${accountId}\u0000${sourceSha256.toLowerCase()}`;
}

export const RELAY_BINDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function canReuseRelayAccountBinding(
  binding: { relayUrl: string; verifiedAt: number } | undefined,
  relayUrl: string,
  verifiedInSession: boolean,
  now = Date.now(),
): boolean {
  if (!binding || !verifiedInSession || !Number.isFinite(binding.verifiedAt)) return false;
  const canonical = (value: string) => value.replace(/\/+$/, "");
  const age = now - binding.verifiedAt;
  return canonical(binding.relayUrl) === canonical(relayUrl) && age >= 0 && age <= RELAY_BINDING_MAX_AGE_MS;
}
