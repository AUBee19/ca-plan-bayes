import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('Compliance: App Code size budget <= 51,200 bytes (50 KB)', () => {
  const appFiles = [
    'index.html',
    'styles.css',
    'src/subsidyEngine.js',
    'src/bayesEngine.js',
    'src/planParser.js',
    'src/app.js'
  ];

  let totalAppBytes = 0;
  for (const f of appFiles) {
    const fullPath = path.join(projectRoot, f);
    const stat = fs.statSync(fullPath);
    totalAppBytes += stat.size;
  }

  assert.ok(
    totalAppBytes <= 51200,
    `App Code size exceeded 51,200 bytes budget: ${totalAppBytes} bytes measured.`
  );
});

test('Compliance: Static Datasets size budget <= 40,960 bytes (40 KB)', () => {
  const dataFiles = [
    'data/provenance.json',
    'data/ca_benefits.json',
    'data/priors.json'
  ];

  let totalDataBytes = 0;
  for (const f of dataFiles) {
    const fullPath = path.join(projectRoot, f);
    const stat = fs.statSync(fullPath);
    totalDataBytes += stat.size;
  }

  assert.ok(
    totalDataBytes <= 40960,
    `Datasets size exceeded 40,960 bytes budget: ${totalDataBytes} bytes measured.`
  );
});

test('Compliance: Data freshness gate (lastVerified <= 180 days old)', () => {
  const provPath = path.join(projectRoot, 'data/provenance.json');
  const prov = JSON.parse(fs.readFileSync(provPath, 'utf-8'));
  const lastVerifiedStr = prov.lastVerified;
  assert.ok(lastVerifiedStr, 'provenance.json must contain lastVerified field');

  const verifiedDate = new Date(lastVerifiedStr);
  const now = new Date();
  const diffDays = Math.round(Math.abs(now - verifiedDate) / (1000 * 60 * 60 * 24));

  assert.ok(
    diffDays <= 180,
    `Dataset freshness expired: lastVerified is ${diffDays} days old (> 180 days).`
  );
});

test('Compliance: Network lint (no unauthorized external URLs in source code)', () => {
  const allowlist = ['coveredca.com', 'dhcs.ca.gov', 'hhs.gov'];
  const sourceFiles = [
    'index.html',
    'styles.css',
    'src/subsidyEngine.js',
    'src/bayesEngine.js',
    'src/planParser.js',
    'src/app.js'
  ];

  const urlRegex = /https?:\/\/([^\s/'"<>`]+)/gi;

  for (const f of sourceFiles) {
    const content = fs.readFileSync(path.join(projectRoot, f), 'utf-8');
    let match;
    while ((match = urlRegex.exec(content)) !== null) {
      const domain = match[1].toLowerCase();
      const isAllowed = allowlist.some(allowed => domain === allowed || domain.endsWith('.' + allowed));
      assert.ok(
        isAllowed,
        `Unauthorized external URL detected in ${f}: "${match[0]}". Domain "${domain}" is not in allowlist: ${allowlist.join(', ')}`
      );
    }
  }
});

test('Compliance: Fetch lint (fetch and XMLHttpRequest allowed ONLY in src/app.js)', () => {
  const forbiddenFiles = [
    'src/subsidyEngine.js',
    'src/bayesEngine.js',
    'src/planParser.js'
  ];

  for (const f of forbiddenFiles) {
    const content = fs.readFileSync(path.join(projectRoot, f), 'utf-8');
    assert.ok(
      !content.includes('fetch('),
      `Fetch lint violation: fetch() detected in ${f}. Only src/app.js may call fetch.`
    );
    assert.ok(
      !content.includes('XMLHttpRequest'),
      `Fetch lint violation: XMLHttpRequest detected in ${f}.`
    );
  }
});

test('Compliance: Magic-number lint (no hardcoded claim distribution values in src/bayesEngine.js)', () => {
  const bayesSrc = fs.readFileSync(path.join(projectRoot, 'src/bayesEngine.js'), 'utf-8');
  assert.ok(
    !bayesSrc.includes('frequency_lambda:'),
    'Magic-number violation: frequency_lambda assignment found in src/bayesEngine.js. Must be read from priors.json.'
  );
  assert.ok(
    !bayesSrc.includes('severity_mean:'),
    'Magic-number violation: severity_mean assignment found in src/bayesEngine.js. Must be read from priors.json.'
  );
});
