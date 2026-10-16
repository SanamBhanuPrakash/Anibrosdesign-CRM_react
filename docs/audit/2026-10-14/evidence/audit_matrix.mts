// READ-ONLY: derive the v1 route × role matrix from the live route registry and the central permission matrix.
const ROOT = 'file:///D:/work/Xampp/htdocs/Anibros%20CRM/project-bolt-sb1-s2qdvawq_v2/project/';
await import(ROOT + 'server/src/app.ts');
const { routeRegistry } = await import(ROOT + 'server/src/platform/http/route.ts');
const { MATRIX, ROLES } = await import(ROOT + 'server/src/platform/authz/matrix.ts');
const code: Record<string, string> = { tenant_owner: 'Own', tenant_admin: 'Adm', sales_manager: 'SM', sales_agent: 'SA', marketing_manager: 'MM', marketing_analyst: 'MA', executive_readonly: 'Exe', auditor: 'Aud' };
const rows: string[] = [];
rows.push('| Method | Path | Auth | Permission(s) | ' + ROLES.map((r: string) => code[r]).join(' | ') + ' |');
rows.push('|---|---|---|---|' + ROLES.map(() => '---').join('|') + '|');
let n = 0;
for (const r of routeRegistry) {
  const perms = r.spec.permission === undefined ? [] : Array.isArray(r.spec.permission) ? r.spec.permission : [r.spec.permission];
  const auth = r.spec.auth ?? 'session';
  const cells = ROLES.map((role: string) => {
    if (auth === 'public') return 'pub';
    if (!perms.length) return 'any';
    const scopes = perms.map((p: string) => (MATRIX as any)[p]?.[role]);
    if (scopes.some((s: any) => !s)) return '–';
    return scopes.every((s: any) => s === 'all') ? '✔' : 'own';
  });
  rows.push(`| ${r.spec.method.toUpperCase()} | ${r.fullPath} | ${auth} | ${perms.join(' + ') || '(authenticated)'} | ${cells.join(' | ')} |`);
  n++;
}
console.log(`ROUTES ${n}`);
console.log(rows.join('\n'));
console.log('\nPERMISSIONS ' + Object.keys(MATRIX).length);
const used = new Set(routeRegistry.flatMap((r: any) => (r.spec.permission === undefined ? [] : Array.isArray(r.spec.permission) ? r.spec.permission : [r.spec.permission])));
console.log('UNUSED_PERMISSIONS ' + Object.keys(MATRIX).filter((p) => !used.has(p)).join(', '));
process.exit(0);
