import { env } from '../src/lib/env.js';
import { getAppAccessToken, getLatestVod } from '../src/twitch/vodFetcher.js';

async function main() {
  console.log('--- L1: Twitch connection test ---\n');

  console.log('[1/2] Fetching app access token...');
  const token = await getAppAccessToken();
  console.log(`      OK. token=${token.slice(0, 6)}...${token.slice(-4)} (length ${token.length})\n`);

  console.log(`[2/2] Fetching latest VOD for broadcaster ${env.TWITCH_BROADCASTER_ID}...`);
  const vod = await getLatestVod(env.TWITCH_BROADCASTER_ID);

  if (!vod) {
    console.log('      No VOD found.');
    console.log('      Possible causes:');
    console.log('        - "Store past broadcasts" is OFF in Twitch Creator Dashboard');
    console.log('        - You have never streamed on this account');
    console.log('        - TWITCH_BROADCASTER_ID does not match a real user');
    process.exit(1);
  }

  console.log('      OK. Latest VOD:');
  console.log(`        vodId:       ${vod.vodId}`);
  console.log(`        url:         ${vod.url}`);
  console.log(`        durationSec: ${vod.durationSec}`);
  console.log(`        createdAt:   ${vod.createdAt}`);
  console.log('\nL1 passed. Twitch credentials and Helix API are working.');
}

main().catch((err) => {
  console.error('\nL1 FAILED:', err.message);
  if (err.message?.includes('401') || err.message?.includes('Unauthorized')) {
    console.error('  -> Likely TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is wrong.');
  } else if (err.message?.includes('400')) {
    console.error('  -> Likely TWITCH_BROADCASTER_ID is not a valid numeric user id.');
  }
  process.exit(1);
});
