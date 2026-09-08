import './src/env.js';
import { readFileSync } from 'node:fs';

const key = process.env.RENDER_API_KEY!;
const token = readFileSync(
  '/private/tmp/claude-502/-Users-smriti-dey-Desktop-project/77d65506-7343-4d10-9acb-8ecaa543cbaa/scratchpad/bearer.txt',
  'utf8',
).trim();

const body = {
  type: 'web_service',
  name: 'upsc-mentor-server',
  ownerId: 'tea-d22b3tje5dus739f3ah0',
  repo: 'https://github.com/AyushSingh80/mentor-backend',
  branch: 'main',
  rootDir: 'server',
  autoDeploy: 'yes',
  serviceDetails: {
    env: 'node',
    plan: 'free',
    region: 'singapore',
    healthCheckPath: '/health',
    envSpecificDetails: {
      buildCommand: 'npm ci && npm run build',
      startCommand: 'npm start',
    },
  },
  // No provider keys. The server boots into headlines mode: real feeds, no
  // model, nothing billable — which is exactly what works locally today. Keys
  // go in the dashboard once the deploy itself is proven.
  envVars: [
    { key: 'NODE_ENV', value: 'production' },
    { key: 'APP_BEARER_TOKEN', value: token },
    { key: 'APP_TIMEZONE', value: 'Asia/Kolkata' },
    { key: 'MONTHLY_USD_CAP', value: '30' },
    { key: 'DAILY_REQUEST_CAP', value: '120' },
    { key: 'MCQ_MONTHLY_USD_CAP', value: '8' },
    { key: 'CA_MONTHLY_USD_CAP', value: '5' },
    { key: 'DRILLS_MONTHLY_USD_CAP', value: '4' },
    { key: 'INTERVIEW_MONTHLY_USD_CAP', value: '2' },
    { key: 'EVAL_RESERVED_FLOOR_USD', value: '10' },
  ],
};

const res = await fetch('https://api.render.com/v1/services', {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
console.log('  POST /services ->', res.status);
const out = await res.text();
try {
  const json = JSON.parse(out);
  const s = json.service ?? json;
  if (res.ok) {
    console.log(`    created: ${s.name}  id=${s.id}`);
    console.log(`    url:     ${s.serviceDetails?.url ?? '(assigned shortly)'}`);
  } else console.log('   ', JSON.stringify(json).slice(0, 400));
} catch {
  console.log('   ', out.slice(0, 400));
}
