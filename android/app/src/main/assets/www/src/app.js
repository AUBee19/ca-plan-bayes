import { calculateFplPercent, evaluateResidency, screenMediCal, evaluateCliffAlerts } from './subsidyEngine.js';
import { simulatePlans } from './bayesEngine.js';
import { CSV_HEADER_STRING, estimateBenchmarkTiers, parsePlanCsv, parsePastedPlanText, createCommercialPlan } from './planParser.js';

const state = { provenance: null, benefits: null, priors: null, activeTab: 'benchmark', customPlans: [], csvPlans: [], pastedPlans: [] };

async function init() {
  const [p, b, pr] = await Promise.all([
    fetch('./data/provenance.json').then(r => r.json()),
    fetch('./data/ca_benefits.json').then(r => r.json()),
    fetch('./data/priors.json').then(r => r.json())
  ]);
  state.provenance = p; state.benefits = b; state.priors = pr;
  document.getElementById('cecLastVerified').textContent = p.lastVerified || '2026-10-15';
  setupEvents();
  updateProfile();
  if (sessionStorage.getItem('ca_plan_bayes_optin') === 'true') {
    document.getElementById('chkOptInStorage').checked = true;
    restoreInputs();
  }
}

function setupEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      document.getElementById(`tab-${state.activeTab}`).classList.remove('hidden');
    };
  });

  document.getElementById('coverageCategory').onchange = (e) => {
    const isC = e.target.value === 'commercial';
    const mb = document.getElementById('marketBadge');
    mb.textContent = isC ? 'Commercial' : 'Covered CA';
    mb.className = `pill ${isC ? 'pill-projected' : 'pill-actual'}`;
    document.getElementById('residencyField').style.display = isC ? 'none' : 'flex';
    updateProfile();
  };

  ['householdSize', 'magi', 'residencyStatus', 'ageBand'].forEach(id => {
    document.getElementById(id).oninput = updateProfile;
  });

  document.getElementById('btnDownloadCsvTemplate').onclick = () => {
    const blob = new Blob([CSV_HEADER_STRING + '\nSample Gold PPO,Anthem,Gold,PPO,180,false,true,true,true,false\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'coveredca_plan_template.csv';
    a.click();
  };

  document.getElementById('csvFileInput').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      try {
        state.csvPlans = parsePlanCsv(ev.target.result);
        alert(`Loaded ${state.csvPlans.length} plan(s).`);
      } catch (err) { alert(err.message); }
    };
    r.readAsText(f);
  };

  document.getElementById('btnParsePasted').onclick = () => {
    const res = parsePastedPlanText(document.getElementById('pastedText').value);
    if (res.success) {
      state.pastedPlans = res.plans;
      alert(`Parsed ${res.plans.length} plan(s).`);
    } else alert('Failed to parse text. Please use CSV upload.');
  };

  document.getElementById('btnAddCustomPlan').onclick = () => {
    const name = document.getElementById('customPlanName').value || 'Custom Plan';
    const carrier = document.getElementById('customCarrier').value || 'Carrier';
    const prem = parseFloat(document.getElementById('customNetPremium').value) || 0;
    const ded = parseFloat(document.getElementById('customDed').value) || 0;
    const oop = parseFloat(document.getElementById('customOopMax').value) || 3000;
    const copay = parseFloat(document.getElementById('customCopay').value) || 20;

    state.customPlans.push(createCommercialPlan({
      plan_name: name, carrier, monthly_premium_after_subsidy: prem,
      custom_benefits: {
        medical_deductible_ind: ded, rx_deductible_ind: 0, oop_max_ind: oop,
        medical_deductible_fam: ded * 2, oop_max_fam: oop * 2,
        family_deductible_structure: 'embedded', pre_deductible_pcp_visits: 3,
        pcp_copay: copay, specialist_copay: copay * 1.8, coinsurance_rate: 0.20, hsa_eligible: false
      }
    }));
    alert(`Added "${name}"!`);
  };

  document.getElementById('btnRunSimulation').onclick = run;
  document.getElementById('btnNonGoals').onclick = () => document.getElementById('modalNonGoals').classList.remove('hidden');
  document.getElementById('btnCloseNonGoals').onclick = () => document.getElementById('modalNonGoals').classList.add('hidden');
  document.getElementById('btnCecHelp').onclick = () => document.getElementById('modalCec').classList.remove('hidden');
  document.getElementById('btnCloseCec').onclick = () => document.getElementById('modalCec').classList.add('hidden');

  document.getElementById('chkOptInStorage').onchange = (e) => {
    if (e.target.checked) {
      sessionStorage.setItem('ca_plan_bayes_optin', 'true');
      persistInputs();
    } else sessionStorage.clear();
  };
  document.getElementById('btnPurgeMemory').onclick = () => { sessionStorage.clear(); location.reload(); };
}

function updateProfile() {
  if (!state.provenance) return;
  const size = parseInt(document.getElementById('householdSize').value, 10) || 1;
  const magi = parseFloat(document.getElementById('magi').value) || 0;
  const age = document.getElementById('ageBand').value;
  const isC = document.getElementById('coverageCategory').value === 'commercial';

  const gDef = state.provenance.statewide_benchmark_silver_gross_by_age?.[age]?.value;
  if (gDef && document.getElementById('benchGrossSilver')) document.getElementById('benchGrossSilver').value = gDef;

  const fpl = calculateFplPercent(magi, size, state.provenance);
  const box = document.getElementById('fplAlertArea');
  box.innerHTML = '';
  if (isC) return;

  const res = evaluateResidency(document.getElementById('residencyStatus').value, fpl);
  if (!res.canRankMarketplace) {
    box.innerHTML = `<div class="alert-box alert-warning"><strong>${res.title}:</strong> ${res.message}</div>`;
    return;
  }
  const med = screenMediCal(fpl);
  if (med.likelyEligible) {
    box.innerHTML += `<div class="alert-box alert-info"><strong>Medi-Cal:</strong> ${med.headline} (${Math.round(fpl)}% FPL).</div>`;
  }
  const cliff = evaluateCliffAlerts(magi, size, state.provenance);
  if (cliff.cliffAlert) {
    box.innerHTML += `<div class="alert-box alert-warning"><strong>Subsidy:</strong> ${cliff.message}</div>`;
  }
}

function run() {
  const isC = document.getElementById('coverageCategory').value === 'commercial';
  const size = parseInt(document.getElementById('householdSize').value, 10) || 1;
  const magi = parseFloat(document.getElementById('magi').value) || 0;
  const fpl = calculateFplPercent(magi, size, state.provenance);
  const res = document.getElementById('residencyStatus').value;

  if (!isC && !evaluateResidency(res, fpl).canRankMarketplace) {
    alert('Marketplace rankings suppressed for this immigration status. Please consult a CEC.');
    return;
  }

  let plans = [];
  if (state.activeTab === 'benchmark') {
    const gross = parseFloat(document.getElementById('benchGrossSilver').value) || 480;
    const sub = isC ? 0 : (parseFloat(document.getElementById('benchMonthlySubsidy').value) || 0);
    plans = estimateBenchmarkTiers(gross, sub, fpl, res, state.provenance);
  } else if (state.activeTab === 'csv') plans = state.csvPlans;
  else if (state.activeTab === 'paste') plans = state.pastedPlans;
  else if (state.activeTab === 'manual') plans = state.customPlans;

  if (!plans.length) return alert('No plans available to compare.');

  const filter = document.getElementById('networkFilter').value;
  let filtered = plans;
  if (filter === 'ppo_epo') filtered = plans.filter(p => !p.network_type?.toLowerCase().includes('hmo'));
  else if (filter === 'hmo') filtered = plans.filter(p => p.network_type?.toLowerCase().includes('hmo'));
  if (!filtered.length) filtered = plans;

  const inputs = {
    ageBand: document.getElementById('ageBand').value,
    sex: document.getElementById('memberSex').value,
    chronicRxKey: document.getElementById('cluster1Input').value,
    behavioralKey: document.getElementById('cluster2Input').value,
    acuityKey: document.getElementById('cluster3Input').value,
    householdSize: size, fplPercent: fpl, isCommercialPlan: isC,
    hsaContribution: parseFloat(document.getElementById('hsaPlanned').value) || 0,
    marginalTaxRate: parseFloat(document.getElementById('marginalTax').value) || 0.22,
    isPayrollFicaExempt: true
  };

  const lambda = parseFloat(document.getElementById('suddenBillTolerance').value) || 0.25;
  const result = simulatePlans(filtered, inputs, state.priors, state.benefits, state.provenance, { simulations: 5000, lambdaRisk: lambda });
  render(result);
  if (document.getElementById('chkOptInStorage').checked) persistInputs();
}

function render(res) {
  const c = document.getElementById('resultsContainer');
  const b = document.getElementById('attributionBanner');
  const l = document.getElementById('plansList');
  c.classList.remove('hidden');

  const win = res.planResults[0];
  const at = res.attribution;
  b.innerHTML = `
    <div class="attribution-box">
      <strong>Why "${win.plan.plan_name}" Wins:</strong> Posterior state <strong>${at.topState}</strong> driven by ${at.topDrivers.map(d => d.name).join(' & ')}.
      ${at.winnerSavingsVsRunnerUp > 5 ? `<br>• Est. annual savings vs runner-up: <strong>$${Math.round(at.winnerSavingsVsRunnerUp).toLocaleString()}</strong>.` : ''}
      ${at.winnerSavingsVsCurrent ? `<br>• Est. annual savings vs current plan: <strong>$${Math.round(at.winnerSavingsVsCurrent).toLocaleString()}</strong>.` : ''}
    </div>
  `;

  l.innerHTML = res.planResults.map((item, idx) => {
    const isW = idx === 0;
    const dom = item.isFirstOrderDominated ? '<span class="pill pill-dom">FIRST_ORDER_DOMINATED</span>'
      : (item.isRiskAdjustedDominated ? '<span class="pill pill-dom">RISK_ADJUSTED_DOMINATED</span>' : '');
    const wBadge = isW ? '<span class="pill pill-win">Optimal Decision</span>' : '';

    const metrics = [
      ['Expected Annual Cost', `$${Math.round(item.eac).toLocaleString()}`],
      ['Risk-Adjusted Utility', `$${Math.round(item.utility).toLocaleString()}`],
      ['Win Probability', `${item.winProbability.toFixed(1)}%`],
      ['95th Tail Cost', `$${Math.round(item.tailOop95).toLocaleString()}`],
      ['Worst-Case Ceiling', `$${Math.round(item.worstCaseCeiling).toLocaleString()}`]
    ].map(([k, v]) => `<div class="metric-box"><div style="color:var(--text-muted)">${k}</div><div class="metric-val">${v}</div></div>`).join('');

    return `
      <div class="plan-item ${isW ? 'winner' : ''} ${item.isFirstOrderDominated || item.isRiskAdjustedDominated ? 'dominated' : ''}">
        <div class="plan-header">
          <div>
            <div class="plan-title">${item.plan.plan_name} ${wBadge} ${dom}</div>
            <div style="font-size:0.8rem;color:var(--text-muted)">${item.plan.carrier} • Tier: ${item.tierName} • Net: ${item.plan.network_type || 'EPO/PPO'}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:1.1rem;font-weight:700;color:var(--primary)">$${Math.round(item.netMonthlyPremium)}/mo</div>
            <div style="font-size:0.75rem;color:var(--text-muted)">Net Premium <span class="pill pill-actual">Actual</span></div>
          </div>
        </div>
        <div class="plan-metrics">${metrics}</div>
      </div>
    `;
  }).join('');
  c.scrollIntoView({ behavior: 'smooth' });
}

function persistInputs() {
  const d = ['coverageCategory', 'householdSize', 'magi', 'ageBand', 'memberSex', 'hsaPlanned', 'marginalTax', 'cluster1Input', 'cluster2Input', 'cluster3Input']
    .reduce((o, id) => { o[id] = document.getElementById(id).value; return o; }, {});
  sessionStorage.setItem('ca_plan_bayes_inputs', JSON.stringify(d));
}

function restoreInputs() {
  const raw = sessionStorage.getItem('ca_plan_bayes_inputs');
  if (!raw) return;
  try {
    const d = JSON.parse(raw);
    Object.keys(d).forEach(k => { if (document.getElementById(k)) document.getElementById(k).value = d[k]; });
  } catch (e) {}
}

init();
