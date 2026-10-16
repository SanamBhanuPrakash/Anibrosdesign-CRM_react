// READ-ONLY audit: (1) the Automation UI end to end in a real browser, (2) a sweep of every route at laptop and phone width.
const path = require('path');
const fs = require('fs');
const PROJECT = 'd:/work/Xampp/htdocs/Anibros CRM/project-bolt-sb1-s2qdvawq_v2/project';
const SP = 'C:/Users/Sanam/AppData/Local/Temp/claude/d--work-Xampp-htdocs-Anibros-CRM-project-bolt-sb1-s2qdvawq-v2/97fe83e4-707c-470e-9153-d8e0470fcf1c/scratchpad';
const { chromium } = require('module').createRequire(path.join(PROJECT, 'package.json'))('playwright');
const BASE = 'http://127.0.0.1:5199';
const MAIL = 'http://127.0.0.1:4101';
const email = `aud${Date.now().toString(36)}@anibros.test`;
const password = 'Violet-Lantern-Orbit-42';
const mailLink = async (to, p) => { for (let i = 0; i < 40; i++) { const items = await (await fetch(`${MAIL}/mail?to=${encodeURIComponent(to)}`)).json(); for (const m of items.reverse()) { const h = new RegExp(`(https?://[^\\s]*${p}[^\\s]*)`).exec(m.text); if (h) return h[1]; } await new Promise((r) => setTimeout(r, 400)); } throw new Error('no mail'); };
const report = { automation: {}, sweep: [] };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const api = [];
  page.on('request', (r) => { if (/\/api\//.test(r.url())) api.push(`${r.method()} ${r.url().replace(BASE, '').split('?')[0]}`); });

  await page.goto(`${BASE}/sign-up`);
  await page.getByLabel('Your name').fill('Audit Admin');
  await page.getByLabel('Agency or company').fill('Audit Estates');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByText('Check your email', { exact: true }).first().waitFor({ timeout: 10000 });
  await page.goto(await mailLink(email, '/verify-email'));
  await page.waitForURL('**/dashboard', { timeout: 15000 });

  // seed minimal data through the browser's own session (v1 API)
  const seed = await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.match(/(?:^|;\s*)(?:__Host-)?anibros_csrf=([^;]*)/) || [])[1]);
    const post = async (u, b) => (await (await fetch(u, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(b) })).json()).data;
    const lead = await post('/api/v1/leads', { contact: { firstName: 'Seed', lastName: 'Lead', email: 'seed@example.com', phone: '+919800000009' } });
    await post('/api/v1/properties', { title: 'Seed flat', price: 8500000, propertyType: 'apartment', bedrooms: 3 });
    await post('/api/v1/projects', { name: 'Seed Heights' });
    return { leadId: lead.id };
  });

  // ---- 1. Automation, as a user would do it: create a rule "Lead Created → Create Task", then create a lead and look for the effect
  await page.goto(`${BASE}/settings/automation`);
  await page.getByRole('heading', { level: 1, name: 'Automation Rules' }).waitFor();
  api.length = 0;
  await page.getByRole('button', { name: 'Create Rule' }).first().click();
  report.automation.dialogHasRoleDialog = (await page.getByRole('dialog').count()) > 0;
  report.automation.ruleNameInputLabelledByLabel = (await page.getByLabel('Rule Name').count()) > 0;
  const dlg = page.locator('body');
  await page.getByPlaceholder(/Auto-assign portal leads/).fill('Call every new lead within 5 minutes');
  await dlg.locator('select').nth(0).selectOption('lead_created');
  await dlg.locator('select').nth(1).selectOption('create_task');
  const options = { triggers: await dlg.locator('select').nth(0).locator('option').allInnerTexts(), actions: await dlg.locator('select').nth(1).locator('option').allInnerTexts() };
  await page.getByRole('button', { name: 'Create Rule' }).last().click();
  await page.getByText('Call every new lead within 5 minutes').waitFor();
  report.automation.requestsWhileSavingRule = [...new Set(api)];
  report.automation.dropdownOptions = options;
    report.automation.savedRuleShownInList = true;
  // what is stored server-side?
  report.automation.storedIn = await page.evaluate(async () => {
    const r = await (await fetch('/api/tenant/config', { credentials: 'include' })).json();
    const t = await (await fetch('/api/automation', { credentials: 'include' })).json();
    return { 'tenants.settings.automation_rules': r.data.settings.automation_rules, 'automation_rules table via /api/automation': t.data };
  });
  // now cause the trigger and wait: is a task created?
  const before = await page.evaluate(async () => (await (await fetch('/api/v1/tasks?assignee=any', { credentials: 'include' })).json()).data.length);
  await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.match(/(?:^|;\s*)(?:__Host-)?anibros_csrf=([^;]*)/) || [])[1]);
    await fetch('/api/v1/leads', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ contact: { firstName: 'Trigger', email: 'trigger@example.com' } }) });
  });
  await page.waitForTimeout(20000); // the worker ticks every 15 s; jobs poll every 2 s
  const after = await page.evaluate(async () => (await (await fetch('/api/v1/tasks?assignee=any', { credentials: 'include' })).json()).data.length);
  report.automation.tasksBeforeAfterNewLead = [before, after];
  report.automation.toggleAndDelete = 'UI buttons exist (Power / Pencil / Trash) and also rewrite the settings blob';
  await page.screenshot({ path: path.join(SP, 'audit_automation_ui.png') });

  // ---- 2. route sweep
  const routes = ['/dashboard', '/leads', '/leads?view=board', `/leads/${seed.leadId}`, '/contacts', '/tasks', '/calendar', '/properties', '/projects', '/property-matching', '/reports', '/attribution', '/integrations/lead-sources', '/integrations', '/operations', '/settings/profile', '/settings/team', '/settings/api-keys', '/settings/pipelines', '/settings/custom-fields', '/settings/automation', '/settings/tenant', '/definitely-not-a-page'];
  for (const vp of [{ n: 'laptop', w: 1440, h: 900 }, { n: 'phone', w: 390, h: 844 }]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    for (const r of routes) {
      const problems = [];
      const onResp = (resp) => { if (resp.status() >= 400 && /\/api\//.test(resp.url())) problems.push(`${resp.status()} ${resp.request().method()} ${resp.url().replace(BASE, '').split('?')[0]}`); };
      const onCons = (m) => { if (m.type() === 'error' && !/status of 40[0-9]/.test(m.text())) problems.push('console: ' + m.text().slice(0, 100)); };
      const onErr = (e) => problems.push('pageerror: ' + e.message.slice(0, 100));
      page.on('response', onResp); page.on('console', onCons); page.on('pageerror', onErr);
      await page.goto(BASE + r, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1800);
      const probe = await page.evaluate(() => {
        const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.textContent || '').trim() || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()) || (el.closest('label')?.textContent || '').trim();
        const unnamed = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch]')].filter((el) => el.offsetParent !== null && !name(el)).length;
        return {
          h1: (document.querySelector('h1')?.textContent || '').trim().slice(0, 40),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
          unnamedControls: unnamed,
          imgNoAlt: [...document.images].filter((i) => !i.hasAttribute('alt')).length,
          hasMain: Boolean(document.querySelector('main, [role=main]')),
          bodyHasText: document.body.innerText.trim().length > 30,
          skeletonStuck: Boolean(document.querySelector('.MuiSkeleton-root')),
        };
      });
      page.off('response', onResp); page.off('console', onCons); page.off('pageerror', onErr);
      report.sweep.push({ vp: vp.n, route: r, ...probe, problems: [...new Set(problems)].slice(0, 4) });
    }
  }
  fs.writeFileSync(path.join(SP, 'audit_ui.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report.automation, null, 1));
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
