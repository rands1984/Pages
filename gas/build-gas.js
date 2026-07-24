#!/usr/bin/env node
/**
 * GAS用ビルドスクリプト
 * Vite出力を GAS HtmlService 用の css.html / js.html に変換
 */
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
const assetsDir = path.join(distDir, 'assets');

// ビルド出力ファイル探索
const jsFile = fs.readdirSync(assetsDir).find(f => f.endsWith('.js') && !f.endsWith('.map'));
const cssFile = fs.readdirSync(assetsDir).find(f => f.endsWith('.css') && !f.endsWith('.map'));

if (!jsFile || !cssFile) {
  console.error('❌ Asset files not found');
  process.exit(1);
}

const jsContent = fs.readFileSync(path.join(assetsDir, jsFile), 'utf-8');
const cssContent = fs.readFileSync(path.join(assetsDir, cssFile), 'utf-8');

// css.html 生成
const cssHtml = `<style>\n${cssContent}\n</style>`;
fs.writeFileSync(path.join(distDir, 'css.html'), cssHtml);
console.log('✅ css.html generated');

// js.html 生成（GAS_API_URL 埋め込み対応）
const jsHtml = `<script>\n${jsContent}\n</script>`;
fs.writeFileSync(path.join(distDir, 'js.html'), jsHtml);
console.log('✅ js.html generated');

// index.html を GAS テンプレート用に書き換え
const indexPath = path.join(distDir, 'index.html');
let indexHtml = fs.readFileSync(indexPath, 'utf-8');

// metaタグで GAS_API_URL を埋め込み、include で css/js を読み込み
indexHtml = indexHtml
  .replace(
    /<head>([\s\S]*?)<\/head>/,
    `<head>$1\n  <meta name="gas-api-url" content="<?= apiUrl ?>">\n  <?!= include('css'); ?>\n</head>`
  )
  .replace(
    /<body>([\s\S]*?)<\/body>/,
    `<body>$1\n  <?!= include('js'); ?>\n</body>`
  )
  .replace(/<script type="module" crossorigin src="\/assets\/main\.js"><\/script>\s*/, '')
  .replace(/<link rel="stylesheet" crossorigin href="\/assets\/main\.css">\s*/, '');

fs.writeFileSync(indexPath, indexHtml);
console.log('✅ index.html updated for GAS template');

console.log('\n📦 Build complete. Files in gas/dist/:');
console.log('  - index.html (GAS template)');
console.log('  - css.html (inlined styles)');
console.log('  - js.html (inlined scripts)');
console.log('  - Code.gs (push separately)');