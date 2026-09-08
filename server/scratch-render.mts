import './src/env.js';
const key = process.env.RENDER_API_KEY!;
const H = { authorization: `Bearer ${key}`, accept: 'application/json' };

async function get(path: string) {
  const res = await fetch(`https://api.render.com/v1${path}`, { headers: H });
  return { status: res.status, body: res.ok ? await res.json() : (await res.text()).slice(0, 300) };
}

const owners = await get('/owners?limit=20');
console.log('  /owners ->', owners.status);
if (Array.isArray(owners.body)) {
  for (const o of owners.body as any[]) {
    console.log(`    owner: ${o.owner?.name}  id=${o.owner?.id}  type=${o.owner?.type}  email=${o.owner?.email ?? '-'}`);
  }
} else console.log('   ', JSON.stringify(owners.body).slice(0, 200));

const services = await get('/services?limit=20');
console.log('  /services ->', services.status);
if (Array.isArray(services.body)) {
  const list = services.body as any[];
  console.log(`    ${list.length} service(s)`);
  for (const s of list) console.log(`    - ${s.service?.name} (${s.service?.type}) ${s.service?.serviceDetails?.url ?? ''}`);
}
