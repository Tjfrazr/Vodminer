import { publishClip, closeContext } from '../src/twitch/clipPublisher.js';

const VOD_ID = process.argv[2];
const START = Number(process.argv[3]);
const END = Number(process.argv[4]);

if (!VOD_ID || !Number.isFinite(START) || !Number.isFinite(END)) {
  console.error('Usage: node scripts/test-clip-publish.js <vodId> <startSec> <endSec>');
  console.error('Example: node scripts/test-clip-publish.js 2778567108 5 35');
  process.exit(1);
}

async function main() {
  console.log(`--- Single clip publish test ---`);
  console.log(`vodId=${VOD_ID}  range=${START}s..${END}s\n`);

  const title = `Vodminer test ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const result = await publishClip(
    { vodId: VOD_ID, startSec: START, endSec: END, title },
    { headless: false },
  );

  console.log('\nresult:', JSON.stringify(result, null, 2));
  console.log(result.published ? '\nOK — clip should appear in your Twitch Clips Manager.' : '\nFAILED — see state/playwright-screenshots/ for debug artifacts.');

  await closeContext();
  process.exit(result.published ? 0 : 1);
}

main().catch(async (err) => {
  console.error('test failed:', err.message);
  await closeContext().catch(() => {});
  process.exit(1);
});
