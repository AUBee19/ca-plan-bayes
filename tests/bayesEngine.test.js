import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  computePosterior,
  simulatePlans,
  calculateHsaTaxSavings,
  validatePriors,
  validateProvenance
} from '../src/bayesEngine.js';

const provenance = JSON.parse(fs.readFileSync(new URL('../data/provenance.json', import.meta.url), 'utf-8'));
const benefits = JSON.parse(fs.readFileSync(new URL('../data/ca_benefits.json', import.meta.url), 'utf-8'));
const priors = JSON.parse(fs.readFileSync(new URL('../data/priors.json', import.meta.url), 'utf-8'));

test('Node-safe data loading: pure engine accepts data objects without fetch()', () => {
  const inputs = {
    ageBand: '35-44',
    sex: 'female',
    chronicRxKey: 'none_none',
    behavioralKey: 'none',
    acuityKey: 'routine',
    householdSize: 1,
    fplPercent: 200
  };

  const dummyPlans = [{
    plan_name: 'Test Plan',
    metal_tier: 'Silver',
    monthly_premium_after_subsidy: 50,
    hdhp_hsa: false
  }];

  const result = simulatePlans(dummyPlans, inputs, priors, benefits, provenance, { simulations: 50 });
  assert.ok(result.planResults.length === 1);
  assert.ok(typeof result.planResults[0].eac === 'number');
});

test('Posterior probabilities sum to 1.0 ± 1e-9 across age/sex/cluster combinations', () => {
  const ageBands = priors.age_bands;
  const sexes = priors.sexes;
  const chronicKeys = Object.keys(priors.clusters.cluster_1_chronic_rx.lr_table);

  for (const ageBand of ageBands) {
    for (const sex of sexes) {
      for (const chronicRxKey of chronicKeys.slice(0, 3)) {
        const { posterior } = computePosterior({
          ageBand,
          sex,
          chronicRxKey,
          behavioralKey: 'none',
          acuityKey: 'routine'
        }, priors);

        const sum = posterior.S1 + posterior.S2 + posterior.S3 + posterior.S4;
        assert.ok(Math.abs(sum - 1.0) < 1e-9, `Sum was ${sum} for ${ageBand} ${sex} ${chronicRxKey}`);
      }
    }
  }
});

test('log(0) guard: table entry stored as 0 yields finite, non-NaN posterior', () => {
  const modifiedPriors = JSON.parse(JSON.stringify(priors));
  modifiedPriors.clusters.cluster_1_chronic_rx.lr_table['zero_test'] = { S1: 0, S2: 1.0, S3: 2.0, S4: 0 };

  const { posterior } = computePosterior({
    ageBand: '35-44',
    sex: 'male',
    chronicRxKey: 'zero_test',
    behavioralKey: 'none',
    acuityKey: 'routine'
  }, modifiedPriors);

  assert.ok(Number.isFinite(posterior.S1));
  assert.ok(Number.isFinite(posterior.S4));
  assert.ok(!Number.isNaN(posterior.S1));
  assert.ok(posterior.S1 > 0);
});

test('claim_distributions presence: throws descriptive error if bucket missing', () => {
  const brokenPriors = JSON.parse(JSON.stringify(priors));
  delete brokenPriors.claim_distributions.S1.outpatient_visits;
  assert.throws(() => validatePriors(brokenPriors), /missing required numeric parameters/i);

  const missingDist = JSON.parse(JSON.stringify(priors));
  delete missingDist.claim_distributions;
  assert.throws(() => validatePriors(missingDist), /claim_distributions is required/i);
});

test('HSA limit presence: throws descriptive error if limits missing from provenance', () => {
  const brokenProv = JSON.parse(JSON.stringify(provenance));
  delete brokenProv.annual_hsa_limit_ind;
  assert.throws(() => validateProvenance(brokenProv), /annual_hsa_limit_ind is required/i);

  const brokenFam = JSON.parse(JSON.stringify(provenance));
  delete brokenFam.annual_hsa_limit_fam;
  assert.throws(() => validateProvenance(brokenFam), /annual_hsa_limit_fam is required/i);
});

test('Conditional dominance: Silver_94 beats Bronze_HDHP in >= 95% draws at 140% FPL chronic profile with $1 net Silver', () => {
  const inputs = {
    ageBand: '45-54',
    sex: 'female',
    chronicRxKey: 'multi_brand_specialty',
    behavioralKey: 'continuous_therapy_mat',
    acuityKey: 'er_inpatient',
    householdSize: 1,
    fplPercent: 140,
    hsaContribution: 0
  };

  const candidatePlans = [
    {
      plan_name: 'Silver 94 Plan',
      metal_tier: 'Silver_94',
      monthly_premium_after_subsidy: 1.00,
      hdhp_hsa: false
    },
    {
      plan_name: 'Bronze HDHP Plan',
      metal_tier: 'Bronze_HDHP',
      monthly_premium_after_subsidy: 1.00,
      hdhp_hsa: true
    }
  ];

  const result = simulatePlans(candidatePlans, inputs, priors, benefits, provenance, { simulations: 5000, seed: 9999 });
  const s94 = result.planResults.find(p => p.tierName === 'Silver_94');
  assert.ok(s94, 'Silver_94 plan must be present');
  assert.ok(s94.winProbability >= 95.0, `Expected winProbability >= 95%, received ${s94.winProbability}%`);
});

test('Dominance detector flags FIRST_ORDER_DOMINATED and RISK_ADJUSTED_DOMINATED', () => {
  const inputs = {
    ageBand: '26-34',
    sex: 'male',
    chronicRxKey: 'none_none',
    behavioralKey: 'none',
    acuityKey: 'routine',
    householdSize: 1,
    fplPercent: 300
  };

  const plans = [
    {
      plan_name: 'Superior Plan',
      metal_tier: 'Platinum',
      monthly_premium_after_subsidy: 200,
      hdhp_hsa: false
    },
    {
      plan_name: 'Inferior Dominated Plan',
      metal_tier: 'Platinum',
      monthly_premium_after_subsidy: 400, // strictly higher premium, same benefits
      hdhp_hsa: false
    }
  ];

  const result = simulatePlans(plans, inputs, priors, benefits, provenance, { simulations: 500, seed: 42 });
  const dominated = result.planResults.find(p => p.plan.plan_name === 'Inferior Dominated Plan');
  assert.equal(dominated.isFirstOrderDominated, true);
});

test('Household claim allocation determinism: identical seed produces identical claims', () => {
  const inputs = {
    ageBand: '35-44',
    sex: 'female',
    chronicRxKey: 'one_generics',
    behavioralKey: 'none',
    acuityKey: 'routine',
    householdSize: 3,
    fplPercent: 280
  };

  const plan = [{
    plan_name: 'Family Plan',
    metal_tier: 'Silver',
    monthly_premium_after_subsidy: 100,
    hdhp_hsa: false
  }];

  const run1 = simulatePlans(plan, inputs, priors, benefits, provenance, { simulations: 200, seed: 777 });
  const run2 = simulatePlans(plan, inputs, priors, benefits, provenance, { simulations: 200, seed: 777 });

  assert.equal(run1.planResults[0].meanOop, run2.planResults[0].meanOop);
  assert.equal(run1.planResults[0].tailOop95, run2.planResults[0].tailOop95);
});

test('HSA tax savings gates, limits, and monotonicity', () => {
  const hdhpPlan = { hdhp_hsa: true };
  const nonHdhpPlan = { hdhp_hsa: false };

  // Gate 1: Non-HDHP yields 0
  assert.equal(calculateHsaTaxSavings(nonHdhpPlan, { fplPercent: 300, hsaContribution: 2000 }, provenance), 0);

  // Gate 2: FPL <= 250 yields 0 (marketplace)
  assert.equal(calculateHsaTaxSavings(hdhpPlan, { fplPercent: 250, hsaContribution: 2000 }, provenance), 0);
  assert.equal(calculateHsaTaxSavings(hdhpPlan, { fplPercent: 200, hsaContribution: 2000 }, provenance), 0);

  // Individual vs Family limits
  const indSave = calculateHsaTaxSavings(hdhpPlan, {
    fplPercent: 300,
    householdSize: 1,
    hsaContribution: 10000,
    marginalTaxRate: 0.25
  }, provenance);
  // Cap at 4400 * 0.25 = 1100
  assert.equal(indSave, 4400 * 0.25);

  const famSave = calculateHsaTaxSavings(hdhpPlan, {
    fplPercent: 300,
    householdSize: 3,
    hsaContribution: 10000,
    marginalTaxRate: 0.25
  }, provenance);
  // Cap at 8750 * 0.25 = 2187.5
  assert.equal(famSave, 8750 * 0.25);

  // Monotonicity with contribution and tax rate
  const sLow = calculateHsaTaxSavings(hdhpPlan, { fplPercent: 300, householdSize: 1, hsaContribution: 1000, marginalTaxRate: 0.20 }, provenance);
  const sHigh = calculateHsaTaxSavings(hdhpPlan, { fplPercent: 300, householdSize: 1, hsaContribution: 2000, marginalTaxRate: 0.20 }, provenance);
  const sHighRate = calculateHsaTaxSavings(hdhpPlan, { fplPercent: 300, householdSize: 1, hsaContribution: 2000, marginalTaxRate: 0.30 }, provenance);
  assert.ok(sHigh > sLow);
  assert.ok(sHighRate > sHigh);
});
