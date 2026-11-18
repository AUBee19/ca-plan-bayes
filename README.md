# Covered California & Commercial Health Plan Bayesian Decision Engine

> **Ultra-lightweight, mobile-first static web app & Android offline app for evaluating California health plans (Covered California & Commercial/Employer plans).**

Zero external dependencies • Zero-egress volatile memory architecture • 5,000-draw Common Random Numbers (CRN) Monte Carlo simulation.

---

## 1. Overview & Privacy Guarantee

- **Volatile Memory Only:** All financial, clinical, and household inputs exist strictly in volatile JavaScript memory and are wiped on browser tab closure or refresh.
- **0 External Requests:** No Google Fonts, external CDNs, third-party analytics, or cross-origin tracking. Datasets are loaded strictly from relative same-origin `./data/*.json`.
- **Statutory Non-Broker Disclaimer:** Not affiliated with Covered California, DHCS, or HHS. Estimates represent mathematical models based on MEPS calibrations, not binding insurance quotes or clinical advice.

---

## 2. Decision Engine Architecture & Mathematical Model Card

### 2.1 Explicit 48-Cell Prior Matrix $P(S \mid \text{Age, Sex})$
Stores 6 age bands × 2 sexes × 4 health utilization states:
- **$S_1$:** Minimal / Preventive Care
- **$S_2$:** Occasional Acute / Light Maintenance
- **$S_3$:** Continuous Support / Chronic & Behavioral Care
- **$S_4$:** High-Cost / Catastrophic Event

### 2.2 Damped Log-Odds Cluster Updating
Eliminates naive-Bayes double-counting across correlated health inputs:
$$\log \tilde{P}(S_k \mid E) = \log P(S_k \mid \text{Age, Sex}) + \sum_{c=1}^{3} \gamma_c \log \max(\text{LR}_{c,k}, 10^{-6})$$
$$P(S_k \mid E) = \frac{\exp(\log \tilde{P}(S_k \mid E))}{\sum_{j=1}^{4} \exp(\log \tilde{P}(S_j \mid E))}$$

- **Cluster 1 (Chronic & Rx):** $\gamma_1 = 0.65$
- **Cluster 2 (Behavioral Care):** $\gamma_2 = 0.55$
- **Cluster 3 (Acuity & Past Care):** $\gamma_3 = 0.35$

### 2.3 5,000-Draw Common Random Numbers (CRN) Monte Carlo
- **Deterministic PRNG:** `mulberry32` ensures every candidate plan is evaluated against the exact same 5,000 simulated health years, eliminating Monte Carlo noise in pairwise rankings.
- **Household Claim Allocation:** Fixed 60/40 allocation (60% primary member, 40% split evenly among dependents) with embedded vs. aggregate deductible modeling.

### 2.4 Decision Metrics
- **Expected Annual Cost (EAC):** $12 \times \text{NetMonthlyPremium} + \text{MeanOOP} - \text{HSATaxSavings}$
- **Risk-Adjusted Utility:** $U(p) = \text{EAC}(p) + \lambda \cdot \text{StdDevOOP}(p)$ ($\lambda \in \{0.0, 0.25, 0.50\}$)
- **Win Probability %:** Exact percentage of the 5,000 draws where plan $p$ achieves lowest total cost.
- **Tail Cost:** 95th-percentile simulated OOP, alongside Worst-Case Ceiling ($12 \times \text{Premium} + \text{OOP Max}$).

### 2.5 Two-Tier Dominance Detection
- **`FIRST_ORDER_DOMINATED`:** Another plan has strictly lower annual premium and lower expected OOP.
- **`RISK_ADJUSTED_DOMINATED`:** Another plan achieves superior Risk-Adjusted Utility and lower 95th-percentile tail cost.

---

## 3. Covered California & Commercial / Employer Plans

### 3.1 Covered California (On-Exchange)
- **Subsidy Math Contract:** $P_{\text{net, tier}} = \max(r \times P_{\text{gross, Silver}} - S, 1.00)$ enforcing the California $1.00/mo minimum premium floor.
- **CSR Auto-Mapping:**
  - $\text{FPL} \le 150\% \rightarrow \text{Silver\_94}$
  - $150\% < \text{FPL} \le 200\% \rightarrow \text{Silver\_87}$
  - $200\% < \text{FPL} \le 250\% \rightarrow \text{Silver\_73}$
  - $\text{FPL} > 250\% \rightarrow \text{Standard Silver}$
- **Three-State Residency:** `lawfully_present`, `ca_medi_cal_only` (expanded Medi-Cal routing), `unsure_or_mixed` (counselor guidance routing).
- **±15% Income Volatility Alerts:** Automatic clawback and reconciliation warnings around $\{138\%, 150\%, 200\%, 400\%\}$ FPL boundaries.

### 3.2 Commercial & Employer-Sponsored Plans
- Supports custom paycheck employee premiums, employer HSA contributions, custom deductibles, and custom OOP caps.
- Evaluates workplace open-enrollment options (e.g. Kaiser HMO vs. Anthem PPO 500 vs. Cigna HDHP with HSA) under the same Bayesian Monte Carlo engine.

---

## 4. CSV Schema

The uploader accepts CSV files with the following single-line header:

```csv
plan_name,carrier,metal_tier,network_type,monthly_premium_after_subsidy,hdhp_hsa,pcp_in_network,specialist_therapist_in_network,drugs_covered,is_current_plan
```

---

## 5. Mobile & Android App

The repository includes both a static web app and a native Android wrapper (`android/`):
- **Android App:** Native WebView wrapper with local asset caching (`android/app/src/main/assets/www/`). Runs 100% offline without requiring internet permissions.
- **Syncing Web Assets to Android:**
  ```bash
  npm run sync:android
  ```

---

## 6. Testing & CI Quality Gates

Run property-based unit tests and compliance size/freshness/lint gates:

```bash
npm test
```

Quality gates enforced:
- App code budget $\le 51,200$ bytes (50 KB).
- Static datasets budget $\le 40,960$ bytes (40 KB).
- Dataset freshness $\le 180$ days.
- Zero network egress lint (restricted to allowlist).
- Module fetch isolation (`fetch` only allowed in `src/app.js`).
