import { calculateFplPercent, evaluateResidency, screenMediCal, evaluateCliffAlerts } from './subsidyEngine.js';
import { simulatePlans } from './bayesEngine.js';
import { CSV_HEADER_STRING, estimateBenchmarkTiers, parsePlanCsv, parsePastedPlanText, createCommercialPlan } from './planParser.js';
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const $ = id => document.getElementById(id);
const v = id => $(id)?.value;
const state = { provenance: null, benefits: null, priors: null, activeTab: 'benchmark', currentStep: 1, customPlans: [], csvPlans: [], pastedPlans: [] };
window.navWz = function(step) {
state.currentStep = Math.max(1, Math.min(5, step));
for (let i = 1; i <= 5; i++) {
const pane = $(`pane${i}`);
const tab = $(`wzTab${i}`);
if (pane) pane.classList.toggle('active', i === state.currentStep);
if (tab) {
tab.classList.toggle('active', i === state.currentStep);
tab.classList.toggle('done', i < state.currentStep);
}
}
window.scrollTo({ top: 0, behavior: 'smooth' });
};
async function init() {
try {
const [p, b, pr] = await Promise.all([
fetch('./data/provenance.json').then(r => r.json()),
fetch('./data/ca_benefits.json').then(r => r.json()),
fetch('./data/priors.json').then(r => r.json())
]);
state.provenance = p; state.benefits = b; state.priors = pr;
$('cecLastVerified').textContent = p.lastVerified || '2026-10-15';
setupEvents();
updateProfile();
renderPlans();
if (sessionStorage.getItem('ca_plan_bayes_optin') === 'true') {
const cb = $('chkOptInStorage');
if (cb) { cb.checked = true; restoreInputs(); }
}
} catch (err) {
console.error('init failed:', err);
const el = $('resultsContainer') || document.body;
el.innerHTML = `<div class="alert-box alert-warning"><strong>Unable to load plan data.</strong> Please refresh.<br><small>${esc(err.message)}</small></div>`;
}
}
function setupEvents() {
for (let i = 1; i <= 5; i++) $(`wzTab${i}`).onclick = () => window.navWz(i);
document.querySelectorAll('.tab-btn').forEach(btn => {
btn.onclick = () => {
document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
btn.classList.add('active');
state.activeTab = btn.dataset.tab;
$(`tab-${state.activeTab}`)?.classList.add('active');
renderPlans();
};
});
$('coverageCategory').onchange = e => {
const isC = e.target.value === 'commercial';
$('marketBadge').textContent = isC ? 'Commercial' : 'Covered CA';
$('marketBadge').className = `pill ${isC ? 'pill-projected' : 'pill-actual'}`;
$('residencyField').style.display = isC ? 'none' : 'flex';
updateProfile();
};
['householdSize', 'magi', 'residencyStatus', 'ageBand'].forEach(id => $(id).oninput = updateProfile);
$('btnDownloadCsvTemplate').onclick = () => {
const blob = new Blob([CSV_HEADER_STRING + '\nSample Gold PPO,Anthem,Gold,PPO,180,false,true,true,true,false\n'], { type: 'text/csv' });
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'coveredca_plan_template.csv';
a.click();
};
$('csvFileInput').onchange = e => {
const f = e.target.files[0];
if (!f) return;
const r = new FileReader();
r.onload = ev => {
try {
state.csvPlans = parsePlanCsv(ev.target.result);
renderPlans();
alert(`Successfully loaded ${state.csvPlans.length} plan(s).`);
} catch (err) { alert(err.message); }
};
r.readAsText(f);
};
$('btnParsePasted').onclick = () => {
const res = parsePastedPlanText(v('pastedText') || '');
if (res.success) {
state.pastedPlans = res.plans;
renderPlans();
alert(`Extracted ${res.plans.length} plan(s) from your text.`);
} else alert('No plans could be parsed. Please check text or use CSV upload.');
};
$('btnAddCustomPlan').onclick = () => {
const name = v('customPlanName') || 'Custom Employer Plan';
const carrier = v('customCarrier') || 'Employer Carrier';
const prem = parseFloat(v('customNetPremium')) || 0;
const ded = parseFloat(v('customDed')) || 0;
const oop = parseFloat(v('customOopMax')) || 3000;
const copay = parseFloat(v('customCopay')) || 20;
state.customPlans.push(createCommercialPlan({
plan_name: name, carrier, monthly_premium_after_subsidy: prem,
custom_benefits: {
medical_deductible_ind: ded, rx_deductible_ind: 0, oop_max_ind: oop,
medical_deductible_fam: ded * 2, oop_max_fam: oop * 2,
family_deductible_structure: 'embedded', pre_deductible_pcp_visits: 3,
pcp_copay: copay, specialist_copay: copay * 1.8, coinsurance_rate: 0.20, hsa_eligible: false
}
}));
renderPlans();
};
$('btnRunSimulation')?.addEventListener('click', run);
$('btnNonGoals')?.addEventListener('click', () => $('modalNonGoals')?.classList.remove('hidden'));
$('btnCloseNonGoals')?.addEventListener('click', () => $('modalNonGoals')?.classList.add('hidden'));
$('btnCecHelp')?.addEventListener('click', () => $('modalCec')?.classList.remove('hidden'));
$('btnCloseCec')?.addEventListener('click', () => $('modalCec')?.classList.add('hidden'));
$('chkOptInStorage').onchange = e => {
if (e.target.checked) { sessionStorage.setItem('ca_plan_bayes_optin', 'true'); persistInputs(); } else sessionStorage.clear();
};
$('btnPurgeMemory').onclick = () => { sessionStorage.clear(); location.reload(); };
}
function renderPlans() {
const el = $('planList');
const list = { manual: state.customPlans, csv: state.csvPlans, paste: state.pastedPlans }[state.activeTab];
if (!el) return;
if (!list) { el.innerHTML = '<div class="sub">Benchmark tiers are generated when you run the comparison.</div>'; return; }
el.innerHTML = list.length ? `<div class="sub">${list.length} plan(s) to compare:</div>` + list.map((p, i) => `<div class="plan-item"><div class="plan-header"><div><div class="plan-title">${esc(p.plan_name)}</div><div class="sub">${esc(p.carrier)} • ${esc(p.metal_tier)} • ${esc(p.network_type)}${p.custom_benefits ? ` • Ded $${p.custom_benefits.medical_deductible_ind} • OOP max $${p.custom_benefits.oop_max_ind}` : ''}</div></div><div style="text-align:right"><div style="font-weight:700;color:var(--primary)">$${Math.round(p.monthly_premium_after_subsidy)}/mo</div><button class="btn-text btn-danger" data-i="${i}">Remove</button></div></div></div>`).join('') : '<div class="sub">No plans added yet.</div>';
el.onclick = e => { if (e.target.dataset.i !== undefined) { list.splice(+e.target.dataset.i, 1); renderPlans(); } };
}
function updateProfile() {
if (!state.provenance) return;
const size = parseInt(v('householdSize'), 10) || 1;
const magi = parseFloat(v('magi')) || 0;
const age = v('ageBand') || '35-44';
const isC = v('coverageCategory') === 'commercial';
const gDef = state.provenance.statewide_benchmark_silver_gross_by_age?.[age]?.value;
const grossEl = $('benchGrossSilver');
if (gDef && grossEl) grossEl.value = gDef;
const fpl = calculateFplPercent(magi, size, state.provenance);
const box = $('fplAlertArea');
if (!box) return;
box.innerHTML = '';
if (isC) return;
const resVal = v('residencyStatus') || 'lawfully_present';
const res = evaluateResidency(resVal, fpl);
if (!res.canRankMarketplace) {
box.innerHTML = `<div class="alert-box alert-warning"><strong>${esc(res.title)}:</strong> ${esc(res.message)}</div>`;
return;
}
const med = screenMediCal(fpl);
if (med.likelyEligible) {
box.innerHTML += `<div class="alert-box alert-info"><strong>Medi-Cal Eligibility:</strong> ${esc(med.headline)} (${Math.round(fpl)}% FPL). You may qualify for no-cost coverage.</div>`;
}
const cliff = evaluateCliffAlerts(magi, size, state.provenance);
if (cliff.cliffAlert) {
box.innerHTML += `<div class="alert-box alert-warning"><strong>Subsidy Alert:</strong> ${esc(cliff.message)}</div>`;
}
}
function run() {
const isC = v('coverageCategory') === 'commercial';
const size = parseInt(v('householdSize'), 10) || 1;
const magi = parseFloat(v('magi')) || 0;
const fpl = calculateFplPercent(magi, size, state.provenance);
const resVal = v('residencyStatus') || 'lawfully_present';
if (!isC && !evaluateResidency(resVal, fpl).canRankMarketplace) {
alert('Marketplace rankings suppressed for this immigration status. Please consult a CEC.');
return;
}
let plans = [];
if (state.activeTab === 'benchmark') {
const gross = parseFloat(v('benchGrossSilver')) || 480;
const sub = isC ? 0 : (parseFloat(v('benchMonthlySubsidy')) || 0);
plans = estimateBenchmarkTiers(gross, sub, fpl, resVal, state.provenance);
} else if (state.activeTab === 'csv') plans = state.csvPlans;
else if (state.activeTab === 'paste') plans = state.pastedPlans;
else if (state.activeTab === 'manual') plans = state.customPlans;
if (!plans.length) return alert('No plans available to compare.');
const filter = v('networkFilter') || 'all';
let filtered = plans;
if (filter === 'ppo_epo') filtered = plans.filter(p => !p.network_type?.toLowerCase().includes('hmo'));
else if (filter === 'hmo') filtered = plans.filter(p => p.network_type?.toLowerCase().includes('hmo'));
if (!filtered.length) filtered = plans;
const inputs = {
ageBand: v('ageBand') || '35-44',
sex: v('memberSex') || 'female',
chronicRxKey: v('cluster1Input') || 'none_none',
behavioralKey: v('cluster2Input') || 'none',
acuityKey: v('cluster3Input') || 'routine',
householdSize: size, fplPercent: fpl, isCommercialPlan: isC,
hsaContribution: parseFloat(v('hsaPlanned')) || 0,
marginalTaxRate: parseFloat(v('marginalTax')) || 0.22,
isPayrollFicaExempt: Boolean($('chkFicaExempt')?.checked)
};
const lambda = parseFloat(v('suddenBillTolerance')) || 0.25;
const result = simulatePlans(filtered, inputs, state.priors, state.benefits, state.provenance, { simulations: 5000, lambdaRisk: lambda });
render(result);
if ($('chkOptInStorage')?.checked) persistInputs();
window.navWz(5);
}
function render(res) {
const b = $('attributionBanner');
const l = $('plansList');
if (!b || !l) return;
const win = res.planResults[0];
const at = res.attribution;
const stateFriendly = {
S1: 'Low Medical Usage (Mostly preventive care)',
S2: 'Moderate Care (Occasional doctor visits & basic Rx)',
S3: 'Regular Doctor Visits or Ongoing Prescriptions',
S4: 'High Medical Care (Frequent specialists or brand medications)'
}[at.topState] || at.topState;
b.innerHTML = `
<div class="attribution-box">
<strong>Why "${esc(win.plan.plan_name)}" is recommended for you:</strong><br>
Expected care matches <strong>${esc(stateFriendly)}</strong>.<br>
• Key factors: ${at.topDrivers.map(d => esc(d.name)).join(' & ')}.
${at.winnerSavingsVsRunnerUp > 5 ? `<br>• Estimated annual savings vs runner-up: <strong>$${Math.round(at.winnerSavingsVsRunnerUp).toLocaleString()}</strong>` : ''}
${at.winnerSavingsVsCurrent ? `<br>• Estimated annual savings vs current plan: <strong>$${Math.round(at.winnerSavingsVsCurrent).toLocaleString()}</strong>` : ''}
</div>
`;
l.innerHTML = res.planResults.map((item, idx) => {
const isW = idx === 0;
const dom = item.isFirstOrderDominated ? '<span class="pill pill-dom">Dominated</span>'
: (item.isRiskAdjustedDominated ? '<span class="pill pill-dom">Higher Risk Cost</span>' : '');
const wBadge = isW ? '<span class="pill pill-win">Optimal Decision</span>' : '';
const metrics = [
['Est. Annual Total', `$${Math.round(item.eac).toLocaleString()}`],
['Risk Utility Score', `$${Math.round(item.utility).toLocaleString()}`],
['Win Odds', `${item.winProbability.toFixed(1)}%`],
['95% Tail Cost', `$${Math.round(item.tailOop95).toLocaleString()}`],
['Worst-Case Ceiling', `$${Math.round(item.worstCaseCeiling).toLocaleString()}`]
].map(([k, v]) => `<div class="metric-box"><div style="color:var(--muted)">${k}</div><div class="metric-val">${v}</div></div>`).join('');
return `
<div class="plan-item ${isW ? 'winner' : ''} ${item.isFirstOrderDominated || item.isRiskAdjustedDominated ? 'dominated' : ''}">
<div class="plan-header">
<div>
<div class="plan-title">${esc(item.plan.plan_name)} ${wBadge} ${dom}</div>
<div style="font-size:0.8rem;color:var(--muted)">${esc(item.plan.carrier)} • Tier: ${esc(item.tierName)} • Network: ${esc(item.plan.network_type || 'EPO/PPO')}</div>
</div>
<div style="text-align:right">
<div style="font-size:1.1rem;font-weight:700;color:var(--primary)">$${Math.round(item.netMonthlyPremium)}/mo</div>
<div style="font-size:0.75rem;color:var(--muted)">Your Monthly Premium</div>
</div>
</div>
<div class="plan-metrics">${metrics}</div>
</div>
`;
}).join('');
}
function persistInputs() {
const ids = ['coverageCategory', 'householdSize', 'magi', 'ageBand', 'memberSex', 'hsaPlanned', 'marginalTax', 'cluster1Input', 'cluster2Input', 'cluster3Input', 'suddenBillTolerance', 'networkFilter'];
const d = ids.reduce((o, id) => {
const val = v(id);
if (val !== undefined) o[id] = val;
return o;
}, {});
sessionStorage.setItem('ca_plan_bayes_inputs', JSON.stringify(d));
}
function restoreInputs() {
const raw = sessionStorage.getItem('ca_plan_bayes_inputs');
if (!raw) return;
try {
const d = JSON.parse(raw);
Object.keys(d).forEach(k => {
const el = $(k);
if (el) el.value = d[k];
});
} catch (e) {}
}
init();
