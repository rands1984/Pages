#!/usr/bin/env node
/**
 * esbuild で GAS用単一ファイル生成
 * TypeScript型チェックはスキップしてバンドルのみ
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');

async function build() {
  // distディレクトリ作成
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // esbuildでバンドル
  await esbuild.build({
    entryPoints: [path.join(srcDir, 'Code.ts')],
    bundle: true,
    platform: 'node',
    target: 'es2020',
    format: 'cjs',
    outfile: path.join(distDir, 'Code.gs'),
    external: ['google-apps-script'],
    banner: {
      js: '/* eslint-disable */\n"use strict";\n'
    },
    footer: {
      js: '\n//# sourceMappingURL=Code.gs.map'
    },
    sourcemap: true,
    define: {
      'global': 'globalThis',
      'process.env.NODE_ENV': '"production"'
    }
  });

  console.log('✅ Code.gs generated');

  // appsscript.json コピー
  fs.copyFileSync(
    path.join(srcDir, 'appsscript.json'),
    path.join(distDir, 'appsscript.json')
  );
  console.log('✅ appsscript.json copied');
}

build().catch(() => process.exit(1));