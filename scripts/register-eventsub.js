import { request } from 'undici';
import { env } from '../src/lib/env.js';
import { getAppAccessToken } from '../src/twitch/vodFetcher.js';

const callbackUrl = process.argv[2];

if (!callbackUrl) {
  console.error('Usage: node scripts/register-eventsub.js <https://your-public-url/twitch/webhook>');
  console.error('\nExample: node scripts/register-eventsub.js https://abc123.ngrok-free.app/twitch/webhook');
  console.error('\nPrereq:');
  console.error('  1. ngrok config add-authtoken <token>   (one-time, get from https://dashboard.ngrok.com)');
  console.error('  2. ngrok http 3000                       (in another terminal; copy the https URL)');
  console.error('  3. npm start                             (in another terminal; the server must be listening)');
  console.error('  4. node scripts/register-eventsub.js https://<your-ngrok-url>/twitch/webhook');
  process.exit(1);
}

async function api(method, path, body) {
  const token = await getAppAccessToken();
  const res = await request(`https://api.twitch.tv/helix${path}`, {
    method,
    headers: {
      'Client-Id': env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.statusCode, data };
}

async function main() {
  console.log('--- L5: EventSub subscription bootstrap ---\n');
  console.log(`Broadcaster: ${env.TWITCH_BROADCASTER_ID}`);
  console.log(`Callback:    ${callbackUrl}\n`);

  console.log('[1/3] Listing existing subscriptions...');
  const existing = await api('GET', '/eventsub/subscriptions');
  if (existing.status !== 200) {
    console.error('      FAILED:', existing.data);
    process.exit(1);
  }
  const matches = (existing.data.data ?? []).filter(
    (s) => s.type === 'stream.offline' &&
           s.condition?.broadcaster_user_id === env.TWITCH_BROADCASTER_ID,
  );
  console.log(`      OK. Total subscriptions: ${existing.data.total ?? 0}, matching stream.offline for this broadcaster: ${matches.length}`);

  if (matches.length > 0) {
    console.log('      Existing matching subscriptions:');
    for (const s of matches) {
      console.log(`        id=${s.id}  status=${s.status}  callback=${s.transport?.callback}`);
    }
    console.log('\n[2/3] Deleting stale subscriptions before creating fresh one...');
    for (const s of matches) {
      const del = await api('DELETE', `/eventsub/subscriptions?id=${s.id}`);
      console.log(`      ${del.status === 204 ? 'OK' : 'FAILED'}  deleted ${s.id} (status ${del.status})`);
    }
  } else {
    console.log('\n[2/3] No stale subscriptions to delete. Skipping.');
  }

  console.log('\n[3/3] Creating stream.offline subscription...');
  const created = await api('POST', '/eventsub/subscriptions', {
    type: 'stream.offline',
    version: '1',
    condition: { broadcaster_user_id: env.TWITCH_BROADCASTER_ID },
    transport: {
      method: 'webhook',
      callback: callbackUrl,
      secret: env.TWITCH_WEBHOOK_SECRET,
    },
  });

  if (created.status !== 202) {
    console.error(`      FAILED. Status ${created.status}:`);
    console.error('     ', JSON.stringify(created.data, null, 2));
    if (created.status === 400 && JSON.stringify(created.data).includes('secret')) {
      console.error('      -> TWITCH_WEBHOOK_SECRET must be 10-100 ASCII characters.');
    }
    if (created.status === 403) {
      console.error('      -> Twitch could not reach the callback URL. Is the server running and ngrok tunnel up?');
    }
    process.exit(1);
  }

  const sub = created.data.data[0];
  console.log(`      OK. id=${sub.id}  status=${sub.status}`);
  console.log(`      cost=${sub.cost}/${created.data.max_total_cost} (Twitch quota)\n`);

  if (sub.status === 'webhook_callback_verification_pending') {
    console.log('Twitch is now sending a verification challenge to your callback URL.');
    console.log('Watch your server logs — eventSub.js will respond automatically.');
    console.log('Status will change to "enabled" within ~30 seconds. Re-run this script (or GET subscriptions) to confirm.');
  }

  console.log('\nL5 bootstrap done. End a real stream to trigger the pipeline end-to-end.');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
