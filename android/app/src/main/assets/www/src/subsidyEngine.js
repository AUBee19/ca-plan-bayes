export function calculateFplThreshold(householdSize, provenance) {
const size = Math.max(1, parseInt(householdSize, 10) || 1);
return provenance.fpl_base_1_person.value + (size - 1) * provenance.fpl_per_additional_person.value;
}
export function calculateFplPercent(magi, householdSize, provenance) {
return ((Math.max(0, parseFloat(magi) || 0)) / calculateFplThreshold(householdSize, provenance)) * 100;
}
export function evaluateResidency(status = 'lawfully_present', fplPercent) {
if (status === 'ca_medi_cal_only') {
return {
status, canRankMarketplace: false, routingTarget: 'medi_cal_expanded',
title: 'California Age-Expanded Medi-Cal Notice',
message: 'Under California law, full-scope Medi-Cal is accessible regardless of immigration status if income criteria are met.',
handoffToCEC: true
};
}
if (status === 'unsure_or_mixed') {
return {
status, canRankMarketplace: false, routingTarget: 'cec_guidance',
title: 'Confidential Counselor Guidance Recommended',
message: 'Mixed-status households or uncertain residency cases require specialized enrollment structuring.',
handoffToCEC: true
};
}
return {
status: 'lawfully_present', canRankMarketplace: true, routingTarget: 'marketplace',
title: 'Marketplace & Subsidy Eligible',
message: 'Eligible for federal APTC, CA state subsidies, and CSR silver tiers.',
handoffToCEC: false
};
}
export function screenMediCal(fplPercent, hasChildren = false) {
const isAdult = fplPercent <= 138;
const isChild = hasChildren && fplPercent <= 266;
if (isAdult || isChild) {
return {
likelyEligible: true, suppressHsaSteering: true, adultEligible: isAdult, childrenEligible: isChild,
headline: 'Likely Medi-Cal Eligible — verify at CoveredCA.com or with a CEC',
detail: 'California Medi-Cal provides comprehensive care with $0 premiums and no deductibles.',
guaranteeZeroCost: false
};
}
return { likelyEligible: false, suppressHsaSteering: false, adultEligible: false, childrenEligible: false };
}
export function evaluateCliffAlerts(magi, householdSize, provenance) {
const t = calculateFplThreshold(householdSize, provenance);
const inc = Math.max(0, parseFloat(magi) || 0);
const currentFpl = (inc / t) * 100;
const lowFpl = (inc * 0.85 / t) * 100;
const highFpl = (inc * 1.15 / t) * 100;
const cliffThresholds = (provenance.cliff_thresholds?.value || [1.38, 1.50, 2.00, 4.00]).map(v => v * 100);
const crossed = cliffThresholds.filter(c => lowFpl <= c && highFpl >= c);
if (!crossed.length) return { cliffAlert: false, crossedCliffs: [], currentFpl, message: null };
const explanations = crossed.map(c => {
if (c === 138) return '138% FPL: Medi-Cal transition boundary.';
if (c === 150) return '150% FPL: Silver 94 boundary. Income above 150% drops CSR to Silver 87.';
if (c === 200) return '200% FPL: Silver 87 boundary. Income above 200% drops CSR to Silver 73.';
if (c === 400) return '400% FPL: Federal subsidy cliff repayment cap phaseout.';
return `${c}% FPL transition tier.`;
});
return {
cliffAlert: true, crossedCliffs: crossed, currentFpl, sensitivityRangeFpl: [lowFpl, highFpl],
message: `Income volatility alert: ±15% MAGI variation spans the ${crossed.join('%, ')}% FPL boundary. Be prepared for subsidy reconciliation on IRS Form 8962.`,
details: explanations
};
}