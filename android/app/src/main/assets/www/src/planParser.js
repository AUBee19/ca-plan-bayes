export const CSV_HEADER_STRING = 'plan_name,carrier,metal_tier,network_type,monthly_premium_after_subsidy,hdhp_hsa,pcp_in_network,specialist_therapist_in_network,drugs_covered,is_current_plan';

export function mapCsrTier(fplPercent) {
  if (fplPercent <= 150.0) return 'Silver_94';
  if (fplPercent <= 200.0) return 'Silver_87';
  if (fplPercent <= 250.0) return 'Silver_73';
  return 'Silver';
}

export function estimateBenchmarkTiers(grossSilver, monthlySubsidy, fplPercent, residencyStatus, provenance) {
  const ratios = provenance.tier_ratios || { Bronze: 0.78, Bronze_HDHP: 0.74, Silver: 1.00, Gold: 1.28, Platinum: 1.55 };
  const subsidy = Math.max(0, parseFloat(monthlySubsidy) || 0);
  const silverGross = Math.max(0, parseFloat(grossSilver) || 0);
  const isLawful = (residencyStatus || 'lawfully_present') === 'lawfully_present';
  const csrTier = isLawful ? mapCsrTier(fplPercent) : 'Silver';

  return ['Bronze', 'Bronze_HDHP', 'Silver', 'Gold', 'Platinum'].map(tierKey => {
    const ratio = ratios[tierKey] || 1.0;
    const grossPrice = Math.round(silverGross * ratio * 100) / 100;
    const netPrice = Math.max(1.0, Math.round((grossPrice - subsidy) * 100) / 100);
    const effectiveTier = tierKey === 'Silver' ? csrTier : tierKey;
    return {
      plan_name: `Covered CA Standard ${effectiveTier.replace('_', ' ')}`,
      carrier: 'Covered California Benchmark',
      metal_tier: effectiveTier,
      nominal_tier: tierKey,
      network_type: 'EPO/PPO',
      gross_monthly_premium: grossPrice,
      monthly_premium_after_subsidy: netPrice,
      hdhp_hsa: tierKey === 'Bronze_HDHP',
      pcp_in_network: true, specialist_therapist_in_network: true, drugs_covered: true,
      is_current_plan: false, is_benchmark_estimate: true
    };
  });
}

export function createCommercialPlan(cfg) {
  return {
    plan_name: cfg.plan_name || 'Commercial Plan',
    carrier: cfg.carrier || 'Commercial Carrier',
    metal_tier: cfg.metal_tier || 'Silver',
    network_type: cfg.network_type || 'PPO',
    gross_monthly_premium: parseFloat(cfg.gross_monthly_premium || cfg.monthly_premium_after_subsidy || 0),
    monthly_premium_after_subsidy: Math.max(0, parseFloat(cfg.monthly_premium_after_subsidy || 0)),
    hdhp_hsa: Boolean(cfg.hdhp_hsa),
    pcp_in_network: cfg.pcp_in_network !== false,
    specialist_therapist_in_network: cfg.specialist_therapist_in_network !== false,
    drugs_covered: cfg.drugs_covered !== false,
    is_current_plan: Boolean(cfg.is_current_plan),
    is_commercial: true,
    custom_benefits: cfg.custom_benefits || null
  };
}

export function parsePlanCsv(csvContent) {
  if (!csvContent || typeof csvContent !== 'string') throw new Error('CSV content must be a non-empty string.');
  const lines = csvContent.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!lines.length) throw new Error('CSV file is empty.');
  if (lines[0].trim() !== CSV_HEADER_STRING) throw new Error(`CSV header mismatch. Expected: ${CSV_HEADER_STRING}`);

  return lines.slice(1).map((line, idx) => {
    const cols = line.split(',').map(c => c.trim());
    if (cols.length < 10) return null;
    const [name, carrier, tier, netType, prem, hdhp, pcp, spec, drugs, cur] = cols;
    return {
      plan_name: name || `Plan ${idx + 1}`,
      carrier: carrier || 'Carrier',
      metal_tier: tier || 'Silver',
      network_type: netType || 'PPO',
      monthly_premium_after_subsidy: Math.max(1.0, parseFloat(prem) || 0),
      hdhp_hsa: hdhp.toLowerCase() === 'true' || hdhp === '1',
      pcp_in_network: pcp.toLowerCase() !== 'false',
      specialist_therapist_in_network: spec.toLowerCase() !== 'false',
      drugs_covered: drugs.toLowerCase() !== 'false',
      is_current_plan: cur.toLowerCase() === 'true' || cur === '1'
    };
  }).filter(Boolean);
}

export function scrubPii(text) {
  if (!text) return '';
  return text
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]')
    .replace(/\b(?:ID|Member|Subscriber|Policy)\s*#?:?\s*[A-Z0-9-]{6,15}\b/gi, '[REDACTED_MEMBER_ID]')
    .replace(/\b\d{1,5}\s+[A-Za-z0-9.\s]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Suite|Ste|Apt)\b/gi, '[REDACTED_ADDRESS]');
}

export function parsePastedPlanText(rawText) {
  const scrubbed = scrubPii(rawText);
  const lines = scrubbed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const plans = [];
  const tierRegex = /\b(Bronze|Silver|Gold|Platinum)\b/i;
  const premRegex = /\$\s*(\d+(?:\.\d{2})?)\s*(?:\/|\s*per)?\s*(?:mo|month)?/i;

  lines.forEach((line, idx) => {
    const t = line.match(tierRegex);
    const p = line.match(premRegex);
    if (t && p) {
      const tier = t[1].charAt(0).toUpperCase() + t[1].slice(1).toLowerCase();
      plans.push({
        plan_name: `Extracted ${tier} Plan (${idx + 1})`,
        carrier: 'Covered CA Plan',
        metal_tier: tier,
        network_type: 'PPO/EPO',
        monthly_premium_after_subsidy: Math.max(1.0, parseFloat(p[1])),
        hdhp_hsa: line.toLowerCase().includes('hsa') || line.toLowerCase().includes('hdhp'),
        pcp_in_network: true, specialist_therapist_in_network: true, drugs_covered: true, is_current_plan: false
      });
    }
  });

  return { scrubbedText: scrubbed, plans, success: plans.length > 0 };
}
