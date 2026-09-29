# Legal research methods for the VisLex case agent

Reference compiled 2026-09-29. This is the long-form background for
`src-tauri/resources/research/research-playbook.md`, the compact version injected into
the case agent's system prompt. The playbook is operational; this document explains the
reasons and records the sources.

Scope: an agent that drives the user's own signed-in Westlaw session and the open web
inside the VisLex research browser, captures what it relies on as case evidence, and
writes research memos. Users may practise in any U.S. state or federal court, civil or
criminal. The methods are jurisdiction-neutral; state rules appear as verified examples,
and Ohio is kept as one fuller worked example (Appendix A).

Nothing here is legal advice, and no document or test certifies that a research result
is accurate or complete. Authorities named below are research leads checked against the
cited sources on the date above. Before relying on any of them, open the authority in
Westlaw, read it, KeyCite it, and capture the passage.

---

## 0. Sources relied on (retrieved 2026-09-28/29)

Thomson Reuters (Westlaw)
- [W1] *Quick Reference Guide: Searching with Boolean Terms and Connectors* (Westlaw), L-362608/5-16. https://static.legalsolutions.thomsonreuters.com/product_files/westlaw/wlawdoc/web/wlnterms.pdf
- [W2] Thomson Reuters Help, *About KeyCite Status Flags*. https://www.thomsonreuters.com/en-us/help/drafting-assistant/westcheck/keycite-status-flags
- [W3] Thomson Reuters Help (Westlaw Advantage), *KeyCite Overruling Risk*. https://www.thomsonreuters.com/en-us/help/westlaw-advantage/tools/keycite-overruling-risk
- [W4] *Quick Reference Guide: How to identify implicitly invalidated case law (KeyCite Overruling Risk)*. https://legal.thomsonreuters.com/content/dam/ewp-m/documents/legal/en/pdf/quick-reference-guides/westlaw-edge-keycite-overruling-risk_qrg.pdf
- [W5] *Quick Reference Guide: How to use the Key Number System*. https://legal.thomsonreuters.com/content/dam/ewp-m/documents/legal/en/pdf/quick-reference-guides/s076047-wle-searching-with-topic-and-key-number.pdf
- [W6] Thomson Reuters Help, *Understanding Precision Research*. https://www.thomsonreuters.com/content/helpandsupp/en-us/help/westlaw-precision/searching/understanding-precision-research.html
- [W7] Thomson Reuters blog, *Meet Westlaw Advantage*. https://legal.thomsonreuters.com/blog/meet-westlaw-advantage-the-next-generation-ai-legal-research-solution/
- [W8] Thomson Reuters Product Training, *How to view cases frequently cited together* (Cited With). https://training.thomsonreuters.com/media/How+to+view+cases+frequently+cited+together/1_f4jq8nk4
- [W9] *Searching with Terms and Connectors* (Westlaw, 2009; fields, plurals, common terms), hosted by Lewis & Clark Law School. https://law.lclark.edu/live/files/9394-westlaw-terms-and-connectors-searching

Law-school and law-library guides
- [L1] Washington University in St. Louis Law Library, *KeyCite on Westlaw Precision*. https://libguides.wustl.edu/c.php?g=1034994&p=7502617
- [L2] Stanford Law School, *Is the Case Still Good Law?* https://guides.law.stanford.edu/cases/goodlaw
- [L3] Georgetown Law Library, *Finding Cases: Digests, Headnotes, and Key Numbers*. https://guides.ll.georgetown.edu/cases/headnotes
- [L4] Georgetown Law Library, *Secondary Sources Research Guide*. https://guides.ll.georgetown.edu/secondary
- [L5] Georgetown Law Library, *Case Law Research Guide*. https://guides.ll.georgetown.edu/cases
- [L6] Georgetown Law Writing Center, *Which Court Is Binding?* (rev. 2017). https://www.law.georgetown.edu/wp-content/uploads/2018/07/Which-Court-is-Binding-HandoutFinal.pdf
- [L7] Georgetown Law Writing Center, *Federal Law, Federal Courts, and Binding and Persuasive Authority* (Schafer, 2013). https://www.law.georgetown.edu/wp-content/uploads/2018/07/Matthew-Schafer-FederalLawFederalCourtsandBindingandPersuasiveAuthority.pdf
- [L8] Penn State Law Library blog, *Parallel Search on Westlaw* (2025-03-26). https://sites.psu.edu/keepingitbrief/2025/03/26/parallel-search-on-westlaw/
- [L9] Penn State Law Library blog, *From Westlaw Precision to Westlaw Advantage* (2026-01-14). https://sites.psu.edu/keepingitbrief/2026/01/14/from-westlaw-precision-to-westlaw-advantage/
- [L10] Boston College Law Library, *When to Stop*. https://lawguides.bc.edu/c.php?g=350931&p=2367344
- [L11] University of San Francisco School of Law, *When to Stop Your Research*. https://legalresearch.usfca.edu/ResearchStrategies/StrategyWhenToStop
- [L12] Hamilton County (Ohio) Law Library, *Ohio Primary Law: Courts & Cases*. https://libguides.hamilton-co.org/c.php?g=392905&p=2668920
- [L13] Hamilton County Law Library, *Westlaw flag help*. https://lawlibrary.hamiltoncountyohio.gov/wp-content/uploads/2021/07/Westlaw-flag-help.pdf
- [L14] University of Cincinnati Law Library, *Jury Instructions*. https://guides.libraries.uc.edu/c.php?g=222612&p=1473128
- [L15] University of South Carolina Law Library, *Checklist: Researching a State Statute*. https://guides.law.sc.edu/LRAWFall/ChecklistResearchingProblemStateStatute
- [L16] University of Hawai'i Law Library, *Westlaw Advanced Search Commands* (date field). https://law-hawaii.libguides.com/c.php?g=1223564&p=8952453
- [L17] Cornell LII, *Introduction to Basic Legal Citation*. https://www.law.cornell.edu/citation/
- [L18] Cornell LII Wex, *Erie doctrine*. https://www.law.cornell.edu/wex/erie_doctrine

Precedent structure (states and federal)
- [P1] Auto Equity Sales, Inc. v. Superior Court, 57 Cal.2d 450 (1962). Summary and text: https://law.justia.com/cases/california/supreme-court/2d/57/450.html ; https://online.ceb.com/calcases/C2/57C2d450.htm
- [P2] California Rules of Court, rule 8.1115 (citation of opinions). https://www.courts.ca.gov/cms/rules/index.cfm?title=eight&linkid=rule8_1115
- [P3] Pardo v. State, 596 So.2d 665 (Fla. 1992). https://law.justia.com/cases/florida/supreme-court/1992/78318-0.html ; commentary: https://www.floridabar.org/the-florida-bar-journal/controlling-jurisdiction-and-the-duty-to-disclose-adverse-authority-floridas-district-courts-of-appeal-reign-supreme-on-matters-of-first-impression/
- [P4] Mountain View Coach Lines, Inc. v. Storms, 102 A.D.2d 663 (2d Dep't 1984). https://www.courtlistener.com/opinion/6007177/mountain-view-coach-lines-inc-v-storms/
- [P5] Aleckson v. Village of Round Lake Park, 176 Ill.2d 82, 92 (1997), citing State Farm Fire & Cas. Co. v. Yapejian, 152 Ill.2d 533 (1992). https://caselaw.findlaw.com/court/il-supreme-court/1232357.html
- [P6] Texas Rules of Appellate Procedure, rule 41.3 (precedent in transferred cases) and 2008 comment. https://www.txcourts.gov/media/1437631/texas-rules-of-appellate-procedure-updated-with-amendments-effective-2117-with-appendices.pdf
- [P7] Texas Constitution art. V, §5 (Court of Criminal Appeals: final appellate jurisdiction in criminal cases). https://law.justia.com/constitution/texas/sections/cn000500-000500.html
- [P8] *Unclaimed Treasure: Greater Rule-of-Law Benefits for the Taking in Texas*, Houston Law Review (courts of appeals not bound by each other; trial courts bound by their courts of appeals). https://houstonlawreview.org/article/17997-unclaimed-treasure-greater-rule-of-law-benefits-for-the-taking-in-texas
- [P9] Texas S.B. 1045 (88th Leg.) bill analysis (Fifteenth Court of Appeals, statewide district, from Sept. 1, 2024). https://capitol.texas.gov/tlodocs/88R/analysis/html/SB01045F.htm
- [P10] Federal Rule of Appellate Procedure 32.1. https://www.law.cornell.edu/rules/frap/rule_32.1
- [P11] *Conflicts of Precedent*, Virginia Law Review (prior-panel rule; quoting Lewis v. Humboldt Acquisition Corp., 634 F.3d 879, 881 (6th Cir. 2011) (en banc)). https://virginialawreview.org/articles/conflicts-precedent/

Ohio (worked example)
- [O1] Supreme Court Rules for the Reporting of Opinions (eff. July 1, 2012). https://www.supremecourt.ohio.gov/docs/LegalResources/rules/reporting/Report.pdf
- [O2] Supreme Court of Ohio Writing Manual (3d ed., eff. June 17, 2024). https://www.supremecourt.ohio.gov/docs/ROD/manual3e.pdf
- [O3] Ohio Const. art. IV, §3. https://codes.ohio.gov/ohio-constitution/section-4.3
- [O4] Ohio Const. art. XVIII, §3. https://codes.ohio.gov/ohio-constitution/section-18.3
- [O5] Ohio LSC, *Municipal Home Rule*. https://www.lsc.ohio.gov/assets/organizations/legislative-service-commission/files/municipal-home-rule.pdf
- [O6] Ohio Third District Court of Appeals, *About Us*. https://www.third.courts.state.oh.us/about-us/
- [O7] R.C. 2901.21. https://codes.ohio.gov/ohio-revised-code/section-2901.21
- [O8] R.C. 2901.22. https://codes.ohio.gov/ohio-revised-code/section-2901.22
- [O9] R.C. 2913.02. https://codes.ohio.gov/ohio-revised-code/section-2913.02
- [O10] R.C. 2945.71. https://codes.ohio.gov/ohio-revised-code/section-2945.71
- [O11] R.C. 2929.24. https://codes.ohio.gov/ohio-revised-code/section-2929.24
- [O12] R.C. 2929.28. https://codes.ohio.gov/ohio-revised-code/section-2929.28
- [O13] R.C. 2935.041. https://codes.ohio.gov/ohio-revised-code/section-2935.041
- [O14] R.C. 1901.30. https://codes.ohio.gov/ohio-revised-code/section-1901.30
- [O15] Ohio Rules of Criminal Procedure. https://www.supremecourt.ohio.gov/docs/legalResources/rules/criminal/criminalprocedure.pdf
- [O16] Ohio Rules of Professional Conduct. https://www.supremecourt.ohio.gov/docs/LegalResources/Rules/ProfConduct/profConductRules.pdf
- [O17] Findlay Codified Ordinances 545.05 (American Legal Publishing). https://codelibrary.amlegal.com/codes/findlay/latest/findlay_oh/0-0-0-12962
- [O18] State v. Johnson, 2025-Ohio-2103 (3d Dist.). https://www.supremecourt.ohio.gov/rod/docs/pdf/3/2025/2025-Ohio-2103.pdf
- [O19] Collateral Consequences Resource Center, *Ohio*; Ohio Justice & Policy Center, *Collateral Sanctions*. https://ccresourcecenter.org/resources-2/state-specific-resources/ohio-2/ ; https://ohiojpc.org/collateralsanctions/
- [O20] NICCC, *Civil Impacts of Criminal Convictions under Ohio Law*. https://niccc.nationalreentryresourcecenter.org/news-resources/civil-impacts-criminal-convictions-under-ohio-law

Bracketed tags mark which source supports a statement. Untagged statements are standard
research practice.

---

## 1. Research process

1. **Frame the question from the record.** Read the pleadings or charging instrument, the
   enacted provisions cited, and the key evidence. Record the forum (court, district,
   circuit), the relevant dates (conduct, filing, offence), and the posture (pleading,
   discovery, summary judgment, pretrial, trial, sentencing, appeal). Dates fix which
   version of a statute or rule applies; the forum fixes which authorities bind.
2. **Identify the issues.** For each claim or charge: its elements, the mental state or
   standard of liability, defences, and the facts proving or disproving each element.
   Then list procedural, jurisdictional, evidentiary and constitutional issues (sections
   6 and 7).
3. **Orient with secondary sources.** Treatises, practice guides, ALR annotations,
   encyclopedias and pattern jury instructions explain the area and cite the leading
   primary law [L4]. They are maps, not the rule.
4. **Go to enacted text.** Read the constitution, statute, rule or ordinance; confirm the
   version in force on the relevant date; read its annotations and KeyCite. For a
   statutory issue, annotations and citing references are usually the fastest route to
   controlling cases [L5].
5. **Find controlling cases.** Highest binding court first, then the binding intermediate
   court, then persuasive courts. Search with terms and connectors built from elements and
   facts, then expand via headnotes, Key Numbers, citing references and Cited With.
6. **Read and verify.** Read the opinion itself; identify holding, dicta, posture and
   standard of review; KeyCite it.
7. **Capture** the passage relied on with an exact quote and pin cite.
8. **Seek adverse authority** with the same care as favourable authority.
9. **Cross-check on the web** where coverage may be thin (local ordinances, recent or
   unreported decisions, court rules, dockets) (section 3).
10. **Stop** when different tools and formulations return the same authorities and nothing
    new changes the answer: the governing rule and leading authorities are known and
    verified [L10][L11]. Record the stopping point and gaps.

---

## 2. Westlaw technique

### 2.1 Search mode [W1]

A query is processed as **Terms & Connectors** if it contains a grammatical connector
(`/s /p +s +p`), a numerical connector (`/n +n`), BUT NOT (`%`), a root expander (`!`),
the universal character (`*`), a quoted phrase, or a field restriction. A query with only
`&` and spaces (OR) runs as a **plain-language** search. Prefix `adv:` (or `advanced:`)
or use Advanced Search to force Boolean processing.

### 2.2 Terms and connectors [W1][W9]

| Syntax | Meaning | Example |
|---|---|---|
| `&` | both terms anywhere | `narcotics & warrant` |
| space (or `OR`) | either term | `attorney lawyer counsel` |
| `/s` | same sentence | `design /s defect` |
| `+s` | first precedes second, same sentence | `attorney +s fee` |
| `/p` | same paragraph | `hearsay /p utterance` |
| `+p` | first precedes second, same paragraph | `exception +p non-liability` |
| `/n` | within n terms (1 to 255) | `personal /3 jurisdiction` |
| `+n` | first precedes second by n or fewer | `capital +3 gain` |
| `%` | BUT NOT; excludes everything after it; place last | `tax taxation /s income % investment` |
| `" "` | phrase | `"res ipsa loquitur"` |
| `!` | root expander | `object!` |
| `*` | universal character, one per `*` | `withdr*w` |
| `#` | exactly as typed, no plurals or equivalents | `#damage` |
| `( )` | group; processed first | `frisk! (search! /3 seiz!)` |

**Order of processing** [W1]: `" "`, space (OR), `+n`, `/n`, `+s`, `/s`, `+p`, `/p`, `&`,
`%`. Because OR binds first, `frisk! search! /3 seiz!` means (frisk! OR search!) /3
seiz!; parenthesise to change it.

**Plurals** [W9]: a singular term retrieves the plural; a plural retrieves only the plural.
**Common terms in phrases** [W9]: an embedded common word is a placeholder, so
`"judgment with prejudice"` also matches "judgment without prejudice".
**Citation searches** [W1]: `(15 +5 1311) (42 +5 1985)`.

### 2.3 Field restrictions [W1][W9][L16]

Field abbreviation immediately followed by terms in parentheses; combine fields with a
comma. Fields vary by content type; each Advanced Search page lists them.
`TI()` title/parties; `SY()` synopsis; `DI()` digest (headnotes); `SY,DI()` both; `CO()`
court; `JU()` judge; `AT()` attorney; `DA()` date: `DA(2004)`, `DA(9/2000)`,
`DA(aft 2002)`, `DA(bef 6/1999)`, joined with `&`. `SY,DI` finds cases on a point, but that
text is West editorial content and is never quoted as law.

### 2.4 Jurisdiction, content type, filters, sort [W1][W6]

Choose the jurisdiction before searching. Content types: Cases, Statutes & Court Rules,
Regulations, Secondary Sources, Practical Law, Briefs, Trial Court Documents, Jury
Instructions (subscription-dependent). Narrow by court, date, reported status, judge,
Key Number, practice area, and Precision attributes (legal issue and outcome, fact
pattern, motion type and outcome). Use Search within results (any connectors). Sort by
relevance or date.

### 2.5 Key Numbers and headnotes [W5][L3]

Each point of law in a published opinion is summarised in a headnote and assigned a West
Topic and Key Number (about 450 topics). From a good case, click the Key Number to see
all cases classified there (narrow by jurisdiction), use **"Cases that cite this
headnote"** for later cases citing that point, or browse the Key Number index directly.

### 2.6 Citing references, Cited With, Parallel Search, AI features

- **Citing References**: filter by jurisdiction, content type, date, depth of treatment,
  headnote and treatment.
- **Cited With** [W8][L1]: cases frequently cited together with the base case even without
  citing each other; co-citing panel lists cases citing both.
- **Parallel Search** [L8][W6]: concept search; a full sentence of about 5 to 30 words
  combining rule and facts; limited to 25 results; filter by jurisdiction.
- **Westlaw Advantage / Deep Research / CoCounsel** [W7][L9]: AI outputs are leads only;
  every authority they name is opened, read, KeyCited and captured before use.

### 2.7 Reading the document

A Westlaw case page shows the KeyCite flag, caption and citations, synopsis, headnotes,
counsel and judges, then the **opinion**. Only the opinion text (majority, concurrence,
dissent, each labelled) is the court's words. Some jurisdictions give an official court-
written syllabus legal force (e.g. Ohio, Appendix A); check the forum's reporting rules.
Pin cites: star paging (`*123`) marks where a reporter page begins; many states use
paragraph numbers (`¶ 12`) in public-domain citations.

---

## 3. Web research

The agent may use the open web on its own when it helps:
- the forum's court rules, local rules, reporting and citation rules, and standing orders;
- official legislature code sites; municipal code hosts (Municode, American Legal
  Publishing) for ordinances, which Westlaw may not carry;
- court websites, opinions pages and dockets; CourtListener/RECAP; Google Scholar for
  cross-checks;
- authority a Westlaw search missed.

Rules: prefer official or primary sources and note when an online code is unofficial or
may lag enactments; verify any web-found case on Westlaw (open, KeyCite) before relying on
it where possible, and say so when not possible; capture from the page actually read;
never rely on blogs, commentary or AI summaries as authority. Tools: `research_navigate`
to a search-engine results address, then `research_read_page`, `research_snapshot`,
`research_capture`.

---

## 4. KeyCite

### 4.1 Case flags [W2][W3][W4][L1][L13]

| Flag | Meaning |
|---|---|
| Red | No longer good law for at least one point of law it contains. |
| Red-striped (Precision/Advantage) | Overruled in part; links to the overruled language. |
| Yellow | Some negative treatment, not reversed or overruled. |
| Blue-striped | Appealed to a U.S. Court of Appeals or the U.S. Supreme Court (excluding agency appeals). |
| Orange Overruling Risk icon | Relies on an overruled or otherwise invalid decision; orange brackets mark affected paragraphs. |
| Blue H | Direct history, none known negative. |
| Green C | Citing references only. |

A flag attaches to the document, not the proposition: read what the treatment concerns.
No flag does not prove a point is good law. Appeals to a state high court appear in
History, not as a stripe.

### 4.2 Statute and regulation flags [W2][L15]

Red: amended by a recent session law, repealed, superseded, or held unconstitutional or
preempted in whole or part. Yellow: renumbered or transferred, limited on constitutional
or preemption grounds, or pending legislation. Review History and credits whether or not
flagged.

### 4.3 Tabs and depth

Negative Treatment; History (direct history; for statutes, credits and amendments);
Citing References; Notes of Decisions (statutes); Cited With. Depth of treatment [L2] is
shown as bars (formerly stars): 4 examined, 3 discussed, 2 cited, 1 mentioned. Filter to
3-4 and the relevant headnote to find cases that analyse the point.

---

## 5. Binding versus persuasive authority: decision procedure

### 5.1 Identify the forum and governing law [L6]

Ask: is each issue governed by state law, federal law, or state law applied by a federal
court? Which court decides it now, and what is its appellate path (intermediate court and
its district, department or circuit; court of last resort)? One case can mix governing
law by issue (e.g. a state prosecution with Fourth Amendment issues).

### 5.2 Vertical precedent [L6][L7]

A court's holdings bind every court beneath it in the same system. Holdings and their
necessary rationale bind; dicta do not [L7]. Plurality opinions, concurrences and
dissents need care.

### 5.3 State intermediate appellate courts: patterns

States differ. The agent must know which pattern the forum follows and verify it from the
state's rules, reporting rules or supreme-court decisions when unsure. Verified examples:

| Pattern | Example and source |
|---|---|
| Intermediate appellate decisions bind all trial courts statewide; where appellate decisions conflict, the trial court may choose between them. | **California**: Auto Equity Sales, Inc. v. Superior Court, 57 Cal.2d 450 (1962) (decisions of every division of the Courts of Appeal bind all superior courts; with conflicting decisions the lower court must choose) [P1]. |
| Decisions bind all trial courts statewide absent inter-district conflict. | **Florida**: Pardo v. State, 596 So.2d 665 (Fla. 1992) ("in the absence of interdistrict conflict, district court decisions bind all Florida trial courts") [P3]. |
| Binds statewide, but the home department/district controls where it has ruled otherwise or where districts conflict. | **New York**: Mountain View Coach Lines, Inc. v. Storms, 102 A.D.2d 663 (2d Dep't 1984) (Appellate Division is a single statewide court; trial courts follow another department until the Court of Appeals or their own department rules otherwise) [P4]. **Illinois**: Aleckson v. Village of Round Lake Park, 176 Ill.2d 82, 92 (1997) ("when conflicts arise amongst the districts, the circuit court is bound by the decisions of the appellate court of the district in which it sits"), citing Yapejian [P5]; note the special concurrence's contrary view. |
| Only the home district binds; other districts are persuasive. | **Ohio**: court of appeals jurisdiction runs within its district; judgments conflicting with another district's are certified to the Supreme Court (Ohio Const. art. IV, §3(B)(4)) [O3]; see Appendix A. |
| Split courts of last resort; intermediate courts not bound by each other. | **Texas**: the Court of Criminal Appeals has final appellate jurisdiction in criminal cases (Tex. Const. art. V, §5) [P7]; the Supreme Court of Texas is the court of last resort for civil matters [P8]. Courts of appeals are not bound by each other's precedent; trial courts are bound by their own court(s) of appeals, including both where districts overlap [P8]. In docket-equalization transfers, the transferee court follows the transferor court's precedent (Tex. R. App. P. 41.3) [P6]. The Fifteenth Court of Appeals (statewide district, from Sept. 1, 2024) hears specified state-related and business-court appeals [P9]. Always label a Texas authority as civil or criminal and check which high court's precedent governs. |

Other states: find the rule (often a supreme-court decision on stare decisis, or a
constitutional provision on appellate districts) before labelling weight, and record the
source in the memo.

### 5.4 Unpublished and unreported opinions

Citability and weight vary by forum and date:
- **California**: an opinion not certified for publication "must not be cited or relied on"
  in another action except for law of the case, res judicata, collateral estoppel, or a
  criminal or disciplinary action involving the same person; a published opinion under
  Supreme Court review has no binding effect and is citable for persuasive value only
  (Cal. Rules of Court, rule 8.1115(a), (b), (e)) [P2].
- **Federal**: courts may not prohibit or restrict citation of unpublished dispositions
  issued on or after January 1, 2007 (Fed. R. App. P. 32.1(a)); copies are required when
  not publicly available (32.1(b)) [P10]. Precedential weight is set by circuit rules;
  most circuits treat unpublished opinions as non-binding [L7].
- **Ohio**: court of appeals opinions after May 1, 2002 are citable and weighted as courts
  deem appropriate regardless of publication (Rep.Op.R. 3.4) [O1] (Appendix A).

### 5.5 Federal courts [L6][L7][P11][L18]

- The U.S. Supreme Court binds all courts, state and federal, on federal law.
- A circuit's published precedent binds district courts in the circuit and later panels
  until overruled en banc or by the Supreme Court (e.g. Lewis v. Humboldt Acquisition
  Corp., 634 F.3d 879, 881 (6th Cir. 2011) (en banc)) [P11]; an intervening Supreme
  Court decision can also displace it.
- District court opinions do not bind other district judges or any other court [L7].
- Federal circuit and district decisions do not bind state courts, even on federal
  questions; state courts follow the U.S. Supreme Court on federal law [L6].
- On state-law questions (diversity, supplemental jurisdiction), federal courts apply
  state substantive law (Erie R.R. Co. v. Tompkins, 304 U.S. 64 (1938)) [L18], follow the
  state's highest court, and where it has not ruled predict how it would decide [L6].

### 5.6 Enacted law and weighing

Constitutions, statutes, rules and ordinances control where they speak; use the version
in force on the relevant date. Within a tier prefer the newest, unanimous, same posture
and standard of review, and well-followed authority. Report splits, certified conflicts
and pending higher-court review.

---

## 6. Statutes, rules, ordinances, jury instructions

- Start with the words actually enacted and charged or pleaded.
- Check effective dates, amendments, renumbering and savings clauses; apply the version in
  force at the relevant time. Note label changes that affect how older cases read.
- Annotations (Notes of Decisions) are editorial summaries leading to cases; open each.
- Local ordinances: check the state's home-rule and preemption doctrine. Where an
  ordinance mirrors a state statute, cases interpreting the statute are the main
  interpretive authority; note any textual difference. Online municipal codes are often
  unofficial and may lag enactments.
- Pattern jury instructions give elements and definitions with committee notes; they are
  persuasive, not binding, and must be checked against current law [L14].
- Court rules (civil, criminal, evidence, appellate, local) govern procedure; check
  amendment dates.

---

## 7. Issue checklists

### 7.1 Criminal (any charge)

Charge text and version; each element; culpable mental state and default rules; grading
and enhancers; lesser-included offences and merger; defences and notice requirements;
pretrial-motion requirements and deadlines; search and seizure (federal and state
constitutions; private-actor detention statutes); statements (Miranda, voluntariness);
identification; confrontation; speedy trial (statutory and constitutional); discovery and
Brady; judgment of acquittal, sufficiency versus weight of the evidence; jury
instructions and objections; sentencing ranges, factors, credit, restitution;
collateral consequences (employment, licensing, immigration, housing, firearms, record
sealing); preservation and standards of review.

### 7.2 Civil

Each claim and its elements; defences and affirmative defences; limitations and repose
(accrual, tolling); subject-matter and personal jurisdiction, venue, standing, ripeness,
mootness; pleading standards; joinder and class issues; discovery scope and privilege;
summary judgment standard and burdens; evidence (admissibility, experts, hearsay);
remedies (damages measures, equitable relief, caps), fees and costs; procedural
deadlines; preservation and standards of review.

---

## 8. Citation basics

Case: name; volume, reporter, first page; pin cite; court and year parenthetical;
subsequent history [L17]. Unreported without a public-domain cite: Westlaw number
(`2001 WL 123456`) with court and exact date. Use the forum's citation rules where they
differ from the Bluebook (many state courts have style manuals, e.g. Ohio [O2]). Cite the
statute version and effective date when versions differ.

---

## 9. Common pitfalls

- Headnotes, synopses, Key Number text and annotations are not law [L3].
- AI answers, blogs and summaries are not authority [W7].
- Citing a case not opened in this session; plausible-looking citations can be fabricated.
- Missing overruling or implicit undermining (red, red-striped, yellow, Overruling Risk).
- Wrong statute version or renumbered section.
- Wrong weight labels: another district's or circuit's case, a federal circuit case in
  state court, or an uncitable unpublished opinion treated as binding.
- Pinning to the first page instead of the quoted passage.
- Treating dicta or deferential-standard results (plain error, abuse of discretion) as
  holdings on the merits.
- Missing adverse authority. Model Rule 3.3(a)(2), adopted in substance in most states
  (e.g. Ohio Prof.Cond.R. 3.3(a)(2) [O16]), forbids knowingly failing to disclose directly
  adverse authority in the controlling jurisdiction not disclosed by opposing counsel. The
  agent reports adverse authority; the lawyer decides how to present it.
- Stopping without recording convergence and gaps [L10][L11].

---

## 10. VisLex tools

- `research_westlaw_search(query, jurisdiction, content_type)`: ranked rows (title, court,
  date, citations, snippet, url). Preferred for Westlaw searching.
- `research_westlaw_document(url)`: header (title, court, date, all citations), KeyCite
  (flag, negative treatment count, history count, citing references count) and opinion
  lines. Preferred for reading and KeyCite status.
- `research_navigate`, `research_snapshot`, `research_act`, `research_read_page`,
  `research_status`: generic browser tools for tabs, filters, headnote links, Cited With,
  and web research.
- `research_capture`: saves the document and exact quoted lines for one proposition;
  returns the evidence locator. Required before citing.
- `write_record` (kind `report`): saves the research memo.

---

## Appendix A. Ohio worked example

Illustrates the procedure for one state. Verify everything on Westlaw before use.

- **Supreme Court of Ohio** binds all Ohio courts. Its law is in the opinion text,
  including any syllabus and footnotes (Rep.Op.R. 2.2); other introductory material is a
  research aid only (2.4); per curiam and signed majority opinions have equal authority
  (2.3); a refusal to accept a discretionary appeal is not a statement on the merits
  (4.1) [O1].
- **Courts of appeals** (twelve districts) bind trial courts in their district; other
  districts are persuasive; conflicts are certified (art. IV, §3(B)(4)); a jury verdict
  cannot be reversed on weight of the evidence without all three judges (art. IV,
  §3(B)(3)) [O3]. Municipal-court appeals go to the court of appeals (R.C. 1901.30)
  [O14]. The Third District covers 17 counties including Hancock [O6].
- **Reporting**: opinions after May 1, 2002 are citable regardless of publication and
  weighted as courts deem appropriate (Rep.Op.R. 3.4); the Supreme Court website is the
  official report for appellate opinions since July 1, 2012 (3.2); earlier unreported
  opinions were treated as persuasive only [O1][L12].
- **Citation**: `State v. Johnson, 2025-Ohio-2103, ¶ 4 (3d Dist.)`; paragraph pin cites
  [O2][O18].
- **Ordinances**: home rule (art. XVIII, §3) [O4]; an ordinance conflicts with a general
  law if it "permits or licenses that which the statute forbids and prohibits, and vice
  versa" (Struthers v. Sokol, 108 Ohio St. 263 (1923)), and changing a state misdemeanor to
  a felony or vice versa conflicts [O5]. Findlay C.O. 545.05 tracks R.C. 2913.02 [O17].
- **Criminal specifics**: mental states R.C. 2901.22, default recklessness 2901.21(C)
  [O7][O8]; theft R.C. 2913.02 (amended eff. Apr. 9, 2025; (B)(2) now "misdemeanor
  theft", formerly "petty theft") [O9]; speedy trial R.C. 2945.71 (minor misdemeanour 30
  days; M3/M4 45; M1/M2 90; felony 270; jail days count triple) [O10]; Crim.R. 12(C)-(D)
  pretrial motions within 35 days of arraignment or 7 days before trial; Crim.R. 12.1/12.2
  alibi and self-defence notices; Crim.R. 16 discovery; Crim.R. 29 acquittal; Crim.R. 30
  instructions [O15]; merchant detention R.C. 2935.041 [O13]; sufficiency (State v.
  Jenks, 61 Ohio St.3d 259 (1991), para. two of syllabus, applied in [O18]) versus
  manifest weight (State v. Thompkins, 78 Ohio St.3d 380 (1997)); misdemeanour jail caps
  R.C. 2929.24 (M1 180 days) and fines 2929.28 (M1 $1,000) [O11][O12]; collateral
  consequences inventories [O19][O20].
