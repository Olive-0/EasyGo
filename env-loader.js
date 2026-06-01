const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const outPath = path.join(__dirname, 'config.js');

if (!fs.existsSync(envPath)) {
  console.error('.env not found in', envPath);
  process.exit(1);
}

const raw = fs.readFileSync(envPath, 'utf8');
const lines = raw.split(/\r?\n/);
const obj = {};
const appConfig = {};
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  // remove optional surrounding quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  // Only expose VITE_ prefixed keys by default
  if (key.startsWith('VITE_')) obj[key] = val;
}

// 同時建立 window.APP_CONFIG，將常用的 VITE_* 名稱轉為頁面期望的鍵名
// 映射示例：VITE_ZHIPU_API_KEY -> ZHIPU_API_KEY
if (obj.VITE_ZHIPU_API_KEY) appConfig.ZHIPU_API_KEY = obj.VITE_ZHIPU_API_KEY;
if (obj.VITE_DEEPSEEK_API_KEY) appConfig.DEEPSEEK_API_KEY = obj.VITE_DEEPSEEK_API_KEY;
if (obj.VITE_LONGCAT_API_KEY) appConfig.LONGCAT_API_KEY = obj.VITE_LONGCAT_API_KEY;
if (obj.VITE_AMAP_KEY) appConfig.AMAP_KEY = obj.VITE_AMAP_KEY;
if (obj.VITE_AMAP_SECURITY_JS_CODE) appConfig.AMAP_SECURITY_JS_CODE = obj.VITE_AMAP_SECURITY_JS_CODE;
if (obj.VITE_WEATHER_API_KEY) appConfig.WEATHER_API_KEY = obj.VITE_WEATHER_API_KEY;

const content = `window.__ENV__ = ${JSON.stringify(obj, null, 2)};\nwindow.APP_CONFIG = ${JSON.stringify(appConfig, null, 2)};`;
fs.writeFileSync(outPath, content, 'utf8');
console.log('Wrote', outPath, 'with keys:', Object.keys(obj));
