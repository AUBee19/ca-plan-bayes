export function createMulberry32(seed) {
let s = Math.floor(seed) >>> 0;
return function() {
s = (s + 0x6D2B79F5) >>> 0;
let t = Math.imul(s ^ (s >>> 15), 1 | s);
t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
}
function sampleNormal(rng) {
let u1 = rng(), u2 = rng();
while (u1 <= 1e-15) u1 = rng();
return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}
function samplePoisson(lambda, rng) {
if (lambda <= 0) return 0;
if (lambda > 100) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * sampleNormal(rng)));
const L = Math.exp(-lambda);
let k = 0, p = 1.0;
do { k++; p *= rng(); } while (p > L);
return k - 1;
}
export function validatePriors(d) {
if (!d?.claim_distributions) throw new Error('priorsData.claim_distributions is required and missing.');
for (const s of ['S1', 'S2', 'S3', 'S4']) {
if (!d.claim_distributions[s]) throw new Error(`Missing state ${s}`);
for (const b of ['outpatient_visits', 'generic_rx', 'brand_specialty_rx', 'er_inpatient']) {
const x = d.claim_distributions[s][b];
if (!x || typeof x.frequency_lambda !== 'number' || typeof x.severity_mean !== 'number' || typeof x.severity_sd !== 'number') {
throw new Error(`claim_distributions missing required numeric parameters for ${s}.${b}`);
}
}
}
}
export function validateProvenance(p) {
if (!p) throw new Error('provenanceData is required.');
if (typeof p.annual_hsa_limit_ind?.value !== 'number') throw new Error('annual_hsa_limit_ind is required and missing or non-numeric.');
if (typeof p.annual_hsa_limit_fam?.value !== 'number') throw new Error('annual_hsa_limit_fam is required and missing or non-numeric.');
}
export function validateBenefitTier(name, b) {
const fields = ['medical_deductible_ind', 'rx_deductible_ind', 'oop_max_ind', 'medical_deductible_fam', 'oop_max_fam', 'pre_deductible_pcp_visits', 'pcp_copay', 'specialist_copay', 'coinsurance_rate'];
for (const f of fields) {
if (typeof b[f] !== 'number' || Number.isNaN(b[f])) throw new Error(`Tier ${name} missing numeric field ${f}`);
}
if (typeof b.hsa_eligible !== 'boolean') throw new Error(`Tier ${name} missing boolean hsa_eligible`);
if (b.family_deductible_structure !== 'embedded' && b.family_deductible_structure !== 'aggregate') {
throw new Error(`Tier ${name} invalid family_deductible_structure`);
}
}
export function computePosterior(inputs, priorsData) {
validatePriors(priorsData);
const age = inputs.ageBand || '35-44';
const sex = (inputs.sex || 'female').toLowerCase();
const states = ['S1', 'S2', 'S3', 'S4'];
const prior = priorsData.priors?.[age]?.[sex] || { S1: 0.5, S2: 0.3, S3: 0.15, S4: 0.05 };
const g1 = priorsData.clusters?.cluster_1_chronic_rx?.gamma ?? 0.65;
const g2 = priorsData.clusters?.cluster_2_behavioral?.gamma ?? 0.55;
const g3 = priorsData.clusters?.cluster_3_acuity_baseline?.gamma ?? 0.35;
const t1 = priorsData.clusters?.cluster_1_chronic_rx?.lr_table?.[inputs.chronicRxKey || 'none_none'] || { S1: 1, S2: 1, S3: 1, S4: 1 };
const t2 = priorsData.clusters?.cluster_2_behavioral?.lr_table?.[inputs.behavioralKey || 'none'] || { S1: 1, S2: 1, S3: 1, S4: 1 };
const t3 = priorsData.clusters?.cluster_3_acuity_baseline?.lr_table?.[inputs.acuityKey || 'routine'] || { S1: 1, S2: 1, S3: 1, S4: 1 };
const logP = {}, shifts = { cluster1: {}, cluster2: {}, cluster3: {} };
for (const s of states) {
const s1 = g1 * Math.log(Math.max(t1[s] ?? 1, 1e-6));
const s2 = g2 * Math.log(Math.max(t2[s] ?? 1, 1e-6));
const s3 = g3 * Math.log(Math.max(t3[s] ?? 1, 1e-6));
shifts.cluster1[s] = s1; shifts.cluster2[s] = s2; shifts.cluster3[s] = s3;
logP[s] = Math.log(Math.max(prior[s] ?? 0.25, 1e-6)) + s1 + s2 + s3;
}
const maxL = Math.max(...states.map(s => logP[s]));
const sumExp = states.reduce((sum, s) => sum + Math.exp(logP[s] - maxL), 0);
const posterior = {};
states.forEach(s => posterior[s] = Math.exp(logP[s] - maxL) / sumExp);
return { posterior, shiftsByCluster: shifts, states };
}
export function calculateHsaTaxSavings(plan, inputs, provenanceData) {
validateProvenance(provenanceData);
if (!plan.hdhp_hsa) return 0;
if (!inputs.isCommercialPlan && (inputs.fplPercent ?? 300) <= 250) return 0;
const size = Math.max(1, parseInt(inputs.householdSize, 10) || 1);
const limit = size === 1 ? provenanceData.annual_hsa_limit_ind.value : provenanceData.annual_hsa_limit_fam.value;
const contrib = Math.min(Math.max(0, parseFloat(inputs.hsaContribution) || 0), limit);
const rate = Math.max(0, Math.min(0.55, parseFloat(inputs.marginalTaxRate) || 0.22));
const fica = inputs.isPayrollFicaExempt ? 0.0765 : 0;
return contrib * (rate + fica);
}
export function simulatePlans(plans, inputs, priorsData, benefitsData, provenanceData, opts = {}) {
validatePriors(priorsData);
validateProvenance(provenanceData);
const N = opts.simulations || 5000;
const lambda = typeof opts.lambdaRisk === 'number' ? opts.lambdaRisk : 0.25;
const { posterior, shiftsByCluster } = computePosterior(inputs, priorsData);
const states = ['S1', 'S2', 'S3', 'S4'];
const cum = [];
let acc = 0;
states.forEach(s => { acc += posterior[s]; cum.push({ s, c: acc }); });
const size = Math.max(1, parseInt(inputs.householdSize, 10) || 1);
const isFam = size > 1;
const rng = createMulberry32(opts.seed || 12345);
const draws = new Array(N);
for (let i = 0; i < N; i++) {
const r = rng();
let state = 'S1';
for (const item of cum) { if (r <= item.c) { state = item.s; break; } }
const dist = priorsData.claim_distributions[state];
let opCnt = samplePoisson(dist.outpatient_visits.frequency_lambda, rng);
let opCost = 0;
for (let k = 0; k < opCnt; k++) opCost += Math.max(10, dist.outpatient_visits.severity_mean + dist.outpatient_visits.severity_sd * sampleNormal(rng));
const genCnt = samplePoisson(dist.generic_rx.frequency_lambda, rng);
let genCost = 0;
for (let k = 0; k < genCnt; k++) genCost += Math.max(5, dist.generic_rx.severity_mean + dist.generic_rx.severity_sd * sampleNormal(rng));
const brCnt = samplePoisson(dist.brand_specialty_rx.frequency_lambda, rng);
let brCost = 0;
for (let k = 0; k < brCnt; k++) brCost += Math.max(20, dist.brand_specialty_rx.severity_mean + dist.brand_specialty_rx.severity_sd * sampleNormal(rng));
const erCnt = samplePoisson(dist.er_inpatient.frequency_lambda, rng);
let erCost = 0;
for (let k = 0; k < erCnt; k++) erCost += Math.max(100, dist.er_inpatient.severity_mean + dist.er_inpatient.severity_sd * sampleNormal(rng));
let members;
if (!isFam) {
members = [{ opCnt, opCost, rxCost: genCost + brCost, erCost }];
} else {
const depCnt = size - 1;
const pF = 0.60, dF = 0.40 / depCnt;
members = [{ opCnt: Math.round(opCnt * pF), opCost: opCost * pF, rxCost: (genCost + brCost) * pF, erCost: erCost * pF }];
for (let d = 0; d < depCnt; d++) {
members.push({ opCnt: Math.round(opCnt * dF), opCost: opCost * dF, rxCost: (genCost + brCost) * dF, erCost: erCost * dF });
}
}
draws[i] = members;
}
const results = plans.map(p => {
const tier = p.metal_tier || 'Silver';
const b = { ...(benefitsData.tiers?.[tier] || benefitsData.tiers?.Silver), ...p.custom_benefits };
validateBenefitTier(p.plan_name || tier, b);
const netPrem = Math.max(1.0, parseFloat(p.monthly_premium_after_subsidy) || 0);
const annPrem = netPrem * 12;
const hsa = calculateHsaTaxSavings(p, inputs, provenanceData);
const oopSims = new Float64Array(N);
let sumOop = 0;
for (let i = 0; i < N; i++) {
const mems = draws[i];
let oop = 0;
if (!isFam) {
const m = mems[0];
let mDed = b.medical_deductible_ind;
let rDed = b.rx_deductible_ind;
const freeV = Math.min(m.opCnt, b.pre_deductible_pcp_visits);
let mOop = freeV * b.pcp_copay;
const vCost = m.opCnt > 0 ? (m.opCost / m.opCnt) : 0;
const medClaims = (m.opCnt - freeV) * vCost + m.erCost;
if (mDed > 0) {
const a = Math.min(medClaims, mDed);
mOop += a + (medClaims - a) * b.coinsurance_rate;
} else mOop += medClaims * b.coinsurance_rate;
if (rDed > 0) {
const a = Math.min(m.rxCost, rDed);
mOop += a + (m.rxCost - a) * b.coinsurance_rate;
} else mOop += m.rxCost * b.coinsurance_rate;
oop = Math.min(mOop, b.oop_max_ind);
} else {
if (b.family_deductible_structure === 'aggregate') {
let totMed = 0, totRx = 0;
mems.forEach(m => { totMed += m.opCost + m.erCost; totRx += m.rxCost; });
const tot = totMed + totRx;
const a = Math.min(tot, b.medical_deductible_fam);
oop = Math.min(a + (tot - a) * b.coinsurance_rate, b.oop_max_fam);
} else {
let famMedRem = b.medical_deductible_fam;
let famAccum = 0;
for (const m of mems) {
let mDed = Math.min(b.medical_deductible_ind, famMedRem);
const freeV = Math.min(m.opCnt, b.pre_deductible_pcp_visits);
let mOop = freeV * b.pcp_copay;
const vCost = m.opCnt > 0 ? (m.opCost / m.opCnt) : 0;
const medClaims = (m.opCnt - freeV) * vCost + m.erCost;
if (mDed > 0) {
const a = Math.min(medClaims, mDed);
mOop += a + (medClaims - a) * b.coinsurance_rate;
famMedRem = Math.max(0, famMedRem - a);
} else mOop += medClaims * b.coinsurance_rate;
if (b.rx_deductible_ind > 0) {
const a = Math.min(m.rxCost, b.rx_deductible_ind);
mOop += a + (m.rxCost - a) * b.coinsurance_rate;
} else mOop += m.rxCost * b.coinsurance_rate;
famAccum += Math.min(mOop, b.oop_max_ind);
}
oop = Math.min(famAccum, b.oop_max_fam);
}
}
oopSims[i] = oop;
sumOop += oop;
}
const mean = sumOop / N;
let varSum = 0;
for (let i = 0; i < N; i++) varSum += (oopSims[i] - mean) ** 2;
const sd = Math.sqrt(varSum / N);
const sorted = new Float64Array(oopSims).sort();
const tail95 = sorted[Math.floor(0.95 * N)];
const eac = annPrem + mean - hsa;
return {
plan: p, tierName: tier, netMonthlyPremium: netPrem, annualPremium: annPrem, hsaSavings: hsa,
meanOop: mean, stdDevOop: sd, tailOop95: tail95, worstCaseCeiling: annPrem + (isFam ? b.oop_max_fam : b.oop_max_ind),
eac, utility: eac + lambda * sd,
simTotalCosts: new Float64Array(N).map((_, idx) => annPrem + oopSims[idx] - hsa)
};
});
const winCounts = new Float64Array(results.length);
for (let i = 0; i < N; i++) {
let minC = Infinity, ties = [];
results.forEach((r, idx) => {
const c = r.simTotalCosts[i];
if (c < minC - 1e-6) { minC = c; ties = [idx]; }
else if (Math.abs(c - minC) <= 1e-6) ties.push(idx);
});
ties.forEach(tIdx => winCounts[tIdx] += 1.0 / ties.length);
}
results.forEach((r, idx) => r.winProbability = (winCounts[idx] / N) * 100);
results.forEach((p1, i) => {
p1.isFirstOrderDominated = false;
p1.isRiskAdjustedDominated = false;
results.forEach((p2, j) => {
if (i === j) return;
if (p2.annualPremium <= p1.annualPremium && p2.meanOop <= p1.meanOop && (p2.annualPremium < p1.annualPremium || p2.meanOop < p1.meanOop)) {
p1.isFirstOrderDominated = true;
}
if (p2.utility < p1.utility && p2.tailOop95 <= p1.tailOop95) {
p1.isRiskAdjustedDominated = true;
}
});
});
results.sort((a, b) => a.utility - b.utility);
let topState = 'S1', maxP = -1;
states.forEach(s => { if (posterior[s] > maxP) { maxP = posterior[s]; topState = s; } });
const drivers = [
{ name: 'Chronic & Prescription Care', shift: shiftsByCluster.cluster1[topState] || 0 },
{ name: 'Behavioral & Therapy Care', shift: shiftsByCluster.cluster2[topState] || 0 },
{ name: 'Acute Care & Utilization History', shift: shiftsByCluster.cluster3[topState] || 0 }
].sort((a, b) => b.shift - a.shift).slice(0, 2);
const winner = results[0], runner = results[1] || null;
const cur = results.find(r => r.plan.is_current_plan) || null;
return {
planResults: results, posterior, highestState: topState,
attribution: {
topState, topDrivers: drivers,
winnerSavingsVsRunnerUp: runner ? runner.eac - winner.eac : 0,
winnerSavingsVsCurrent: cur && cur !== winner ? cur.eac - winner.eac : null
}
};
}