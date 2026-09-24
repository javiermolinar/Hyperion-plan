const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {execFileSync, spawnSync} = require('node:child_process');

const helper = path.resolve(__dirname, '../../dist/plan.cjs');
const assets = process.env.VISUALIZE_ASSETS;
if (!assets || !fs.existsSync(path.join(assets, 'visualize.html'))) {
  throw new Error('Set VISUALIZE_ASSETS to the Visualize skill assets directory.');
}
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function createScratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-companion-test-'));
  process.on('exit', () => fs.rmSync(dir, {recursive:true, force:true}));
  for (const entry of fs.readdirSync(path.join(__dirname, 'fixtures'))) {
    fs.copyFileSync(path.join(__dirname, 'fixtures', entry), path.join(dir, entry));
  }
  return dir;
}

function launch() {
  return chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {})});
}

async function createView(browser, errors, dir, {file, saved=null, width=736, theme='light', expanded=[], hasTouch=false}) {
  const page = await browser.newPage({viewport:{width,height:1800}, colorScheme:theme, hasTouch});
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<style>body{margin:0}</style><iframe style="border:0;width:100%;height:1750px" sandbox="allow-scripts"></iframe>');
  const mock = '<script>window.__calls=[];window.__fail=false;window.openai={widgetState:'+
    JSON.stringify(saved).replaceAll('<','\\u003c')+
    ',setWidgetState:async value=>{window.__saved=window.__savedState=JSON.parse(JSON.stringify(value));},sendFollowUpMessage:async value=>{window.__calls.push(value);if(window.__fail)throw Error("test rejection");}};</script>';
  const kit = fs.readFileSync(path.join(assets,'visualize.html'),'utf8').replace('<!--__INLINE_VISUALIZATION_FRAGMENT__-->', fs.readFileSync(path.join(dir,file),'utf8'));
  const content = '<style>'+fs.readFileSync(path.join(assets,'visualize.css'),'utf8')+':root{color-scheme:'+theme+'}body{margin:0;padding:8px}</style>'+mock+kit;
  await page.locator('iframe').evaluate((frame,html)=>frame.srcdoc=html,content);
  const ui = page.frameLocator('iframe');
  await ui.locator('.pc-heading').waitFor();
  const frame = page.frames().find(frame=>frame!==page.mainFrame());
  await frame.waitForFunction(()=>!!globalThis.lucide);
  for (const id of expanded) {
    const toggle = ui.locator(`[data-step="${id}"] .pc-expand`);
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  }
  return {page,ui,frame};
}

module.exports = {fs,path,assert,execFileSync,spawnSync,helper,createScratch,launch,createView};
