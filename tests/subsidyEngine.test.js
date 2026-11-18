import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  calculateFplThreshold,
  calculateFplPercent,
  evaluateResidency,
  screenMediCal,
  evaluateCliffAlerts
} from '../src/subsidyEngine.js';

const provenance = JSON.parse(fs.readFileSync(new URL('../data/provenance.json', import.meta.url), 'utf-8'));

test('FPL scaling across household sizes', () => {
  const base = provenance.fpl_base_1_person.value;
  const perAdd = provenance.fpl_per_additional_person.value;

  assert.equal(calculateFplThreshold(1, provenance), base);
  assert.equal(calculateFplThreshold(2, provenance), base + perAdd);
  assert.equal(calculateFplThreshold(4, provenance), base + 3 * perAdd);

  // Income at 100% FPL
  const t1 = calculateFplThreshold(1, provenance);
  assert.equal(Math.round(calculateFplPercent(t1, 1, provenance)), 100);

  // Income at 200% FPL
  assert.equal(Math.round(calculateFplPercent(t1 * 2, 1, provenance)), 200);
});

test('Residency eligibility routing and suppression', () => {
  const lawful = evaluateResidency('lawfully_present', 220);
  assert.equal(lawful.canRankMarketplace, true);
  assert.equal(lawful.handoffToCEC, false);

  const mediCalOnly = evaluateResidency('ca_medi_cal_only', 120);
  assert.equal(mediCalOnly.canRankMarketplace, false);
  assert.equal(mediCalOnly.routingTarget, 'medi_cal_expanded');
  assert.equal(mediCalOnly.handoffToCEC, true);

  const unsure = evaluateResidency('unsure_or_mixed', 180);
  assert.equal(unsure.canRankMarketplace, false);
  assert.equal(unsure.routingTarget, 'cec_guidance');
  assert.equal(unsure.handoffToCEC, true);
});

test('Cautious Medi-Cal screening triggers <= 138% FPL', () => {
  const adultEligible = screenMediCal(135, false);
  assert.equal(adultEligible.likelyEligible, true);
  assert.equal(adultEligible.suppressHsaSteering, true);
  assert.equal(adultEligible.guaranteeZeroCost, false);

  const adultIneligible = screenMediCal(145, false);
  assert.equal(adultIneligible.likelyEligible, false);

  const pediatricEligible = screenMediCal(210, true);
  assert.equal(pediatricEligible.likelyEligible, true);
  assert.equal(pediatricEligible.childrenEligible, true);
});

test('±15% MAGI cliff alerts trigger around {138, 150, 200, 400}% FPL', () => {
  const threshold = calculateFplThreshold(1, provenance);

  // Exactly at 150% FPL: ±15% spans 127.5% - 172.5%, crossing 138% and 150%
  const income150 = threshold * 1.50;
  const alert150 = evaluateCliffAlerts(income150, 1, provenance);
  assert.equal(alert150.cliffAlert, true);
  assert.ok(alert150.crossedCliffs.includes(138) || alert150.crossedCliffs.includes(150));

  // Income far from any cliff, e.g. 300% FPL: ±15% spans 255% - 345%, no cliff crossed
  const income300 = threshold * 3.00;
  const alert300 = evaluateCliffAlerts(income300, 1, provenance);
  assert.equal(alert300.cliffAlert, false);
  assert.equal(alert300.crossedCliffs.length, 0);

  // Income at 400% FPL: ±15% spans 340% - 460%, crossing 400%
  const income400 = threshold * 4.00;
  const alert400 = evaluateCliffAlerts(income400, 1, provenance);
  assert.equal(alert400.cliffAlert, true);
  assert.ok(alert400.crossedCliffs.includes(400));
});
