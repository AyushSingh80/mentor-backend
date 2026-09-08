import './src/env.js';
const key = process.env.RENDER_API_KEY!;
const H = { authorization: `Bearer ${key}`, accept: 'application/json' };
const res = await fetch('https://api.render.com/v1/services?limit=5', { headers: H });
const list = (await res.json()) as any[];
for (const { service: s } of list) {
  console.log(`  ${s.name}`);
  console.log(`    repo:   ${s.repo}`);
  console.log(`    branch: ${s.branch}`);
  console.log(`    root:   ${s.rootDir || '(repo root)'}`);
  console.log(`    plan:   ${s.serviceDetails?.plan}  region: ${s.serviceDetails?.region}`);
  console.log(`    runtime:${s.serviceDetails?.runtime ?? s.serviceDetails?.env}`);
}
