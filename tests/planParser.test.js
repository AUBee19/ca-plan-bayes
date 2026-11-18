import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CSV_HEADER_STRING,
  mapCsrTier,
  estimateBenchmarkTiers,
  parsePlanCsv,
  scrubPii,
  parsePastedPlanText
} from '../src/planParser.js';

const provenance = JSON.parse(fs.readFileSync(new URL('../data/provenance.json', import.meta.url), 'utf-8'));

test('CSV header matches exact single-line byte string with no line breaks', () => {
  const expectedHeader = 'plan_name,carrier,metal_tier,network_type,monthly_premium_after_subsidy,hdhp_hsa,pcp_in_network,specialist_therapist_in_network,drugs_covered,is_current_plan';
  assert.equal(CSV_HEADER_STRING, expectedHeader);
  assert.ok(!CSV_HEADER_STRING.includes('\n'));
  assert.ok(!CSV_HEADER_STRING.includes('\r'));
});

test('CSV parsing correctness and invalid header rejection', () => {
  const validCsv = `${CSV_HEADER_STRING}\nMy Gold Plan,Kaiser,Gold,HMO,240,false,true,true,true,true`;
  const parsed = parsePlanCsv(validCsv);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].plan_name, 'My Gold Plan');
  assert.equal(parsed[0].carrier, 'Kaiser');
  assert.equal(parsed[0].metal_tier, 'Gold');
  assert.equal(parsed[0].monthly_premium_after_subsidy, 240);
  assert.equal(parsed[0].is_current_plan, true);

  // Mismatched header throws
  assert.throws(() => parsePlanCsv('wrong,header,row\n1,2,3'), /CSV header mismatch/i);
});

test('Tier net-premium math: worked example 140% FPL, gross Silver $650, subsidy $650', () => {
  const plans = estimateBenchmarkTiers(650, 650, 140, 'lawfully_present', provenance);

  const bronze = plans.find(p => p.nominal_tier === 'Bronze');
  const bronzeHdhp = plans.find(p => p.nominal_tier === 'Bronze_HDHP');
  const silver = plans.find(p => p.nominal_tier === 'Silver');
  const gold = plans.find(p => p.nominal_tier === 'Gold');
  const plat = plans.find(p => p.nominal_tier === 'Platinum');

  // $1 floor applies when gross <= subsidy
  assert.equal(bronze.monthly_premium_after_subsidy, 1.00);
  assert.equal(bronzeHdhp.monthly_premium_after_subsidy, 1.00);
  assert.equal(silver.monthly_premium_after_subsidy, 1.00);

  // Silver at 140% FPL auto-maps to Silver_94 benefits
  assert.equal(silver.metal_tier, 'Silver_94');

  // Gold net = round(1.28 * 650 - 650) = 832 - 650 = 182
  assert.ok(Math.abs(gold.monthly_premium_after_subsidy - 182.00) <= 1.0);

  // Platinum net = round(1.55 * 650 - 650) = 1007.5 - 650 = 357.5 ~ 358
  assert.ok(Math.abs(plat.monthly_premium_after_subsidy - 358.00) <= 1.0);
});

test('$1.00 minimum premium floor: net price never $0 and never negative', () => {
  // Heavy subsidy exceeding all gross premiums
  const plans = estimateBenchmarkTiers(300, 1000, 120, 'lawfully_present', provenance);
  for (const p of plans) {
    assert.equal(p.monthly_premium_after_subsidy, 1.00);
  }
});

test('CSR auto-mapping boundary cases with exact floating-point comparisons', () => {
  const eps = 1e-9;

  assert.equal(mapCsrTier(150.0), 'Silver_94');
  assert.equal(mapCsrTier(150.0 + eps), 'Silver_87');

  assert.equal(mapCsrTier(200.0), 'Silver_87');
  assert.equal(mapCsrTier(200.0 + eps), 'Silver_73');

  assert.equal(mapCsrTier(250.0), 'Silver_73');
  assert.equal(mapCsrTier(250.0 + eps), 'Silver');

  assert.equal(mapCsrTier(300.0), 'Silver');
});

test('Node-safe data loading: planParser executes end-to-end without fetch', () => {
  const res = estimateBenchmarkTiers(450, 100, 220, 'lawfully_present', provenance);
  assert.equal(res.length, 5);
});

test('PII scrubbing on pasted text [Beta]', () => {
  const sensitiveText = `
    Applicant: Jane Doe (SSN: 123-45-6789)
    Email: jane.doe@example.com
    Phone: (555) 867-5309
    Address: 456 Elm Street, Apt 2B
    Member ID: CA-98765432
    Covered CA Silver Plan $150 / month
  `;

  const scrubbed = scrubPii(sensitiveText);
  assert.ok(!scrubbed.includes('123-45-6789'));
  assert.ok(!scrubbed.includes('jane.doe@example.com'));
  assert.ok(!scrubbed.includes('(555) 867-5309'));
  assert.ok(!scrubbed.includes('456 Elm Street'));
  assert.ok(!scrubbed.includes('CA-98765432'));
  assert.ok(scrubbed.includes('[REDACTED_SSN]'));
  assert.ok(scrubbed.includes('[REDACTED_EMAIL]'));

  const parsed = parsePastedPlanText(sensitiveText);
  assert.equal(parsed.success, true);
  assert.equal(parsed.plans.length, 1);
  assert.equal(parsed.plans[0].metal_tier, 'Silver');
  assert.equal(parsed.plans[0].monthly_premium_after_subsidy, 150);
});
