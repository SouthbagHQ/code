// Production deploys of the website worker must have the central freeze wired: without
// IDENTITY_INTERNAL_SECRET the check silently turns off and frozen accounts could spend.
import { execSync } from 'node:child_process';
const cwd = new URL('../packages/website', import.meta.url).pathname;
const out = execSync('npx wrangler secret list --format json 2>/dev/null || echo "[]"', { encoding: 'utf8', cwd });
const names = JSON.parse(out).map(s => s.name);
if (!names.includes('IDENTITY_INTERNAL_SECRET')) {
  console.error('IDENTITY_INTERNAL_SECRET is not set on the website worker. `wrangler secret put IDENTITY_INTERNAL_SECRET` with Code\'s entry from Identity\'s INTERNAL_API_SECRETS (key "southbag-code"). Refusing to deploy with the account freeze off.');
  process.exit(1);
}
console.log('deploy check ok: account freeze is wired');
