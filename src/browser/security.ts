import { lookup } from 'node:dns/promises';
import { isPublicAddress } from '../shared/network-address.js';
export { isPublicAddress } from '../shared/network-address.js';
export async function validateUrl(
  input: string,
): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      'Only public HTTP(S) URLs without credentials are allowed.',
    );
  if (url.port && !['80', '443'].includes(url.port))
    throw new Error('Only standard web ports are allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  )
    throw new Error('Local addresses are blocked.');
  const addresses = await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    throw new Error('Private or special network addresses are blocked.');
  return { url, ...addresses[0] };
}
